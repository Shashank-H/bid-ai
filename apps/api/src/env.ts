import { z } from 'zod';
import { localEndpoint, TablePrefixSchema } from './db/client.js';
import type { DatabaseSettings } from './db/client.js';
import type { AuthSettings } from './auth/token.js';

export class ConfigurationError extends Error {
  constructor() {
    super('INVALID_CONFIGURATION: check the documented environment settings');

    this.name = 'ConfigurationError';
  }
}

function safeRead<T>(read: () => T): T {
  try {
    return read();
  } catch {
    throw new ConfigurationError();
  }
}

export function databaseSettingsFromEnvironment(env: NodeJS.ProcessEnv): DatabaseSettings {
  return safeRead(() => ({
    endpoint: localEndpoint(env['DYNAMODB_ENDPOINT'] ?? 'http://dynamodb:8000'),
    tablePrefix: TablePrefixSchema.parse(env['TABLE_PREFIX'] ?? 'bid'),
    region: z.string().min(1).max(64).parse(env['AWS_REGION'] ?? 'local'),
    accessKeyId: z.string().min(1).max(256).parse(env['AWS_ACCESS_KEY_ID'] ?? 'local'),
    secretAccessKey: z.string().min(1).max(256).parse(env['AWS_SECRET_ACCESS_KEY'] ?? 'local'),
  }));
}

const RuntimeSchema = z.object({
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  WEB_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  REPOSITORY_MODE: z.enum(['fixture', 'database']).default('fixture'),
  SESSION_COOKIE_NAME: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/).default('bid_session'),
  SESSION_LIFETIME_SECONDS: z.coerce.number().int().min(60).max(604800).default(28800),
  SESSION_COOKIE_SECURE: z.enum(['true', 'false']).default('false'),
});

/** LLM settings are intentionally not read here: foundation startup is model-independent. */
export function readEnvironment(env: NodeJS.ProcessEnv = process.env) {
  return safeRead(() => {
    const values = RuntimeSchema.parse(env);

    return {
      database: databaseSettingsFromEnvironment(env),
      repositoryMode: values.REPOSITORY_MODE,
      hostPorts: { api: values.API_PORT, web: values.WEB_PORT },
      session: {
        cookieName: values.SESSION_COOKIE_NAME,
        lifetimeSeconds: values.SESSION_LIFETIME_SECONDS,
        secure: values.SESSION_COOKIE_SECURE === 'true'
      },
    };
  });
}

/** Explicit values override the stable local-demo signing default. */
export function readAuthSettings(env: NodeJS.ProcessEnv = process.env): AuthSettings {
  return safeRead(() => {
    const runtime = readEnvironment(env);
    const secret = z.string().min(32).max(1024).parse(env['AUTH_SIGNING_SECRET']);
    const origin = z.string().url().parse(env['APP_ORIGIN'] ?? `http://localhost:${runtime.hostPorts.web}`);
    const url = new URL(origin);

    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.origin !== origin || Buffer.byteLength(secret) < 32) throw new Error('Invalid auth configuration');

    return { ...runtime.session, secret, origin };
  });
}

export type TracingSettings = { enabled: false } | {
  enabled: true;
  baseURL: string;
  publicKey: string;
  secretKey: string;
  environment: string;
  timeoutMs: number;
};

/** Export is opt-in; disabled tracing never initializes an SDK or contacts a service. */
export function readTracingSettings(env: NodeJS.ProcessEnv = process.env): TracingSettings {
  return safeRead(() => {
    const enabled = z.enum(['true', 'false']).parse(env['LANGFUSE_TRACING_ENABLED'] ?? 'false');

    if (enabled === 'false') return { enabled: false };

    const values = z.object({
      LANGFUSE_BASE_URL: z.string().url().max(2048),
      LANGFUSE_PUBLIC_KEY: z.string().trim().min(1).max(4096),
      LANGFUSE_SECRET_KEY: z.string().trim().min(1).max(4096),
      LANGFUSE_TRACING_ENVIRONMENT: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/).default('development'),
      LANGFUSE_TIMEOUT_MS: z.coerce.number().int().min(100).max(10000).default(2000),
    }).parse(env);
    const url = new URL(values.LANGFUSE_BASE_URL);

    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('Invalid tracing URL');
    }

    return {
      enabled: true,
      baseURL: url.href.replace(/\/$/, ''),
      publicKey: values.LANGFUSE_PUBLIC_KEY,
      secretKey: values.LANGFUSE_SECRET_KEY,
      environment: values.LANGFUSE_TRACING_ENVIRONMENT,
      timeoutMs: values.LANGFUSE_TIMEOUT_MS,
    };
  });
}

export function readAgentSettings(env: NodeJS.ProcessEnv = process.env) {
  return safeRead(() => {
    const values = z.object({
      AGENT_DEADLINE_MS: z.coerce.number().int().min(1000).max(110000).default(110000),
      AGENT_MAX_COMPLETION_TOKENS: z.coerce.number().int().min(64).max(8192).default(4096),
    }).parse(env);

    return { deadlineMs: values.AGENT_DEADLINE_MS, maxCompletionTokens: values.AGENT_MAX_COMPLETION_TOKENS };
  });
}

export interface ModelSettings {
  baseURL: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high';
  temperature?: number;
  maxCompletionTokens?: number;
  maxOutputBytes?: number;
}

/** Provider-neutral settings: Llama-compatible and OpenAI endpoints share this path. */
export function readModelSettings(env: NodeJS.ProcessEnv = process.env): ModelSettings {
  return safeRead(() => {
    const values = z.object({
      LLM_BASE_URL: z.string().url().max(2048),
      LLM_API_KEY: z.string().min(1).max(4096),
      LLM_MODEL: z.string().trim().min(1).max(256),
      LLM_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(110000),
      LLM_REASONING_EFFORT: z.enum(['none', 'minimal', 'low', 'medium', 'high']).optional(),
      LLM_TEMPERATURE: z.coerce.number().min(0).max(2).optional(),
      LLM_PROBE_MAX_TOKENS: z.preprocess((value) => value === '' ? undefined : value,
        z.coerce.number().int().min(64).max(1024).optional()),
      LLM_PROBE_MAX_OUTPUT_BYTES: z.preprocess((value) => value === '' ? undefined : value,
        z.coerce.number().int().min(2048).max(1048576).optional()),
    }).parse(env);

    const url = new URL(values.LLM_BASE_URL);

    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('Invalid model URL');
    }

    return {
      baseURL: url.href.replace(/\/$/, ''),
      apiKey: values.LLM_API_KEY,
      model: values.LLM_MODEL,
      timeoutMs: values.LLM_TIMEOUT_MS,
      ...(values.LLM_REASONING_EFFORT === undefined ? {} : { reasoningEffort: values.LLM_REASONING_EFFORT }),
      ...(values.LLM_TEMPERATURE === undefined ? {} : { temperature: values.LLM_TEMPERATURE }),
      ...(values.LLM_PROBE_MAX_TOKENS === undefined ? {} : { maxCompletionTokens: values.LLM_PROBE_MAX_TOKENS }),
      ...(values.LLM_PROBE_MAX_OUTPUT_BYTES === undefined ? {} : { maxOutputBytes: values.LLM_PROBE_MAX_OUTPUT_BYTES }),
    };
  });
}
