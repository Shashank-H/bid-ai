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
  expect((await call(['db:verify', '--unknown', 'bad'])).text).toContain('INVALID_ARGUMENTS');
});

it('future commands fail visibly with the correct owning phase and never write data', async () => {
  for (const [command, phase] of [['users:bootstrap', 1], ['data:seed', 2], ['data:reconcile', 2], ['data:generate', 3]] as const) {
    const result = await call([command]);

    expect(result.code).toBe(1);
    expect(result.text).toContain(`NOT_IMPLEMENTED: ${command} belongs to Phase ${phase}`);
    expect(result.text).toContain('no data was written');
    expect((await call([command, '--help'])).code).toBe(0);
    expect((await call([command, '--seed', '123'])).text).toContain('INVALID_ARGUMENTS');
  }
});

it('rejects destructive or invalid configuration before any database request', async () => {
  expect((await call(['db:reset'])).text).toContain('RESET_REFUSED');
  expect((await call(['db:init'], { REPOSITORY_MODE: 'invalid-secret-sentinel' })).text).toContain('INVALID_CONFIGURATION');

  const result = await call(['db:init'], { DYNAMODB_ENDPOINT: 'http://secret-sentinel@remote.example', LLM_API_KEY: 'private-key-sentinel' });

  expect(result.code).toBe(1);
  expect(result.text).not.toContain('sentinel');
});

it('requires private model settings only for the explicit probe command', async () => {
  const result = await call(['model:probe']);

  expect(result.code).toBe(1);
  expect(result.text).toContain('INVALID_CONFIGURATION');
});
