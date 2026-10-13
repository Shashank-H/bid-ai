import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { buildApp } from '../../apps/api/src/app.js';
import { createDatabaseClient } from '../../apps/api/src/db/client.js';
import { initializeDatabase } from '../../apps/api/src/db/initialize.js';
import { IdentityRepository } from '../../apps/api/src/db/identity.js';
import { createPostgres, postgresUrl } from '../../apps/api/src/db/postgres.js';
import { ConversationRepository } from '../../apps/api/src/db/conversations.js';
import { initializePostgres } from '../../apps/api/src/commands/postgres-init.js';
import { bootstrapUsers } from '../../apps/api/src/commands/users-bootstrap.js';
import { Authorization } from '../../apps/api/src/auth/authorization.js';
import { issueToken } from '../../apps/api/src/auth/token.js';
import { readAgentSettings, readAuthSettings } from '../../apps/api/src/env.js';
import { AgentService } from '../../apps/api/src/agent/service.js';
import { modelRunner } from '../../apps/api/src/agent/model.js';
import { FencedPostgresSaver } from '../../apps/api/src/agent/checkpointer.js';
import { INSUFFICIENT_EVIDENCE, validateAnswer } from '../../apps/api/src/agent/evidence.js';
import { initialState } from '../../apps/api/src/agent/state.js';
import { VisibleText } from '../../apps/api/src/agent/visible-text.js';
import { initializeTracing } from '../../apps/api/src/observability/tracing.js';
import { dispatchTool } from '../../apps/api/src/tools/dispatch.js';
import { fixtureMetadata, publisherFixture } from '../../apps/api/src/fixtures/publishers.js';
import { startModelServer } from '../support/model-server.js';

const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const { DeleteTableCommand, ScanCommand, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');
const suite = randomUUID().replaceAll('-', '');
const database = `bid_test_${suite}`;
const prefix = `bid-test-phase1-${suite}`;
const admin = createPostgres(postgresUrl(process.env));
const testUrl = new URL(postgresUrl(process.env));
testUrl.pathname = `/${database}`;
const env = { ...process.env, TABLE_PREFIX: prefix, DATABASE_URL: testUrl.href,
  DEMO_PASSWORD_A: 'isolated-test-password-a', DEMO_PASSWORD_B: 'isolated-test-password-b',
  AUTH_SIGNING_SECRET: 'ISOLATED_TEST_SIGNING_SECRET_32_BYTES_LONG', APP_ORIGIN: 'http://localhost:8080' };
const client = createDatabaseClient({ endpoint: env.DYNAMODB_ENDPOINT ?? 'http://dynamodb:8000', tablePrefix: prefix,
  region: 'local', accessKeyId: 'local', secretAccessKey: 'local' });
const users = new IdentityRepository(client, prefix);
const authorization = new Authorization(users, () => readAuthSettings(env));
const postgres = createPostgres(testUrl.href);
const repository = new ConversationRepository(postgres);
const tracing = initializeTracing({ enabled: false });
let model: Awaited<ReturnType<typeof startModelServer>>;
let service: AgentService;
let app: ReturnType<typeof buildApp>;
let cookieA = '';
let cookieB = '';
let createdDatabase = false;

const headers = (cookie = cookieA) => ({ cookie, origin: env.APP_ORIGIN });
const identityA = () => authorization.resolveUser('demo-user-a', Math.floor(Date.now() / 1000) + 300);

beforeAll(async () => {
  await admin.pool.query(`CREATE DATABASE "${database}"`);
  createdDatabase = true;
  await initializePostgres(env);
  await initializeDatabase(client, prefix);
  expect(await bootstrapUsers(env)).toEqual({ created: 2, unchanged: 0 });
  model = await startModelServer();
  const llm = { ...env, LLM_BASE_URL: model.url, LLM_API_KEY: 'MODEL_KEY_LEAK_SENTINEL', LLM_MODEL: 'deterministic-model' };
  service = new AgentService(repository, authorization, modelRunner(llm, tracing), tracing);
  app = buildApp({ checkReady: () => repository.assertReady() }, false, { authorization, agent: service,
    cancelUser: (userId) => service.cancelUser(userId) });

  for (const letter of ['A', 'B'] as const) {
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: env.APP_ORIGIN },
      payload: { login: `demo.${letter.toLowerCase()}`, password: env[`DEMO_PASSWORD_${letter}`] } });
    expect(login.statusCode).toBe(200);
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    if (letter === 'A') cookieA = cookie;
    else cookieB = cookie;
  }
});

