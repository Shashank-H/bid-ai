import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { buildApp } from '../../apps/api/dist/app.js';
import { createDatabaseClient } from '../../apps/api/dist/db/client.js';
import { initializeDatabase } from '../../apps/api/dist/db/initialize.js';
import { createPostgres, postgresUrl } from '../../apps/api/dist/db/postgres.js';
import { IdentityRepository } from '../../apps/api/dist/db/identity.js';
import { ConversationRepository } from '../../apps/api/dist/db/conversations.js';
import { bootstrapUsers } from '../../apps/api/dist/commands/users-bootstrap.js';
import { initializePostgres } from '../../apps/api/dist/commands/postgres-init.js';
import { readAuthSettings } from '../../apps/api/dist/env.js';
import { Authorization } from '../../apps/api/dist/auth/authorization.js';
import { AgentService } from '../../apps/api/dist/agent/service.js';
import { modelRunner } from '../../apps/api/dist/agent/model.js';
import { initializeTracing } from '../../apps/api/dist/observability/tracing.js';
import { startModelServer } from './model-server.ts';

const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const { DeleteTableCommand } = require('@aws-sdk/client-dynamodb');
const suite = randomUUID().replaceAll('-', '');
const database = `bid_test_e2e_${suite}`;
const prefix = `bid-test-e2e-${suite}`;
const admin = createPostgres(postgresUrl(process.env));
const url = new URL(postgresUrl(process.env));
url.pathname = `/${database}`;
const env = { ...process.env, TABLE_PREFIX: prefix, DATABASE_URL: url.href,
  AUTH_SIGNING_SECRET: 'TEST_ONLY_E2E_SIGNING_SECRET_NOT_FOR_REAL_ACCOUNTS',
  APP_ORIGIN: process.env.APP_ORIGIN || 'http://agent-test-web',
  DEMO_PASSWORD_A: 'isolated-browser-password-a', DEMO_PASSWORD_B: 'isolated-browser-password-b' };
const client = createDatabaseClient({ endpoint: env.DYNAMODB_ENDPOINT || 'http://dynamodb:8000', tablePrefix: prefix,
  region: 'local', accessKeyId: 'local', secretAccessKey: 'local' });
const tracing = initializeTracing({ enabled: false });

await admin.pool.query(`CREATE DATABASE "${database}"`);
await initializeDatabase(client, prefix);
await initializePostgres(env);
await bootstrapUsers(env);

const postgres = createPostgres(url.href);
const conversations = new ConversationRepository(postgres);
const model = await startModelServer();
const authorization = new Authorization(new IdentityRepository(client, prefix), () => readAuthSettings(env));
const service = new AgentService(conversations, authorization, modelRunner({ ...env,
  LLM_BASE_URL: model.url, LLM_API_KEY: 'BROWSER_MODEL_KEY_SENTINEL', LLM_MODEL: 'e2e-model' }, tracing), tracing);
const app = buildApp({ checkReady: () => conversations.assertReady() }, false, { authorization, agent: service,
  cancelUser: (userId: string) => service.cancelUser(userId) });
let closing = false;

async function close() {
  if (closing) return;
  closing = true;
  await app.close();
  await service.shutdown();
  await model.close();
  await tracing.shutdown();
  await postgres.pool.end();

  if (database !== `bid_test_e2e_${suite}` || prefix !== `bid-test-e2e-${suite}`) throw new Error('E2E cleanup ownership failed');
  await admin.pool.query(`DROP DATABASE "${database}"`);
  await admin.pool.end();
  for (const suffix of ['identity', 'publisher-data', 'workflow']) await client.send(new DeleteTableCommand({ TableName: `${prefix}-${suffix}` }));
  client.destroy();
  process.exitCode = 0;
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { void close(); });
await app.listen({ host: '0.0.0.0', port: 3000 });
console.log('ISOLATED_E2E_READY');
