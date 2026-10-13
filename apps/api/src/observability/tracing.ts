import { context, createContextKey, diag, ProxyTracerProvider, ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { logs } from '@opentelemetry/api-logs';
import type { Attributes, Context, SpanStatus } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import type { ReadableSpan, Span, SpanExporter, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { isLangfuseSpan, LangfuseSpanProcessor } from '@langfuse/otel';
import { configureGlobalLogger, LogLevel } from '@langfuse/core';
import { observeOpenAI } from '@langfuse/openai';
import { getActiveTraceId, getLangfuseTracerProvider, propagateAttributes, startActiveObservation } from '@langfuse/tracing';
import type OpenAI from 'openai';
import type { TracingSettings } from '../env.js';

export interface TracingRuntime {
  readonly enabled: boolean;
  readonly traceId: string | undefined;
  probe<T>(operation: () => Promise<T>): Promise<T>;
  generation<T>(name: string, client: OpenAI, operation: (client: OpenAI) => Promise<T>): Promise<T>;
  tool<T>(input: unknown, operation: () => T | Promise<T>, name?: string): Promise<T>;
  turn<T>(input: { conversationId: string; turnId: string; publisherId: string }, operation: () => Promise<T>): Promise<T>;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

const disabledTracing: TracingRuntime = {
  enabled: false,
  traceId: undefined,
  probe: (operation) => operation(),
  generation: (_name, client, operation) => operation(client),
  tool: async (_input, operation) => operation(),
  turn: (_input, operation) => operation(),
  flush: async () => {},
  shutdown: async () => {},
};

const generationScope = createContextKey('bid-generation-scope');
const originalChunk = Symbol('original-stream-chunk');

function isIterable(value: unknown): value is AsyncIterable<unknown> {
  return value !== null && typeof value === 'object' && Symbol.asyncIterator in value;
}

function normalizeIntegrationStream(value: unknown): unknown {
  if (!isIterable(value)) return value;

  return (async function* () {
    for await (const chunk of value) {
      if (chunk === null || typeof chunk !== 'object' || !('choices' in chunk) || !Array.isArray(chunk.choices)) {
        yield chunk;
        continue;
      }

      let changed = false;
      const choices = chunk.choices.map((choice: unknown) => {
        if (choice === null || typeof choice !== 'object' || !('delta' in choice)
          || choice.delta === null || typeof choice.delta !== 'object' || !('tool_calls' in choice.delta)
          || !Array.isArray(choice.delta.tool_calls) || choice.delta.tool_calls.length !== 0) return choice;

        // SDK 5.13.1 treats an empty array as a real call and crashes aggregation.
        // Normalize ONLY its view, then restore the original for application validation.
        const { tool_calls: _empty, ...delta } = choice.delta;
        changed = true;

        return { ...choice, delta };
      });

      if (changed) {
        const normalized = { ...chunk, choices };
        Object.defineProperty(normalized, originalChunk, { value: chunk });
        yield normalized;
      } else {
        yield chunk;
      }
    }
  })();
}

function restoreApplicationStream(value: unknown): unknown {
  if (!isIterable(value)) return value;

  return (async function* () {
    for await (const chunk of value) {
      yield chunk !== null && typeof chunk === 'object' && originalChunk in chunk ? chunk[originalChunk] : chunk;
    }
  })();
}

function observedChatClient(client: OpenAI, name: string): OpenAI {
  const observed = observeOpenAI({
    create: (...args: Parameters<OpenAI['chat']['completions']['create']>) => client.chat.completions.create(...args)
      .then(normalizeIntegrationStream),
  }, { generationName: name });
  const view = Object.create(client) as OpenAI;

  Object.defineProperty(view, 'chat', { value: {
    ...client.chat,
    completions: {
      ...client.chat.completions,
      create: (...args: Parameters<OpenAI['chat']['completions']['create']>) => observed.create(...args).then(restoreApplicationStream),
    },
  } });

  return view;
}

const sensitiveKey = /api.?key|secret|password|authorization|credential|cookie|session.?token|access.?token|reasoning|thinking|chain.?of.?thought|analysis/i;

/** Defense in depth: SDK payload masking plus export-stage status/event sanitation. */
export function maskTraceData(value: unknown, secrets: readonly string[] = []): unknown {
  if (typeof value === 'string') {
    let text = value;

    for (const secret of secrets) {
      if (secret) text = text.split(secret).join('[REDACTED]');
    }

    text = text
      // Llama can put private reasoning in ordinary content, not a separate field.
      .replace(/<(think|thinking|analysis|reasoning)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '[REDACTED_REASONING]')
      .replace(/(?:sk|pk)-[A-Za-z0-9_-]+/g, '[REDACTED]')
      .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
      .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[EMAIL_REDACTED]');

    // Tool arguments and SDK observation payloads may themselves be JSON strings.
    if (/^\s*[\[{]/.test(text)) {
      try {
        return JSON.stringify(maskTraceData(JSON.parse(text), secrets));
      } catch {
        return '[REDACTED_UNSTRUCTURED_PAYLOAD]';
      }
    }

    return text;
  }

  if (Array.isArray(value)) return value.map((entry) => maskTraceData(entry, secrets));

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key, sensitiveKey.test(key) ? '[REDACTED]' : maskTraceData(entry, secrets),
    ]));
  }

  return value;
}

function safeErrorCode(error: unknown): string {
  return error instanceof Error && /^MODEL_[A-Z_]+$/.test(error.message)
    ? error.message : 'MODEL_REQUEST_FAILED';
}

function sanitizedSpan(span: ReadableSpan, secrets: readonly string[]): ReadableSpan {
  const attributes: Attributes = {};

  for (const [key, value] of Object.entries(span.attributes)) {
    // Never export request URLs/headers or arbitrary third-party attributes/events.
    if (!key.startsWith('langfuse.') && !key.startsWith('gen_ai.')) continue;
    if (sensitiveKey.test(key) || /cost_details/.test(key)) continue;

    attributes[key] = /status_message/.test(key)
      ? (typeof value === 'string' && /^MODEL_[A-Z_]+$/.test(value) ? value : 'MODEL_REQUEST_FAILED')
      : maskTraceData(value, secrets) as Attributes[string];
  }

  const status: SpanStatus = span.status.message
    ? { code: span.status.code, message: 'MODEL_REQUEST_FAILED' } : { code: span.status.code };

  return {
    ...span,
    attributes,
    status,
    events: [], // Exception events can include raw provider bodies, stacks and credentials.
    links: [],
    spanContext: () => span.spanContext(),
  };
}

/** Sanitizes every exported span and closes integration spans on cancellation/errors. */
class SafeSpanProcessor implements SpanProcessor {
  readonly pending = new Map<string, { span: Span; scope: unknown }>();

  constructor(private readonly processor: SpanProcessor, private readonly secrets: readonly string[]) {}

  onStart(span: Span, parentContext: Context): void {
    this.pending.set(span.spanContext().spanId, { span, scope: parentContext.getValue(generationScope) });
    this.processor.onStart(span, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    this.pending.delete(span.spanContext().spanId);
    this.processor.onEnd(sanitizedSpan(span, this.secrets));
  }

  finishGeneration(parentId: string | undefined, name: string | undefined, error: unknown, scope?: symbol): void {
    // The OpenAI integration currently leaves streaming generations open when consumers
    // abort or the stream throws. End that same observation; do not create a duplicate.
    for (const entry of this.pending.values()) {
      const { span } = entry;
      const readable = span as Span & ReadableSpan;

      if ((scope === undefined || scope === entry.scope) && (name === undefined || readable.name === name)
        && readable.parentSpanContext?.spanId === parentId
        && readable.attributes['langfuse.observation.type'] === 'generation') {
        if (error !== undefined) {
          span.setAttribute('langfuse.observation.level', 'ERROR');
          span.setAttribute('langfuse.observation.status_message', safeErrorCode(error));
        }

        span.end();
      }
    }
  }

  forceFlush(): Promise<void> {
    return this.processor.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.processor.shutdown();
  }
}

async function bounded(operation: () => Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      operation().catch(() => {}),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
  } catch {
    // Telemetry cannot change command outcomes or prevent application shutdown.
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Initialize before constructing LLM clients. No auto-instrumentation or health noise. */
export function initializeTracing(settings: TracingSettings, options: {
  secrets?: readonly string[];
  exporter?: SpanExporter;
} = {}): TracingRuntime {
  if (!settings.enabled) return disabledTracing;

  const previousProvider = trace.getTracerProvider();
  const pristineNoop = new ProxyTracerProvider().getDelegate();

  // Never route Langfuse observations into an existing, potentially unmasked provider.
  if (!(previousProvider instanceof ProxyTracerProvider) || previousProvider.getDelegate() !== pristineNoop
    || getLangfuseTracerProvider() !== previousProvider) {
    console.warn('TRACING_UNAVAILABLE: another telemetry provider already owns tracing');

    return disabledTracing;
  }

  const contextManager = new AsyncLocalStorageContextManager();
  const contextOwnership = createContextKey('bid-context-ownership');
  const ownsContext = () => contextManager.with(ROOT_CONTEXT.setValue(contextOwnership, true),
    () => context.active().getValue(contextOwnership) === true);

  if (!context.setGlobalContextManager(contextManager.enable())) {
    contextManager.disable();
    console.warn('TRACING_UNAVAILABLE: another telemetry context manager is registered');

    return disabledTracing;
  }

  const previousLogger = logs.getLoggerProvider();
  const secrets = [settings.secretKey, settings.publicKey, ...(options.secrets ?? [])];
  let sdk: NodeSDK | undefined;
  let processor: SafeSpanProcessor;

  try {
    // Disallow SDK debug logging even if inherited environment enables it.
    configureGlobalLogger({ level: LogLevel.NONE });

    const langfuse = new LangfuseSpanProcessor({
      baseUrl: settings.baseURL,
      publicKey: settings.publicKey,
      secretKey: settings.secretKey,
      environment: settings.environment,
      timeout: settings.timeoutMs / 1000,
      mediaUploadEnabled: false,
      flushAt: 64,
      flushInterval: 5,
      mask: ({ data }: { data: unknown }) => maskTraceData(data, secrets),
      shouldExportSpan: ({ otelSpan }) => isLangfuseSpan(otelSpan),
      ...(options.exporter ? { exporter: options.exporter } : {}),
    });
    processor = new SafeSpanProcessor(langfuse, secrets);
    sdk = new NodeSDK({
      serviceName: 'bid-api',
      autoDetectResources: false,
      contextManager,
      textMapPropagator: null,
      instrumentations: [],
      metricReaders: [],
      logRecordProcessors: [],
      spanProcessors: [processor],
    });
    // NodeSDK may enable console diagnostics from OTEL_LOG_LEVEL in its constructor.
    diag.disable();
    sdk.start();

    if (trace.getTracerProvider() !== previousProvider || previousProvider.getDelegate() === pristineNoop) {
      throw new Error('Telemetry provider registration did not succeed');
    }
  } catch {
    if (ownsContext()) context.disable();
    contextManager.disable();
    if (sdk) void sdk.shutdown().catch(() => {});
    console.warn('TRACING_UNAVAILABLE: application continues without telemetry');

    return disabledTracing;
  }

  const ownedProvider = trace.getTracerProvider();
  const ownedDelegate = previousProvider.getDelegate();
  const installedLogger = logs.getLoggerProvider();
  const activeSdk = sdk;
  let closing: Promise<void> | undefined;
  let traceId: string | undefined;

  return {
    enabled: true,
    get traceId() { return traceId; },
    probe: (operation) => propagateAttributes({
      traceName: 'model-compatibility-probe',
      tags: ['feature:model-probe'],
    }, () => startActiveObservation('model-compatibility-probe', async (span) => {
      traceId = getActiveTraceId();
      span.update({ input: { checks: ['streaming', 'tool-calling', 'tool-result-continuation'] } });

      try {
        const result = await operation();
        span.update({ output: result });

        return result;
      } catch (error) {
        // A deadline can win before an uncooperative stream finishes; close its
        // existing generation before the root observation leaves the active context.
        processor.finishGeneration(trace.getSpan(context.active())?.spanContext().spanId, undefined, error);
        span.update({ level: 'ERROR', statusMessage: safeErrorCode(error), output: { error: safeErrorCode(error) } });

        throw error;
      }
    })),
    generation: async (name, client, operation) => {
      const parentId = trace.getSpan(context.active())?.spanContext().spanId;
      const scope = Symbol('generation-invocation');
      let failure: unknown;

      try {
        return await context.with(context.active().setValue(generationScope, scope),
          () => operation(observedChatClient(client, name)));
      } catch (error) {
        failure = error;

        throw error;
      } finally {
        processor.finishGeneration(parentId, name, failure, scope);
      }
    },
    turn: (input, operation) => propagateAttributes({ traceName: 'publisher-investigation', sessionId: input.conversationId,
      tags: ['feature:investigation'] }, () => startActiveObservation('publisher-investigation', async (span) => {
      span.update({ input });

      try {
        const result = await operation();
        span.update({ output: { finished: true } });

        return result;
      } catch (error) {
        span.update({ level: 'ERROR', statusMessage: safeErrorCode(error), output: { error: safeErrorCode(error) } });
        throw error;
      }
    })),
    tool: (input, operation, name = 'execute-probe-echo') => startActiveObservation(name, async (span) => {
      span.update({ input });
      const output = await operation();
      span.update({ output });

      return output;
    }, { asType: 'tool' }),
    flush: () => bounded(() => processor.forceFlush(), settings.timeoutMs),
    shutdown: () => {
      closing ??= (async () => {
        await bounded(() => processor.forceFlush(), settings.timeoutMs);
        await bounded(() => activeSdk.shutdown(), settings.timeoutMs);

        if (trace.getTracerProvider() === ownedProvider && previousProvider.getDelegate() === ownedDelegate) trace.disable();
        if (ownsContext()) context.disable();
        contextManager.disable();
        if (installedLogger !== previousLogger && logs.getLoggerProvider() === installedLogger) logs.disable();
      })();

      return closing;
    },
  };
}