afterAll(async () => {
  await app?.close();
  await service?.shutdown();
  await model?.close();
  await tracing.shutdown();
  await postgres.pool.end();

  if (createdDatabase) {
    if (database !== `bid_test_${suite}`) throw new Error('Test database cleanup ownership failed');
    await admin.pool.query(`DROP DATABASE "${database}"`);
  }
  await admin.pool.end();

  for (const suffix of ['identity', 'publisher-data', 'workflow']) {
    try { await client.send(new DeleteTableCommand({ TableName: `${prefix}-${suffix}` })); }
    catch (error) { if (!(error instanceof Error && error.name === 'ResourceNotFoundException')) throw error; }
  }
  client.destroy();
});

async function createConversation(cookie = cookieA) {
  const response = await app.inject({ method: 'POST', url: '/api/conversations', headers: headers(cookie), payload: {} });
  expect(response.statusCode).toBe(200);

  return response.json() as { id: string };
}

function events(body: string): Array<Record<string, any>> {
  return body.split('\n\n').filter((frame) => frame.startsWith('data: ')).map((frame) => JSON.parse(frame.slice(6)));
}

it('uses real credentials/stateless cookies without adding session rows and preserves copied-token semantics', async () => {
  expect(await bootstrapUsers(env)).toEqual({ created: 0, unchanged: 2 });
  await expect(bootstrapUsers({ ...env, DEMO_PASSWORD_A: 'do-not-replace-existing' })).rejects.toThrow('BOOTSTRAP_CONFLICT');
  const current = await app.inject({ url: '/api/auth/me', headers: headers() });
  expect(current.json()).toEqual({ user: { userId: 'demo-user-a', login: 'demo.a' }, publisherId: 'publisher-a', ...fixtureMetadata('publisher-a') });
  expect(current.body).not.toMatch(/credentialHash|password|tokenHash/);
  const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: headers(), payload: {} });
  expect(logout.headers['set-cookie']).toContain('Max-Age=0');
  expect((await app.inject({ url: '/api/auth/me', headers: headers() })).statusCode).toBe(200);
  const rows = await client.send(new ScanCommand({ TableName: `${prefix}-identity`, ConsistentRead: true }));
  expect(rows.Count).toBe(6);
  expect(rows.Items.every((row: { PK: { S: string } }) => /^(USER|LOGIN)#/.test(row.PK.S))).toBe(true);
});

it('lists only conversations with accepted messages, preserving failed and cancelled turns without empty drafts consuming pages', async () => {
  const auth = await identityA();
  const draft = await createConversation();
  const rejected = await app.inject({ method: 'POST', url: `/api/conversations/${draft.id}/turns`, headers: headers(),
    payload: { requestId: randomUUID(), message: '   ' } });
  expect(rejected.statusCode).toBe(400);
  expect((await app.inject({ url: '/api/conversations', headers: headers() })).json().conversations)
    .not.toContainEqual(expect.objectContaining({ id: draft.id }));

  const accepted = await repository.accept(auth.identity, draft.id, { requestId: randomUUID(), message: 'First saved question' });
  await repository.finish(auth.identity, draft.id, accepted.turn.id, accepted.generation, 'error', '', 'MODEL_FAILED');
  const cancelled = await createConversation();
  const second = await repository.accept(auth.identity, cancelled.id, { requestId: randomUUID(), message: 'Cancelled question' });
  await repository.cancel(auth.identity, cancelled.id, second.turn.id);

  for (let index = 0; index < 21; index++) await createConversation();

  const page = (await app.inject({ url: '/api/conversations', headers: headers() })).json();
  expect(page.conversations).toContainEqual(expect.objectContaining({ id: draft.id, title: 'First saved question' }));
  expect(page.conversations).toContainEqual(expect.objectContaining({ id: cancelled.id, title: 'Cancelled question' }));
  expect(page.nextCursor).toBeNull();

  for (let index = 0; index < 20; index++) {
    const conversation = await createConversation();
    const turn = await repository.accept(auth.identity, conversation.id, { requestId: randomUUID(), message: `Question ${index}` });
    await repository.cancel(auth.identity, conversation.id, turn.turn.id);
  }

  const firstPage = (await app.inject({ url: '/api/conversations', headers: headers() })).json();
  expect(firstPage.conversations).toHaveLength(20);
  expect(firstPage.nextCursor).toBeTruthy();
  const olderPage = (await app.inject({ url: `/api/conversations?cursor=${firstPage.nextCursor}`, headers: headers() })).json();
  expect(olderPage.conversations.map((conversation: { id: string }) => conversation.id).sort()).toEqual([draft.id, cancelled.id].sort());
  expect(olderPage.nextCursor).toBeNull();
  expect((await app.inject({ url: '/api/conversations', headers: headers(cookieB) })).json().conversations).toEqual([]);
});

