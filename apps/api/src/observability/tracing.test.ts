import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import OpenAI from 'openai';
import { trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { SpanExporter, ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { initializeTracing, maskTraceData } from './tracing.js';
import type { TracingRuntime } from './tracing.js';
import { ConfigurationError, readTracingSettings } from '../env.js';
import { runModelProbe } from '../commands/model-probe.js';
import { HttpError } from '../errors.js';
import { modelRunner } from '../agent/model.js';
import { initialState } from '../agent/state.js';

type WireSpan = {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  attributes: Array<{ key: string; value: { stringValue?: string; intValue?: string; boolValue?: boolean } }>;
  events?: unknown[];
};

type ExportBody = { resourceSpans: Array<{ scopeSpans: Array<{ spans: WireSpan[] }> }> };

const secret = 'private-model-sentinel';
const publicKey = 'pk-lf-test-sentinel';
const secretKey = 'sk-lf-test-sentinel';
const collected: ExportBody[] = [];
const options = { baseURL: 'http://llama.invalid/v1', apiKey: secret, model: 'llama-demo' };

function attribute(span: WireSpan, key: string) {
  return span.attributes.find((entry) => entry.key === key)?.value.stringValue;
}

function allSpans() {
  return collected.flatMap((body) => body.resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans)));
}

function chunk(delta: Record<string, unknown>, finish: string | null = null) {
  return { id: 'chat-test', object: 'chat.completion.chunk', created: 1, model: options.model,
    choices: [{ index: 0, delta, finish_reason: finish }] };
}

function sse(chunks: unknown[]) {
  return new Response(chunks.map((value) => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  });
}

function scriptedFetch(withUsage = true): typeof fetch {
  let step = 0;

  return async (_request, init) => {
    const body = JSON.parse(String(init?.body)) as { stream_options?: unknown; messages?: unknown[] };
    expect(body.stream_options).toEqual({ include_usage: true });

    const usage = withUsage ? [{ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }] : [];

    if (++step === 2) {
      return sse([
        chunk({ tool_calls: [{ index: 0, id: 'call_echo', type: 'function', function: { name: 'probe_echo', arguments: '{"message":"compatibility check"}' } }] }),
        chunk({}, 'tool_calls'), ...usage,
      ]);
    }

    return sse([
      chunk({ content: `streaming works ${secret} somebody@example.test`, reasoning_content: 'private chain of thought' }),
      chunk({}, 'stop'), ...usage,
    ]);
  };
}

it('keeps tracing explicitly opt-in and validates enabled configuration without leaking values', async () => {
  const settings = readTracingSettings({ LANGFUSE_SECRET_KEY: 'ignored-while-disabled' });
  const disabled = initializeTracing(settings);

  expect(disabled.enabled).toBe(false);
  await expect(disabled.probe(async () => 'untraced')).resolves.toBe('untraced');
  await disabled.shutdown();

  expect(() => readTracingSettings({ LANGFUSE_TRACING_ENABLED: 'yes' })).toThrow(ConfigurationError);
  expect(() => readTracingSettings({ LANGFUSE_TRACING_ENABLED: 'true' })).toThrow(ConfigurationError);

  for (const change of [{ LANGFUSE_BASE_URL: 'https://user:secret@example.test' },
    { LANGFUSE_BASE_URL: 'https://example.test?token=secret' }, { LANGFUSE_TIMEOUT_MS: '0' },
    { LANGFUSE_TRACING_ENVIRONMENT: 'contains space' }, { LANGFUSE_SECRET_KEY: ' ' }]) {
    expect(() => readTracingSettings({ LANGFUSE_TRACING_ENABLED: 'true', LANGFUSE_BASE_URL: 'https://example.test',
      LANGFUSE_PUBLIC_KEY: publicKey, LANGFUSE_SECRET_KEY: secretKey, ...change })).toThrow('INVALID_CONFIGURATION');
  }
});

