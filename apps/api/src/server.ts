import { buildApp } from './app.js';
import { readEnvironment, readTracingSettings, readAuthSettings } from './env.js';
import type { TracingRuntime } from './observability/tracing.js';
import { createDatabaseClient } from './db/client.js';
import { databaseReady } from './db/readiness.js';
import { IdentityRepository } from './db/identity.js';
import { Authorization } from './auth/authorization.js';
import { createPostgres, postgresUrl } from './db/postgres.js';
import { ConversationRepository } from './db/conversations.js';
import { AgentService } from './agent/service.js';
import { reportFailure } from './observability/diagnostics.js';
import { createRuntimeData } from './domain/runtime-data.js';

let tracing: TracingRuntime | undefined;

try {
  const { database: settings, repositoryMode } = readEnvironment(process.env);
  const tracingSettings = readTracingSettings(process.env);
  const { initializeTracing } = await import('./observability/tracing.js');
  tracing = initializeTracing(tracingSettings, { secrets: [process.env['LLM_API_KEY'] ?? ''] });
  const client = createDatabaseClient(settings);
  const authorization = new Authorization(
    new IdentityRepository(client, settings.tablePrefix),
    () => readAuthSettings(process.env),
  );
  const runtimeData = createRuntimeData(repositoryMode, client, settings.tablePrefix);
  const postgres = createPostgres(postgresUrl(process.env));
  const conversations = new ConversationRepository(postgres);
  const { modelRunner } = await import('./agent/model.js');
  const agent = new AgentService(
    conversations,
    authorization,
    modelRunner(process.env, tracing),
    tracing,
    undefined,
    runtimeData,
  );
  const app = buildApp(
    {
      checkReady: async () =>
        (await databaseReady(client, settings.tablePrefix)) && (await conversations.assertReady()),
    },
    true,
    {
      authorization,
      agent,
      getMetadata: runtimeData.getMetadata,
      dashboard: runtimeData.dashboard,
      cancelUser: (userId) => agent.cancelUser(userId),
    },
  );

  app.addHook('onClose', async () => {
    await agent.shutdown();
    await postgres.pool.end();
    client.destroy();
    await tracing?.shutdown();
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void app.close().then(() => {
        process.exitCode = 0;
      });
    });
  }

  await app.listen({ host: '0.0.0.0', port: 3000 });
} catch (cause) {
  reportFailure('startup_failed', {}, cause, [
    process.env['LLM_API_KEY'] ?? '',
    process.env['LANGFUSE_SECRET_KEY'] ?? '',
  ]);
  await tracing?.shutdown();
  console.error('STARTUP_FAILED: check application logs for diagnostic details');
  process.exitCode = 1;
}