it('runs actual SDK fragmented multi-tool continuation, validates evidence, reloads history and keeps provider reasoning/secrets private', async () => {
  const conversation = await createConversation();
  const requestId = randomUUID();
  const response = await app.inject({ method: 'POST', url: `/api/conversations/${conversation.id}/turns`, headers: headers(),
    payload: { requestId, message: 'What changed in my performance?' } });
  expect(response.headers['content-type']).toContain('text/event-stream');
  const stream = events(response.body);
  expect(stream.filter((event) => event.type === 'tool-result')).toHaveLength(3);
  expect(stream.at(-1)?.type).toBe('turn-complete');
  expect(response.body).toContain('$63.00 to $50.40');
  expect(response.body).not.toMatch(/PRIVATE_|MODEL_KEY_LEAK_SENTINEL|credentialHash|checkpoint_ns|channel_values/);
  const detail = await app.inject({ url: `/api/conversations/${conversation.id}`, headers: headers() });
  expect(detail.json().turns[0].status).toBe('completed');
  expect(detail.json().turns[0].tools).toHaveLength(3);
  const auth = await identityA();
  const context = await repository.recentContext(auth.identity, conversation.id);
  expect(context.messages.filter((message) => message.role === 'tool')).toHaveLength(3);
  const count = model.requests;
  const duplicate = await app.inject({ method: 'POST', url: `/api/conversations/${conversation.id}/turns`, headers: headers(),
    payload: { requestId, message: 'What changed in my performance?' } });
  expect(duplicate.json().duplicate).toBe(true);
  expect(model.requests).toBe(count);
  await initializePostgres(env);
  expect((await repository.detail(auth.identity, conversation.id)).turns[0]?.status).toBe('completed');
});

it('rejects cross-publisher reads/resume/cancel, forged input and invalid/expired/disabled identities', async () => {
  const conversation = await createConversation(cookieB);
  const missing = await app.inject({ url: `/api/conversations/${randomUUID()}`, headers: headers() });
  const foreign = await app.inject({ url: `/api/conversations/${conversation.id}`, headers: headers() });
  expect(foreign.statusCode).toBe(404);
  expect(foreign.body).toBe(missing.body);
  for (const action of ['resume', 'cancel']) {
    expect((await app.inject({ method: 'POST', url: `/api/conversations/${conversation.id}/turns/${randomUUID()}/${action}`,
      headers: headers(), payload: {} })).statusCode).toBe(404);
  }
  const own = await createConversation();
  expect((await app.inject({ method: 'POST', url: `/api/conversations/${own.id}/turns`, headers: headers(),
    payload: { requestId: randomUUID(), message: 'x', publisherId: 'publisher-b', thread_id: 'foreign' } })).statusCode).toBe(400);
  expect((await app.inject({ url: '/api/auth/me', headers: headers(cookieA + 'tampered') })).statusCode).toBe(401);
  const expired = issueToken('demo-user-a', readAuthSettings(env), Date.now() - 400_000_000);
  expect((await app.inject({ url: '/api/auth/me', headers: headers(`bid_session=${expired}`) })).statusCode).toBe(401);
  await client.send(new UpdateItemCommand({ TableName: `${prefix}-identity`, Key: { PK: { S: 'USER#demo-user-a' }, SK: { S: 'USER' } },
    UpdateExpression: 'SET #data.#disabled = :true', ExpressionAttributeNames: { '#data': 'data', '#disabled': 'disabled' }, ExpressionAttributeValues: { ':true': { BOOL: true } } }));
  expect((await app.inject({ url: '/api/auth/me', headers: headers() })).statusCode).toBe(401);
  await client.send(new UpdateItemCommand({ TableName: `${prefix}-identity`, Key: { PK: { S: 'USER#demo-user-a' }, SK: { S: 'USER' } },
    UpdateExpression: 'SET #data.#disabled = :false', ExpressionAttributeNames: { '#data': 'data', '#disabled': 'disabled' }, ExpressionAttributeValues: { ':false': { BOOL: false } } }));
  expect((await app.inject({ method: 'POST', url: '/api/conversations', headers: { ...headers(), origin: 'https://foreign.invalid' }, payload: {} })).statusCode).toBe(403);
  expect((await app.inject({ method: 'POST', url: '/api/conversations', headers: { ...headers(), 'content-type': 'text/plain' }, payload: '{}' })).statusCode).toBe(415);
});