it('masks nested credentials, private reasoning, JSON tool arguments and configured secrets', () => {
  const masked = maskTraceData({
    credentialHash: secret,
    messages: [{ content: `hello ${secret} person@example.test`, reasoning_content: 'private chain' }],
    arguments: JSON.stringify({ password: 'private', reasoning: 'private', message: 'safe' }),
    text: 'before<think>inline-private</think>after',
    unterminated: 'before<think>unfinished-private',
  }, [secret]);
  const text = JSON.stringify(masked);

  expect(text).not.toContain(secret);
  expect(text).not.toContain('person@example.test');
  expect(text).not.toContain('private chain');
  expect(text).not.toContain('inline-private');
  expect(text).not.toContain('unfinished-private');
  expect(text).toContain('safe');
  expect(text).toContain('[REDACTED]');
});

it('retains reasoning effort, token counts and sampling settings while masking private reasoning', () => {
  const masked = maskTraceData({ reasoningEffort: 'none', reasoning_effort: 'low', temperature: 0.2,
    usage: { completion_tokens_details: { reasoning_tokens: 42 } }, reasoning_content: 'private chain',
    thinking: 'private chain', analysis: 'private chain' });

  expect(masked).toMatchObject({ reasoningEffort: 'none', reasoning_effort: 'low', temperature: 0.2,
    usage: { completion_tokens_details: { reasoning_tokens: 42 } }, reasoning_content: '[REDACTED]',
    thinking: '[REDACTED]', analysis: '[REDACTED]' });
  expect(maskTraceData({ reasoning_effort: 'private chain', reasoning_tokens: 'private chain' }))
    .toEqual({ reasoning_effort: '[REDACTED]', reasoning_tokens: '[REDACTED]' });
});

it('fails closed for tracing when another provider owns global export', async () => {
  const exporter = new InMemorySpanExporter();
  const external = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  expect(trace.setGlobalTracerProvider(external)).toBe(true);
  const registered = trace.getTracerProvider();

  try {
    const tracing = initializeTracing({ enabled: true, baseURL: 'http://unused.invalid', publicKey, secretKey,
      environment: 'test', timeoutMs: 200 });

    expect(tracing.enabled).toBe(false);
    await expect(runModelProbe({ ...options, tracing, fetch: scriptedFetch() })).resolves.toMatchObject({ compatible: true });
    await tracing.shutdown();

    expect(trace.getTracerProvider()).toBe(registered);
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  } finally {
    trace.disable();
    await external.shutdown();
  }
});

it('cleans up owned globals so a sequential runtime exports to its own processor', async () => {
  const spans: ReadableSpan[] = [];
  const exporter: SpanExporter = {
    export: (batch, callback) => { spans.push(...batch); callback({ code: 0 }); },
    shutdown: async () => {},
  };

  for (let i = 0; i < 2; i++) {
    const runtime = initializeTracing({ enabled: true, baseURL: 'http://unused.invalid', publicKey, secretKey,
      environment: 'test', timeoutMs: 200 }, { exporter, secrets: [secret] });
    expect(runtime.enabled).toBe(true);
    await runModelProbe({ ...options, tracing: runtime, fetch: scriptedFetch() });
    await runtime.shutdown();
  }

  expect(spans).toHaveLength(10);
  expect(new Set(spans.map((span) => span.spanContext().traceId)).size).toBe(2);
});

