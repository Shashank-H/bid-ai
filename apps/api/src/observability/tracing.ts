import {
  context,
  createContextKey,
  diag,
  ProxyTracerProvider,
  ROOT_CONTEXT,
  trace,
} from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { logs } from '@opentelemetry/api-logs';
import type { Attributes, Context, SpanStatus } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import type {
  ReadableSpan,
  Span,
  SpanExporter,
  SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { isLangfuseSpan, LangfuseSpanProcessor } from '@langfuse/otel';
import { configureGlobalLogger, LogLevel } from '@langfuse/core';
import {
  getActiveTraceId,
  getLangfuseTracerProvider,
  propagateAttributes,
  startActiveObservation,
} from '@langfuse/tracing';
import type OpenAI from 'openai';
import type { TracingSettings } from '../env.js';
import type { DecisionResult } from '../agent/decision-model.js';
import { diagnosticEndpoint, errorDiagnostics } from './diagnostics.js';

export interface TracingRuntime {
  readonly enabled: boolean;
  readonly traceId: string | undefined;
  probe<T>(operation: () => Promise<T>): Promise<T>;
  generation<T>(
    name: string,
    client: OpenAI,
    operation: (client: OpenAI) => Promise<T>,
    context?: Record<string, unknown>,
  ): Promise<T>;
  decision(
    input: Record<string, unknown>,
    operation: () => Promise<DecisionResult>,
  ): Promise<DecisionResult>;
  tool<T>(input: unknown, operation: () => T | Promise<T>, name?: string): Promise<T>;
  turn<T>(
    input: { conversationId: string; turnId: string; publisherId: string },
    operation: () => Promise<T>,
  ): Promise<T>;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

const disabledTracing: TracingRuntime = {
  enabled: false,
  traceId: undefined,
  probe: (operation) => operation(),
  generation: (_name, client, operation) => operation(client),
  decision: (_input, operation) => operation(),
  tool: async (_input, operation) => operation(),
  turn: (_input, operation) => operation(),
  flush: async () => {},
  shutdown: async () => {},
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function observedChatClient(
  client: OpenAI,
  request: (input: Record<string, unknown>) => void,
  receive: (chunk: unknown) => void,
): OpenAI {
  const view = Object.create(client) as OpenAI;

  Object.defineProperty(view, 'chat', {
    value: {
      ...client.chat,
      completions: {
        ...client.chat.completions,
        create: async (...args: Parameters<OpenAI['chat']['completions']['create']>) => {
          request(record(args[0]));
          const response = await client.chat.completions.create(...args);
          if (
            response !== null &&
            typeof response === 'object' &&
            Symbol.asyncIterator in response
          ) {
            return (async function* () {
              for await (const chunk of response) {
                receive(chunk);
                yield chunk; // Application validation always sees the provider's original chunk.
              }
            })();
          }

          receive(response);
          return response;
        },
      },
    },
  });

  return view;
}

const sensitiveKey =
  /api.?key|secret|password|authorization|credential|cookie|session.?token|access.?token|reasoning|thinking|chain.?of.?thought|analysis/i;

function isSensitiveField(key: string, value: unknown): boolean {
  if (
    /(?:^|\.)(reasoningEffort|reasoning_effort)$/.test(key) &&
    typeof value === 'string' &&
    ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(value)
  )
    return false;
  if (
    /(?:^|\.)reasoning_tokens$/.test(key) &&
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0
  )
    return false;

  return sensitiveKey.test(key);
}

/** Defense in depth: SDK payload masking plus export-stage status/event sanitation. */
export function maskTraceData(value: unknown, secrets: readonly string[] = []): unknown {
  if (typeof value === 'string') {
    let text = value;

    for (const secret of secrets) {
      if (secret) text = text.split(secret).join('[REDACTED]');
    }

    text = text
      // Llama can put private reasoning in ordinary content, not a separate field.
      .replace(
        /<(think|thinking|analysis|reasoning)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi,
        '[REDACTED_REASONING]',
      )
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
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        isSensitiveField(key, entry) ? '[REDACTED]' : maskTraceData(entry, secrets),
      ]),
    );
  }

  return value;
}