it('exposes tool errors and rejects fabricated citations rather than completing unvalidated answers', async () => {
  const conversation = await createConversation();
  const response = await app.inject({ method: 'POST', url: `/api/conversations/${conversation.id}/turns`, headers: headers(),
    payload: { requestId: randomUUID(), message: 'mock:unknown mock:fake-citation' } });
  const stream = events(response.body);
  expect(stream.some((event) => event.type === 'tool-error' && event.error.code === 'INVALID_INPUT')).toBe(true);
  expect(stream.at(-1)?.type).toBe('turn-error');
  expect(stream.at(-1)?.error.code).toBe('EVIDENCE_INVALID');
  expect((await app.inject({ url: `/api/conversations/${conversation.id}`, headers: headers() })).json().turns[0].status).toBe('error');
});

it('atomically deduplicates concurrent turns and fences old generations after takeover', async () => {
  const auth = await identityA();
  const conversation = await repository.create(auth.identity);
  const requestId = randomUUID();
  const pair = await Promise.all([repository.accept(auth.identity, conversation.id, { requestId, message: 'x' }),
    repository.accept(auth.identity, conversation.id, { requestId, message: 'x' })]);
  expect(pair.filter((entry) => entry.duplicate)).toHaveLength(1);
  const old = pair.find((entry) => !entry.duplicate)!;
  await expect(repository.accept(auth.identity, conversation.id, { requestId: randomUUID(), message: 'y' })).rejects.toMatchObject({ status: 409 });
  await postgres.pool.query('UPDATE conversations SET lease_expires_at = to_timestamp(0) WHERE id = $1', [conversation.id]);
  const resumed = await repository.accept(auth.identity, conversation.id, { resumeId: old.turn.id });
  expect(resumed.generation).toBe(old.generation + 1);
  const saver = new FencedPostgresSaver(postgres.pool, (operation) => repository.withFence(auth.identity, conversation.id, old.turn.id, old.generation, operation));
  await expect(saver.putWrites({ configurable: { thread_id: old.conversation.threadId } }, [], 'stale')).rejects.toMatchObject({ status: 409 });
  for (let i = 0; i < 6; i++) await repository.reserveAttempt(auth.identity, conversation.id, old.turn.id, resumed.generation, 'model');
  await expect(repository.reserveAttempt(auth.identity, conversation.id, old.turn.id, resumed.generation, 'model')).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
  await repository.cancel(auth.identity, conversation.id, old.turn.id);
});

it('saves cancelled partials, resumes disconnects safely and recovers terminal projection gaps without model reruns', async () => {
  const auth = await identityA();
  let started: (() => void) | undefined;
  let stalled = true;
  let calls = 0;
  const controlled = new AgentService(repository, authorization, async (_state, signal, emit) => {
    calls++;
    emit('Partial visible text');
    started?.();
    if (stalled) await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));

    return { message: { role: 'assistant', content: INSUFFICIENT_EVIDENCE }, text: INSUFFICIENT_EVIDENCE, calls: [] };
  }, tracing, readAgentSettings({ AGENT_DEADLINE_MS: '2000' }));

  try {
    const conversation = await repository.create(auth.identity);
    const accepted = await controlled.prepare(auth, conversation.id, { requestId: randomUUID(), message: 'x' });
    let wait = new Promise<void>((resolve) => { started = resolve; });
    let run = controlled.run(auth, accepted, false, new AbortController(), () => {});
    await wait;
    await controlled.cancel(auth.identity, conversation.id, accepted.turn.id);
    await run;
    expect((await repository.detail(auth.identity, conversation.id)).turns[0]).toMatchObject({ status: 'cancelled', text: 'Partial visible text' });
    await expect(controlled.prepare(auth, conversation.id, { resumeId: accepted.turn.id })).rejects.toMatchObject({ status: 409 });

    const second = await repository.create(auth.identity);
    const interrupted = await controlled.prepare(auth, second.id, { requestId: randomUUID(), message: 'x' });
    const controller = new AbortController();
    wait = new Promise<void>((resolve) => { started = resolve; });
    run = controlled.run(auth, interrupted, false, controller, () => {});
    await wait;
    controller.abort('DISCONNECT');
    await run;
    expect((await repository.detail(auth.identity, second.id)).turns[0]?.status).toBe('interrupted');
    stalled = false;
    const resumed = await controlled.prepare(auth, second.id, { resumeId: interrupted.turn.id });
    await controlled.run(auth, resumed, true, new AbortController(), () => {});
    expect((await repository.detail(auth.identity, second.id)).turns[0]?.status).toBe('completed');

    const third = await repository.create(auth.identity);
    const terminal = await controlled.prepare(auth, third.id, { requestId: randomUUID(), message: 'x' });
    const original = repository.finish.bind(repository);
    let fail = true;
    const spy = vi.spyOn(repository, 'finish').mockImplementation(async (...args) => {
      if (args[4] === 'completed' && fail) { fail = false; throw new Error('projection-write-failure'); }
      return original(...args);
    });
    await controlled.run(auth, terminal, false, new AbortController(), () => {});
    const count = calls;
    const recovery = await controlled.prepare(auth, third.id, { resumeId: terminal.turn.id });
    await controlled.run(auth, recovery, true, new AbortController(), () => {});
    expect(calls).toBe(count);
    expect((await repository.detail(auth.identity, third.id)).turns[0]?.status).toBe('completed');
    spy.mockRestore();
  } finally {
    await controlled.shutdown();
  }
});

