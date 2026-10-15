import { expect, it } from 'vitest';
import { runCli } from './cli.js';

async function call(args: string[], env: NodeJS.ProcessEnv = {}) {
  const output: string[] = [];
  const code = await runCli(args, env, (message) => output.push(message));

  return { code, text: output.join('\n') };
}
it('prints command help without needing configuration and rejects unknown commands', async () => {
  expect((await call(['--help'])).code).toBe(0);
  expect((await call(['model:probe', '--help'])).text).toContain('streaming');
  expect((await call(['unknown', '--help'])).code).toBe(2);
  expect((await call(['data:seed'])).code).toBe(2);
  expect((await call(['db:verify', '--unknown', 'bad'])).text).toContain('INVALID_ARGUMENTS');
});

it('keeps generation isolated and validates reconciliation arguments before database access', async () => {
  expect((await call(['data:generate', '--help'])).code).toBe(0);
  expect((await call(['data:reconcile', '--help'])).code).toBe(0);
  expect((await call(['data:reconcile', '--seed', '123'])).text).toContain('INVALID_ARGUMENTS');

  const generation = await call(['data:generate']);

  expect(generation.code).toBe(1);
  expect(generation.text).toContain('data-generator');
  expect(generation.text).not.toContain('NOT_IMPLEMENTED');
});

it('rejects destructive or invalid configuration before any database request', async () => {
  expect((await call(['db:reset'])).text).toContain('RESET_REFUSED');
  expect((await call(['db:init'], { REPOSITORY_MODE: 'invalid-secret-sentinel' })).text).toContain(
    'INVALID_CONFIGURATION',
  );

  const result = await call(['db:init'], {
    DYNAMODB_ENDPOINT: 'http://secret-sentinel@remote.example',
    LLM_API_KEY: 'private-key-sentinel',
  });

  expect(result.code).toBe(1);
  expect(result.text).not.toContain('sentinel');
});

it('refuses explicitly invalid demo passwords before accessing the database', async () => {
  const result = await call(['users:bootstrap'], { DEMO_PASSWORD_A: 'short' });

  expect(result.code).toBe(1);
  expect(result.text).not.toContain('NOT_IMPLEMENTED');
  expect(result.text).not.toContain('DEMO_PASSWORD');
});

it('rejects an explicitly invalid model endpoint before probing', async () => {
  const result = await call(['model:probe'], { LLM_BASE_URL: 'not-an-endpoint' });

  expect(result.code).toBe(1);
  expect(result.text).toContain('INVALID_CONFIGURATION');
});