describe('actual Langfuse OTLP export', () => {
  let server: Server;
  let tracing: TracingRuntime;
  let url: string;
  let responseStatus = 200;
  let trickleResponse = false;

  beforeAll(async () => {
    server = createServer(async (request, response) => {
      if (request.url !== '/api/public/otel/v1/traces') {
        response.writeHead(404).end();

        return;
      }

      const chunks: Buffer[] = [];

      for await (const part of request) chunks.push(Buffer.from(part));

      // Test-only endpoint: do not retain/log the real transport's Authorization header.
      collected.push(JSON.parse(Buffer.concat(chunks).toString()) as ExportBody);
      response.writeHead(responseStatus, { 'content-type': 'application/json' });

      if (trickleResponse) {
        response.write('{');
        const timer = setInterval(() => response.write(' '), 20);
        response.once('close', () => clearInterval(timer));
      } else {
        response.end('{}');
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test collector address unavailable');
    url = `http://127.0.0.1:${address.port}`;
    tracing = initializeTracing(readTracingSettings({ LANGFUSE_TRACING_ENABLED: 'true', LANGFUSE_BASE_URL: url,
      LANGFUSE_PUBLIC_KEY: publicKey, LANGFUSE_SECRET_KEY: secretKey, LANGFUSE_TIMEOUT_MS: '200' }), { secrets: [secret] });
  });

  afterAll(async () => {
    await tracing.shutdown();
    server.close();
    server.closeAllConnections();
  });

  it('exports a coherent root, three generations and sibling echo tool with streamed usage', async () => {
    await expect(runModelProbe({ ...options, tracing, fetch: scriptedFetch() })).resolves.toMatchObject({ compatible: true });
    await tracing.flush();

    const spans = allSpans();
    expect(spans).toHaveLength(5);
    const root = spans.find((span) => span.name === 'model-compatibility-probe');
    expect(root).toBeDefined();
    expect(root?.parentSpanId ?? '').toBe('');

    const children = spans.filter((span) => span.parentSpanId === root?.spanId);
    expect(children.map((span) => span.name).sort()).toEqual([
      'execute-probe-echo', 'streaming-check', 'tool-call-check', 'tool-result-continuation',
    ]);
    expect(new Set(spans.map((span) => span.traceId)).size).toBe(1);
    expect(attribute(root!, 'langfuse.observation.input')).toContain('streaming');
    expect(attribute(root!, 'langfuse.observation.output')).toContain('compatible');

    for (const generation of children.filter((span) => span.name !== 'execute-probe-echo')) {
      expect(attribute(generation, 'langfuse.observation.type')).toBe('generation');
      expect(attribute(generation, 'langfuse.observation.model.name')).toBe(options.model);
      expect(attribute(generation, 'langfuse.observation.usage_details')).toContain('3');
    }

    const tool = children.find((span) => span.name === 'execute-probe-echo');
    expect(attribute(tool!, 'langfuse.observation.type')).toBe('tool');
    expect(attribute(tool!, 'langfuse.observation.output')).toContain('compatibility check');

    const body = JSON.stringify(collected);
    expect(body).not.toContain(secret);
    expect(body).not.toContain(secretKey);
    expect(body).not.toContain(publicKey);
    expect(body).not.toContain('somebody@example.test');
    expect(body).not.toContain('private chain of thought');
    expect(attribute(children[0]!, 'langfuse.observation.metadata.endpoint')).toBe(options.baseURL);
  });

  it('records request context and structured HTTP errors before any model output exists', async () => {
    const start = allSpans().length;
    const client = new OpenAI({ baseURL: options.baseURL, apiKey: secret, maxRetries: 0,
      fetch: async () => new Response(JSON.stringify({ error: { code: 'unsupported_parameter', type: 'invalid_request_error',
        param: 'max_tokens', message: `Use max_completion_tokens, not max_tokens. ${secret}` } }),
      { status: 400, headers: { 'content-type': 'application/json', 'x-request-id': 'req-diagnostic-test' } }) });

    await expect(tracing.turn({ conversationId: 'conversation-diagnostics', turnId: 'turn-diagnostics', publisherId: 'publisher-a' },
      () => tracing.generation('failed-request', client, async (observed) => {
        await observed.chat.completions.create({ model: 'reasoning-model', messages: [{ role: 'user', content: 'hello' }],
          stream: true, max_tokens: 64, reasoning_effort: 'low', temperature: 0 });
      }))).rejects.toMatchObject({ status: 400 });
    await tracing.flush();

    const spans = allSpans().slice(start);
    expect(spans).toHaveLength(2);
    const generation = spans.find((span) => span.name === 'failed-request')!;
    expect(attribute(generation, 'langfuse.observation.level')).toBe('ERROR');
    expect(attribute(generation, 'langfuse.observation.model.name')).toBe('reasoning-model');
    expect(attribute(generation, 'langfuse.observation.model.parameters')).toContain('"reasoning_effort":"low"');
    expect(attribute(generation, 'langfuse.observation.model.parameters')).toContain('"temperature":0');
    expect(attribute(generation, 'langfuse.observation.input')).toContain('hello');
    expect(attribute(generation, 'langfuse.observation.output')).toContain('unsupported_parameter');
    expect(attribute(generation, 'langfuse.observation.metadata.error')).toContain('req-diagnostic-test');
    expect(attribute(generation, 'langfuse.observation.status_message')).toContain('max_completion_tokens');
    expect(JSON.stringify(spans)).not.toContain(secret);
    expect(JSON.stringify(spans)).not.toContain(secretKey);
  });

  it('exports full model-runner failure context on the agent generation and root, not application logs', async () => {
    const start = allSpans().length;
    const appLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const modelServer = createServer((_request, response) => {
      response.writeHead(400, { 'content-type': 'application/json', 'x-request-id': 'req-model-runner' });
      response.end(JSON.stringify({ error: { code: 'unsupported_parameter', type: 'invalid_request_error', param: 'max_tokens',
        message: `Unsupported max_tokens. ${secret}` } }));
    });
    modelServer.listen(0, '127.0.0.1');
    await once(modelServer, 'listening');

    try {
      const address = modelServer.address();
      if (!address || typeof address === 'string') throw new Error('Test provider address unavailable');
      const run = modelRunner({ LLM_BASE_URL: `http://127.0.0.1:${address.port}/v1`, LLM_API_KEY: secret,
        LLM_MODEL: 'test-model' }, tracing);
      await expect(tracing.turn({ conversationId: 'agent-conversation', turnId: 'agent-turn', publisherId: 'publisher-a' },
        () => run(initialState('agent-turn', [{ role: 'user', content: 'Inspect my revenue.' }]), new AbortController().signal, () => {},
          { conversationId: 'agent-conversation', turnId: 'agent-turn', correlationId: 'test-correlation' })))
        .rejects.toMatchObject({ code: 'MODEL_INCOMPATIBLE', diagnostics: { stage: 'request', httpStatus: 400 } });
      await tracing.flush();

      const spans = allSpans().slice(start);
      expect(spans.map((span) => span.name).sort()).toEqual(['investigation-model', 'publisher-investigation']);
      expect(spans.every((span) => attribute(span, 'langfuse.observation.level') === 'ERROR')).toBe(true);
      const generation = spans.find((span) => span.name === 'investigation-model')!;
      const root = spans.find((span) => span.name === 'publisher-investigation')!;
      expect(generation.parentSpanId).toBe(root.spanId);
      expect(attribute(generation, 'langfuse.observation.model.name')).toBe('test-model');
      expect(attribute(generation, 'langfuse.observation.input')).toContain('Inspect my revenue.');
      expect(attribute(generation, 'langfuse.observation.metadata.error')).toContain('req-model-runner');
      expect(attribute(generation, 'langfuse.observation.metadata.error')).toContain('test-correlation');
      expect(attribute(root, 'langfuse.observation.output')).toContain('unsupported_parameter');
      expect(attribute(root, 'langfuse.observation.output')).not.toContain('"finished":true');
      expect(JSON.stringify(spans)).not.toContain(secret);
      expect(appLog).toHaveBeenCalled();
      expect(JSON.stringify(appLog.mock.calls)).not.toContain(secret);
    } finally {
      appLog.mockRestore();
      modelServer.close();
      modelServer.closeAllConnections();
    }
  });

  it('retains partial output and usage when application validation rejects a completed stream', async () => {
    const start = allSpans().length;
    const client = new OpenAI({ baseURL: options.baseURL, apiKey: secret, maxRetries: 0,
      fetch: async () => sse([chunk({ content: `partial ${secret}` }), chunk({}, 'length'),
        { choices: [], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }]) });
    const error = new HttpError(502, 'MODEL_INCOMPATIBLE', 'Completion was truncated.');

    await expect(tracing.generation('failed-validation', client, async (observed) => {
      const stream = await observed.chat.completions.create({ model: options.model, messages: [{ role: 'user', content: 'hello' }], stream: true });
      for await (const _chunk of stream) { /* Consume before validating the finish reason. */ }
      throw error;
    })).rejects.toBe(error);
    await tracing.flush();

    const generation = allSpans().slice(start).find((span) => span.name === 'failed-validation')!;
    expect(attribute(generation, 'langfuse.observation.level')).toBe('ERROR');
    expect(attribute(generation, 'langfuse.observation.output')).toContain('partial');
    expect(attribute(generation, 'langfuse.observation.metadata.finishReason')).toBe('length');
    expect(attribute(generation, 'langfuse.observation.usage_details')).toContain('7');
    expect(attribute(generation, 'langfuse.observation.status_message')).toContain('Completion was truncated');
    expect(JSON.stringify(generation)).not.toContain(secret);
  });

  it('keeps valid empty tool-call arrays compatible with and without tracing', async () => {
    const fetcher = (): typeof fetch => {
      const normal = scriptedFetch();

      return async (...args) => {
        const response = await normal(...args);
        const wire = await response.text();
        const modified = wire.replace(/data: (.+)\n/g, (line, json: string) => {
          if (json === '[DONE]') return line;
          const value = JSON.parse(json) as { choices: Array<{ delta: { content?: string; tool_calls?: unknown[] } }> };

          for (const choice of value.choices) {
            if (choice.delta.content) choice.delta.tool_calls = [];
          }

          return `data: ${JSON.stringify(value)}\n`;
        });

        return new Response(modified, { headers: { 'content-type': 'text/event-stream' } });
      };
    };

    await expect(runModelProbe({ ...options, fetch: fetcher() })).resolves.toMatchObject({ compatible: true });
    await expect(runModelProbe({ ...options, tracing, fetch: fetcher() })).resolves.toMatchObject({ compatible: true });
    await tracing.flush();
  });

  it('does not send application HTTP/auth/database spans to Langfuse', async () => {
    const start = allSpans().length;
    for (const name of ['http-request', 'auth-login', 'database-query', 'application-startup']) {
      const span = trace.getTracer('application').startSpan(name);
      span.setAttribute('application.message', 'application logs stay local');
      span.end();
    }
    await tracing.flush();

    expect(allSpans().slice(start)).toHaveLength(0);
  });

  it('leaves missing usage/cost absent rather than inventing Llama metrics', async () => {
    const start = allSpans().length;
    await runModelProbe({ ...options, tracing, fetch: scriptedFetch(false) });
    await tracing.flush();

    const spans = allSpans().slice(start);
    expect(spans).toHaveLength(5);

    for (const span of spans) {
      expect(attribute(span, 'langfuse.observation.usage_details')).toBeUndefined();
      expect(attribute(span, 'langfuse.observation.cost_details')).toBeUndefined();
    }
  });

  it('sanitizes provider errors and closes aborted/invalid streaming generations', async () => {
    const start = allSpans().length;
    const failureFetch: typeof fetch = async () => new Response(`{"error":{"message":"Bearer ${secret}; provider rejected credentials"}}`, {
      status: 401, headers: { 'content-type': 'application/json' },
    });

    await expect(runModelProbe({ ...options, tracing, fetch: failureFetch })).rejects.toMatchObject({ code: 'MODEL_AUTH_FAILED' });
    await tracing.flush();

    const failureSpans = allSpans().slice(start);
    expect(failureSpans).toHaveLength(2);
    expect(JSON.stringify(failureSpans)).toContain('provider rejected credentials');
    expect(JSON.stringify(failureSpans)).not.toContain(secret);

    const malformedStart = allSpans().length;
    await expect(runModelProbe({ ...options, tracing, fetch: async () => sse([chunk({ content: 'x' }, 'length')]) }))
      .rejects.toMatchObject({ code: 'MODEL_PROTOCOL_INVALID' });
    await tracing.flush();

    expect(allSpans().slice(malformedStart)).toHaveLength(2);
  });

  it('exports the timed-out generation even when its mocked stream ignores cancellation', async () => {
    const start = allSpans().length;
    const stalled: typeof fetch = async () => {
      let closeTimer: ReturnType<typeof setTimeout>;

      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk({ content: 'partial' }))}\n\n`));
          closeTimer = setTimeout(() => controller.close(), 100);
        },
        cancel() { clearTimeout(closeTimer); },
      }), { headers: { 'content-type': 'text/event-stream' } });
    };

    await expect(runModelProbe({ ...options, tracing, timeoutMs: 20, fetch: stalled })).rejects.toMatchObject({ code: 'MODEL_TIMEOUT' });
    await tracing.flush();

    const spans = allSpans().slice(start);
    expect(spans).toHaveLength(2);
    expect(spans.every((span) => attribute(span, 'langfuse.observation.level') === 'ERROR')).toBe(true);
  });

  it('flushes the compiled CLI and still exits when collector data trickles indefinitely', async () => {
    const start = allSpans().length;
    const modelServer = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const part of request) chunks.push(Buffer.from(part));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { tool_choice?: unknown };
      const reply = body.tool_choice ? [
        chunk({ tool_calls: [{ index: 0, id: 'call_echo', type: 'function', function: { name: 'probe_echo', arguments: '{"message":"compatibility check"}' } }] }),
        chunk({}, 'tool_calls'),
      ] : [chunk({ content: 'streaming works' }), chunk({}, 'stop')];

      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(reply.map((value) => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n');
    });
    modelServer.listen(0, '127.0.0.1');
    await once(modelServer, 'listening');

    try {
      const address = modelServer.address();
      if (!address || typeof address === 'string') throw new Error('Test model address unavailable');
      for (const stalled of [false, true]) {
        trickleResponse = stalled;
        const started = Date.now();
        const child = spawn(process.execPath, ['apps/api/dist/commands/cli.js', 'model:probe'], {
          env: { ...process.env, LLM_BASE_URL: `http://127.0.0.1:${address.port}/v1`, LLM_API_KEY: secret, LLM_MODEL: options.model,
            LANGFUSE_TRACING_ENABLED: 'true', LANGFUSE_BASE_URL: url, LANGFUSE_PUBLIC_KEY: publicKey, LANGFUSE_SECRET_KEY: secretKey,
            LANGFUSE_TIMEOUT_MS: stalled ? '100' : '1000', LANGFUSE_DEBUG: 'true', OTEL_LOG_LEVEL: 'debug' },
        });
        let output = '';
        let timer: ReturnType<typeof setTimeout> | undefined;
        child.stdout.on('data', (part: Buffer) => { output += part.toString(); });
        child.stderr.on('data', (part: Buffer) => { output += part.toString(); });

        try {
          const [exit] = await Promise.race([
            once(child, 'close'),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error('Compiled CLI did not exit after bounded shutdown')), 3000);
            }),
          ]);

          expect(exit).toBe(0);
          expect(output).toContain('"compatible":true');
          expect(output).not.toContain(secret);
          expect(output).not.toContain(secretKey);
          expect(output).not.toContain(publicKey);
          expect(Date.now() - started).toBeLessThan(3000);
        } finally {
          if (timer) clearTimeout(timer);
          if (child.exitCode === null) child.kill('SIGKILL');
        }
      }

      expect(allSpans().slice(start)).toHaveLength(10);
    } finally {
      trickleResponse = false;
      modelServer.close();
      modelServer.closeAllConnections();
    }
  });

  it('does not fail the model workflow when Langfuse rejects exports', async () => {
    responseStatus = 401;

    await expect(runModelProbe({ ...options, tracing, fetch: scriptedFetch() })).resolves.toMatchObject({ compatible: true });
    const start = Date.now();
    await tracing.shutdown();

    expect(Date.now() - start).toBeLessThan(2000);
    responseStatus = 200;
  });
});