it('enforces consistent fixture metrics, empty periods, strict tool boundaries and fragment-safe reasoning/citation limits', async () => {
  for (const publisher of ['publisher-a', 'publisher-b']) {
    const data = publisherFixture(publisher);
    for (const daily of data.daily) {
      const bidder = data.bidders.filter((entry) => entry.date === daily.date);
      expect(bidder.reduce((sum, entry) => sum + entry.wins, 0)).toBe(daily.filledOpportunities);
      expect(bidder.reduce((sum, entry) => sum + entry.estimatedRevenue, 0)).toBeCloseTo(daily.estimatedRevenue);
      expect(daily.estimatedRevenue).toBe(daily.winningCpmTotal / 1000);
    }
  }
  const auth = await identityA();
  const context = { identity: auth.identity, signal: new AbortController().signal, correlationId: 'invariants' };
  const result = await dispatchTool('performance_summary', '{"startDate":"2025-01-01","endDate":"2025-01-01"}', context);
  expect(result.data).toMatchObject({ metrics: { fillRate: null, averageWinningCpm: null, availableDays: 0 } });
  for (const args of ['{"publisherId":"publisher-b"}', ' '.repeat(16_385), '{invalid']) {
    await expect(dispatchTool('current_configuration', args, context)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  }
  for (let size = 1; size < 15; size++) {
    const filter = new VisibleText();
    const raw = '<think>PRIVATE<analysis>NESTED</analysis></think>public';
    let visible = '';
    for (let offset = 0; offset < raw.length; offset += size) visible += filter.push(raw.slice(offset, offset + size));
    expect(visible + filter.finish()).toBe('public');
  }
  const state = initialState('t', []);
  expect(() => validateAnswer({ ...state, answer: 'Revenue fell 20%.' })).toThrow('no supporting observations');
  validateAnswer({ ...state, answer: INSUFFICIENT_EVIDENCE });

  const configuration = await dispatchTool('current_configuration', '{}', context);
  const id = configuration.evidence[0]!.evidenceId;
  const answer = `Observation: Demo configuration [${id}].\nHypothesis: The effect is uncertain.\nRecommendation: Investigate before changing anything.`;
  validateAnswer({ ...state, evidence: configuration.evidence, answer });
  validateAnswer({ ...state, evidence: configuration.evidence, answer: answer.replace(`[${id}]`, `[${id}, ${id}]`) });
  expect(() => validateAnswer({ ...state, evidence: configuration.evidence, answer: answer.replace(`[${id}]`, `[${id}, invented]`) })).toThrow('missing or unknown evidence');
  expect(() => validateAnswer({ ...state, evidence: configuration.evidence, answer: answer.replace(`[${id}]`, '') })).toThrow('missing or unknown evidence');
  expect(() => validateAnswer({ ...state, evidence: configuration.evidence, answer: answer.replace(`[${id}]`, '[invented]') })).toThrow('missing or unknown evidence');

  const runner = modelRunner({ ...env, LLM_BASE_URL: model.url, LLM_MODEL: 'fake', LLM_API_KEY: 'private' }, tracing);
  await expect(runner(initialState('t', [{ role: 'user', content: 'x'.repeat(131_073) }]), context.signal, () => {})).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
});