function errorStatus(error: unknown, secrets: string[]): string {
  const details = errorDiagnostics(error, secrets);
  return (
    [details['code'], details['message']]
      .filter((value) => typeof value === 'string')
      .join(': ')
      .slice(0, 1024) || 'MODEL_REQUEST_FAILED'
  );
}

function sanitizedSpan(span: ReadableSpan, secrets: readonly string[]): ReadableSpan {
  const attributes: Attributes = {};

  for (const [key, value] of Object.entries(span.attributes)) {
    // Never export request URLs/headers or arbitrary third-party attributes/events.
    if (!key.startsWith('langfuse.') && !key.startsWith('gen_ai.')) continue;
    if (isSensitiveField(key, value) || /cost_details/.test(key)) continue;

    attributes[key] = maskTraceData(value, secrets) as Attributes[string];
  }

  const status: SpanStatus = span.status.message
    ? { code: span.status.code, message: maskTraceData(span.status.message, secrets) as string }
    : { code: span.status.code };

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
  readonly pending = new Map<string, { span: Span; fail?: (error: unknown) => void }>();

  constructor(
    private readonly processor: SpanProcessor,
    private readonly secrets: readonly string[],
  ) {}

  onStart(span: Span, parentContext: Context): void {
    this.pending.set(span.spanContext().spanId, { span });
    this.processor.onStart(span, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    this.pending.delete(span.spanContext().spanId);
    this.processor.onEnd(sanitizedSpan(span, this.secrets));
  }

  finishGeneration(parentId: string | undefined, error: unknown): void {
    // A probe deadline can win while an uncooperative provider stream is still open.
    for (const entry of this.pending.values()) {
      const { span } = entry;
      const readable = span as Span & ReadableSpan;

      if (
        readable.parentSpanContext?.spanId === parentId &&
        readable.attributes['langfuse.observation.type'] === 'generation'
      ) {
        entry.fail?.(error);
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
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } catch {
    // Telemetry cannot change command outcomes or prevent application shutdown.
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Initialize before constructing LLM clients. No auto-instrumentation or health noise. */
export function initializeTracing(
  settings: TracingSettings,
  options: {
    secrets?: readonly string[];
    exporter?: SpanExporter;
  } = {},
): TracingRuntime {
  if (!settings.enabled) return disabledTracing;

  const previousProvider = trace.getTracerProvider();
  const pristineNoop = new ProxyTracerProvider().getDelegate();

  // Never route Langfuse observations into an existing, potentially unmasked provider.
  if (
    !(previousProvider instanceof ProxyTracerProvider) ||
    previousProvider.getDelegate() !== pristineNoop ||
    getLangfuseTracerProvider() !== previousProvider
  ) {
    console.warn('TRACING_UNAVAILABLE: another telemetry provider already owns tracing');

    return disabledTracing;
  }

  const contextManager = new AsyncLocalStorageContextManager();
  const contextOwnership = createContextKey('bid-context-ownership');
  const ownsContext = () =>
    contextManager.with(
      ROOT_CONTEXT.setValue(contextOwnership, true),
      () => context.active().getValue(contextOwnership) === true,
    );

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

    if (
      trace.getTracerProvider() !== previousProvider ||
      previousProvider.getDelegate() === pristineNoop
    ) {
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
    get traceId() {
      return getActiveTraceId() ?? traceId;
    },
    probe: (operation) =>
      propagateAttributes(
        {
          traceName: 'model-compatibility-probe',
          tags: ['feature:model-probe'],
        },
        () =>
          startActiveObservation('model-compatibility-probe', async (span) => {
            traceId = getActiveTraceId();
            span.update({
              input: { checks: ['streaming', 'tool-calling', 'tool-result-continuation'] },
            });

            try {
              const result = await operation();
              span.update({ output: result });

              return result;
            } catch (error) {
              // A deadline can win before an uncooperative stream finishes; close its
              // existing generation before the root observation leaves the active context.
              processor.finishGeneration(
                trace.getSpan(context.active())?.spanContext().spanId,
                error,
              );
              span.update({
                level: 'ERROR',
                statusMessage: errorStatus(error, secrets),
                output: { error: errorDiagnostics(error, secrets) },
              });

              throw error;
            }
          }),
      ),
    generation: (name, client, operation, initial = {}) =>
      startActiveObservation(
        name,
        async (generation) => {
          // Own the observation until application validation finishes, not merely until SSE ends.
          const metadata: Record<string, unknown> = {
            ...initial,
            endpoint: diagnosticEndpoint(client.baseURL),
          };
          const calls = new Map<
            number,
            { id: string; type: string; function: { name: string; arguments: string } }
          >();
          let content = '';
          let completionStarted = false;
          let usageDetails: Record<string, number> | undefined;
          const output = () => ({
            role: 'assistant',
            content: content || null,
            ...(calls.size
              ? {
                  tool_calls: [...calls.entries()]
                    .sort(([a], [b]) => a - b)
                    .map(([, call]) => call),
                }
              : {}),
          });
          const snapshot = () => ({
            output: maskTraceData(output(), secrets),
            metadata: maskTraceData(metadata, secrets) as Record<string, unknown>,
            ...(usageDetails ? { usageDetails } : {}),
          });
          const fail = (error: unknown) => {
            const details = errorDiagnostics(error, secrets);
            generation.update({
              ...snapshot(),
              level: 'ERROR',
              statusMessage: errorStatus(error, secrets),
              output: { error: details, partialOutput: maskTraceData(output(), secrets) },
              metadata: maskTraceData({ ...metadata, error: details }, secrets) as Record<
                string,
                unknown
              >,
            });
          };
          const pending = processor.pending.get(
            trace.getSpan(context.active())?.spanContext().spanId ?? '',
          );
          if (pending) pending.fail = fail;
          generation.update({
            metadata: maskTraceData(metadata, secrets) as Record<string, unknown>,
            ...(typeof initial['model'] === 'string' ? { model: initial['model'] } : {}),
          });

          const request = (input: Record<string, unknown>) => {
            const parameters = Object.fromEntries(
              Object.entries(input).filter(
                ([key, value]) =>
                  !['model', 'messages', 'tools'].includes(key) &&
                  (typeof value === 'string' || typeof value === 'number'),
              ),
            ) as Record<string, string | number>;
            metadata['request'] = { ...input, messages: undefined, tools: undefined };
            generation.update({
              ...(typeof input['model'] === 'string' ? { model: input['model'] } : {}),
              input: maskTraceData({ messages: input['messages'], tools: input['tools'] }, secrets),
              modelParameters: maskTraceData(parameters, secrets) as Record<
                string,
                string | number
              >,
              metadata: maskTraceData(metadata, secrets) as Record<string, unknown>,
            });
          };
          const receive = (chunk: unknown) => {
            const raw = record(chunk);
            if (typeof raw['id'] === 'string') metadata['responseId'] = raw['id'];
            if (typeof raw['model'] === 'string') metadata['responseModel'] = raw['model'];
            const usage = record(raw['usage']);
            if (Object.keys(usage).length) {
              metadata['usage'] = usage;
              usageDetails = {};
              for (const [provider, field] of [
                ['prompt_tokens', 'input'],
                ['completion_tokens', 'output'],
                ['total_tokens', 'total'],
              ] as const) {
                if (typeof usage[provider] === 'number') usageDetails[field] = usage[provider];
              }
            }
            const choice = record(Array.isArray(raw['choices']) ? raw['choices'][0] : undefined);
            const delta = record(choice['delta'] ?? choice['message']);
            if (choice['finish_reason'] != null) metadata['finishReason'] = choice['finish_reason'];
            if (
              !completionStarted &&
              (delta['content'] ||
                (Array.isArray(delta['tool_calls']) && delta['tool_calls'].length))
            ) {
              completionStarted = true;
              generation.update({ completionStartTime: new Date() });
            }
            if (typeof delta['content'] === 'string')
              content = (content + delta['content']).slice(0, 65_536);
            for (const fragment of Array.isArray(delta['tool_calls']) ? delta['tool_calls'] : []) {
              const item = record(fragment);
              const index = typeof item['index'] === 'number' ? item['index'] : 0;
              if (index < 0 || index > 11) continue;
              const call = calls.get(index) ?? {
                id: '',
                type: 'function',
                function: { name: '', arguments: '' },
              };
              const fn = record(item['function']);
              if (typeof item['id'] === 'string' && item['id'] !== call.id)
                call.id = (call.id + item['id']).slice(0, 128);
              if (typeof fn['name'] === 'string' && fn['name'] !== call.function.name)
                call.function.name = (call.function.name + fn['name']).slice(0, 128);
              if (typeof fn['arguments'] === 'string')
                call.function.arguments = (call.function.arguments + fn['arguments']).slice(
                  0,
                  16_384,
                );
              calls.set(index, call);
            }
          };

          try {
            const result = await operation(observedChatClient(client, request, receive));
            generation.update(snapshot());
            return result;
          } catch (error) {
            fail(error);
            throw error;
          }
        },
        { asType: 'generation' },
      ),
    decision: async (input, operation) => {
      let invoked = false;
      const started = Date.now();

      try {
        return await startActiveObservation(
          'decision-model',
          async (observation) => {
            // Instrumentation must neither mask results nor cause a provider call to replay.
            const update = (values: Parameters<typeof observation.update>[0]) => {
              try {
                observation.update(values);
              } catch {
                /* best-effort tracing */
              }
            };
            update({ input: maskTraceData(input, secrets) });
            invoked = true;

            try {
              const result = await operation();
              update({
                model: result.model,
                output: maskTraceData(
                  {
                    route: result.route,
                    intent: result.intent,
                    confidence: result.confidence,
                    answers: result.answers,
                  },
                  secrets,
                ),
                usageDetails: {
                  input: result.usage.input_tokens,
                  output: result.usage.output_tokens,
                },
                metadata: { ...input, elapsedMs: Date.now() - started, stage: result.stage },
              });

              return result;
            } catch (error) {
              update({
                level: 'ERROR',
                statusMessage: errorStatus(error, secrets),
                output: { error: errorDiagnostics(error, secrets) },
              });
              throw error;
            }
          },
          { asType: 'generation' },
        );
      } catch (error) {
        if (invoked) throw error;

        return operation();
      }
    },
    turn: (input, operation) =>
      propagateAttributes(
        {
          traceName: 'publisher-investigation',
          sessionId: input.conversationId,
          tags: ['feature:investigation'],
        },
        () =>
          startActiveObservation('publisher-investigation', async (span) => {
            traceId = getActiveTraceId();
            span.update({ input });

            try {
              const result = await operation();
              span.update({ output: { finished: true } });

              return result;
            } catch (error) {
              span.update({
                level: 'ERROR',
                statusMessage: errorStatus(error, secrets),
                output: { error: errorDiagnostics(error, secrets) },
              });
              throw error;
            }
          }),
      ),
    tool: (input, operation, name = 'execute-probe-echo') =>
      startActiveObservation(
        name,
        async (span) => {
          span.update({ input });
          try {
            const output = await operation();
            span.update({ output });
            return output;
          } catch (error) {
            span.update({
              level: 'ERROR',
              statusMessage: errorStatus(error, secrets),
              output: { error: errorDiagnostics(error, secrets) },
            });
            throw error;
          }
        },
        { asType: 'tool' },
      ),
    flush: () => bounded(() => processor.forceFlush(), settings.timeoutMs),
    shutdown: () => {
      closing ??= (async () => {
        await bounded(() => processor.forceFlush(), settings.timeoutMs);
        await bounded(() => activeSdk.shutdown(), settings.timeoutMs);

        if (
          trace.getTracerProvider() === ownedProvider &&
          previousProvider.getDelegate() === ownedDelegate
        )
          trace.disable();
        if (ownsContext()) context.disable();
        contextManager.disable();
        if (installedLogger !== previousLogger && logs.getLoggerProvider() === installedLogger)
          logs.disable();
      })();

      return closing;
    },
  };
}
