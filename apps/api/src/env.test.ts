import { expect, it } from 'vitest';
import { readAuthSettings, readEnvironment, readModelSettings } from './env.js';

it('keeps server startup independent from model validation', () => {
  expect(readEnvironment({}).repositoryMode).toBe('fixture');
  expect(
    readEnvironment({ LLM_BASE_URL: 'not-an-endpoint', LLM_API_KEY: 'secret' }).session.secure,
  ).toBe(false);
  expect(() => readModelSettings({})).toThrow('INVALID_CONFIGURATION');
  expect(() => readAuthSettings({})).toThrow('INVALID_CONFIGURATION');
  expect(readAuthSettings({ AUTH_SIGNING_SECRET: 'private-override-'.repeat(3) }).secret).toBe(
    'private-override-'.repeat(3),
  );
});

it('validates mode, port and session ranges without returning environment values in errors', () => {
  for (const env of [
    { REPOSITORY_MODE: 'hidden' },
    { WEB_PORT: '0' },
    { API_PORT: '70000' },
    { SESSION_LIFETIME_SECONDS: '-1' },
    { SESSION_COOKIE_SECURE: 'yes' },
    { SESSION_COOKIE_NAME: 'bad cookie' },
    { DYNAMODB_ENDPOINT: 'https://private-secret.example' },
    { TABLE_PREFIX: 'foreign' },
  ]) {
    expect(() => readEnvironment(env)).toThrow('INVALID_CONFIGURATION');
  }

  expect(
    readEnvironment({ REPOSITORY_MODE: 'database', SESSION_COOKIE_SECURE: 'true' }).session.secure,
  ).toBe(true);
});

it('accepts provider-neutral overrides but rejects unsafe URLs and invalid budgets', () => {
  const env = {
    LLM_BASE_URL: 'http://localhost:8081/v1',
    LLM_API_KEY: 'local-placeholder',
    LLM_MODEL: 'llama-demo',
  };

  // Do not send optional sampling/reasoning parameters unless explicitly configured.
  expect(readModelSettings(env)).toEqual({
    baseURL: env.LLM_BASE_URL,
    apiKey: env.LLM_API_KEY,
    model: env.LLM_MODEL,
    timeoutMs: 110000,
  });
  expect(
    readModelSettings({ ...env, LLM_REASONING_EFFORT: 'none', LLM_TEMPERATURE: '0' }),
  ).toMatchObject({ reasoningEffort: 'none', temperature: 0 });
  expect(
    readModelSettings({
      ...env,
      LLM_BASE_URL: 'https://api.openai.com/v1',
      LLM_MODEL: 'future-openai-model',
    }).baseURL,
  ).toBe('https://api.openai.com/v1');
  expect(
    readModelSettings({
      ...env,
      LLM_PROBE_MAX_TOKENS: '512',
      LLM_PROBE_MAX_OUTPUT_BYTES: '262144',
    }),
  ).toMatchObject({ maxCompletionTokens: 512, maxOutputBytes: 262144 });
  expect(
    readModelSettings({ ...env, LLM_PROBE_MAX_TOKENS: '', LLM_PROBE_MAX_OUTPUT_BYTES: '' }),
  ).toEqual(readModelSettings(env));

  expect(
    readModelSettings({ ...env, LLM_REASONING_EFFORT: 'low', LLM_TEMPERATURE: '0.5' }),
  ).toMatchObject({ reasoningEffort: 'low', temperature: 0.5 });

  for (const change of [
    { LLM_TIMEOUT_MS: '0' },
    { LLM_REASONING_EFFORT: 'invalid' },
    { LLM_TEMPERATURE: '3' },
    { LLM_BASE_URL: 'http://user:private-secret@localhost/v1' },
    { LLM_BASE_URL: 'https://example.test/v1?token=secret' },
    { LLM_PROBE_MAX_TOKENS: '1025' },
    { LLM_PROBE_MAX_OUTPUT_BYTES: '1048577' },
  ]) {
    expect(() => readModelSettings({ ...env, ...change })).toThrow('INVALID_CONFIGURATION');
  }
});
