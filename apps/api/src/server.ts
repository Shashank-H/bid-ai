import { buildApp } from './app.js';
import { readEnvironment, readTracingSettings } from './env.js';
import type { TracingRuntime } from './observability/tracing.js';
import { createDatabaseClient } from './db/client.js';
import { databaseReady } from './db/readiness.js';

let tracing: TracingRuntime | undefined;

try {
  const { database: settings } = readEnvironment(process.env);
  const tracingSettings = readTracingSettings(process.env);
  const { initializeTracing } = await import('./observability/tracing.js');
  tracing = initializeTracing(tracingSettings, { secrets: [process.env['LLM_API_KEY'] ?? ''] });
  const client = createDatabaseClient(settings);
  const app = buildApp({ checkReady: () => databaseReady(client, settings.tablePrefix) }, true);

  app.addHook('onClose', async () => {
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
} catch {
  await tracing?.shutdown();
  console.error('STARTUP_FAILED: check local database/tracing settings and port availability');
  process.exitCode = 1;
}
