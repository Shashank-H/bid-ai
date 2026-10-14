import OpenAI from 'openai';
import type {
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';
import { z } from 'zod';
import type { TracingRuntime } from '../observability/tracing.js';
import { completionLimit, modelTuning } from '../model-parameters.js';
import type { ModelSettings } from '../env.js';

export type ModelProbeErrorCode =
  | 'MODEL_CONFIGURATION_INVALID'
  | 'MODEL_AUTH_FAILED'
  | 'MODEL_NETWORK_FAILED'
  | 'MODEL_REQUEST_FAILED'
  | 'MODEL_STREAMING_UNSUPPORTED'
  | 'MODEL_TOOLS_UNSUPPORTED'
  | 'MODEL_PROTOCOL_INVALID'
  | 'MODEL_TIMEOUT'
  | 'MODEL_OUTPUT_LIMIT';

/** Only safe diagnostic codes cross the command boundary, never provider payloads. */
export class ModelProbeError extends Error {
  constructor(readonly code: ModelProbeErrorCode) {
    super(code);

    this.name = 'ModelProbeError';
  }
}

export interface ModelProbeOptions extends Pick<ModelSettings, 'reasoningEffort' | 'temperature'> {
  baseURL: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Optional bounded allowance for reasoning-capable compatible models. */
  maxCompletionTokens?: number;
  /** Test seam: still exercises the real OpenAI SDK request and SSE decoder. */
  fetch?: typeof globalThis.fetch;
  /** Initialized server-only runtime; omitted calls remain completely untraced. */
  tracing?: TracingRuntime;
}

export interface ModelProbeResult {
  compatible: true;
  streaming: true;
  toolCalls: true;
  continuation: true;
}

const ArgumentsSchema = z.strictObject({ message: z.string().min(1).max(256) });

const ChunkSchema = z.object({
  choices: z
    .array(
      z.object({
        index: z.literal(0),
        delta: z.object({
          role: z.literal('assistant').optional(),
          content: z.string().nullable().optional(),
          tool_calls: z
            .array(
              z.object({
                index: z.literal(0),
                id: z.string().optional(),
                type: z.literal('function').optional(),
                function: z
                  .object({ name: z.string().optional(), arguments: z.string().optional() })
                  .optional(),
              }),
            )
            .max(1)
            .optional(),
        }),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .max(1),
});

const tool = {
  type: 'function' as const,
  function: {
    name: 'probe_echo',
    description: 'Return the supplied diagnostic message unchanged. No data access or mutation.',
    parameters: {
      type: 'object',
      properties: { message: { type: 'string', minLength: 1, maxLength: 256 } },
      required: ['message'],
      additionalProperties: false,
    },
  },
};

function failure(code: ModelProbeErrorCode): never {
  throw new ModelProbeError(code);
}

/** Isolated three-request capability diagnostic, not the product agent or its tool loop. */
export async function runModelProbe(options: ModelProbeOptions): Promise<ModelProbeResult> {
  return options.tracing?.enabled
    ? options.tracing.probe(() => executeModelProbe(options))
    : executeModelProbe(options);
}

async function executeModelProbe(options: ModelProbeOptions): Promise<ModelProbeResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxOutputBytes = options.maxOutputBytes ?? 32_768;
  const maxChunks =
    options.maxCompletionTokens === undefined ? 512 : options.maxCompletionTokens * 3 + 16;
  let url: URL;

  try {
    url = new URL(options.baseURL);
  } catch {
    return failure('MODEL_CONFIGURATION_INVALID');
  }

  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !options.apiKey.trim() ||
    !options.model.trim() ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 120_000 ||
    !Number.isInteger(maxOutputBytes) ||
    maxOutputBytes < 1 ||
    maxOutputBytes > 1_048_576 ||
    (options.maxCompletionTokens !== undefined &&
      (!Number.isInteger(options.maxCompletionTokens) ||
        options.maxCompletionTokens < 64 ||
        options.maxCompletionTokens > 1024))
  ) {
    return failure('MODEL_CONFIGURATION_INVALID');
  }

  const controller = new AbortController();
  let responseType: string | null = null;
  const request = options.fetch ?? globalThis.fetch;
  const client = new OpenAI({
    baseURL: options.baseURL,
    apiKey: options.apiKey,
    maxRetries: 0,
    timeout: timeoutMs,
    logLevel: 'off', // Ignore OPENAI_LOG: diagnostic output must never include raw provider payloads.
    fetch: async (...args) => {
      const response = await request(...args);
      responseType = response.headers.get('content-type');

      return response;
    },
  });

  let byteCount = 0;
  let chunkCount = 0;
  const state: { phase: 'text' | 'tool' } = { phase: 'text' };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ModelProbeError('MODEL_TIMEOUT'));
    }, timeoutMs);
  });

  async function consume(
    params: ChatCompletionCreateParamsStreaming,
    expected: 'text' | 'tool',
    name: string,
  ) {
    const operation = (observedClient: OpenAI) => consumeStream(params, expected, observedClient);

    return options.tracing?.enabled
      ? options.tracing.generation(name, client, operation)
      : operation(client);
  }

  async function consumeStream(
    params: ChatCompletionCreateParamsStreaming,
    expected: 'text' | 'tool',
    observedClient: OpenAI,
  ) {
    state.phase = expected;
    responseType = null;

    // Capture HTTP metadata in the fetch adapter so tracing does not depend on APIPromise extensions.
    const stream = await observedClient.chat.completions.create(
      {
        ...params,
        ...modelTuning(options),
        stream_options: { include_usage: true },
      },
      { signal: controller.signal },
    );

    if (
      !(responseType as string | null)?.toLowerCase().includes('text/event-stream') ||
      !stream ||
      typeof stream[Symbol.asyncIterator] !== 'function'
    ) {
      failure('MODEL_STREAMING_UNSUPPORTED');
    }

    let text = '';
    let id = '';
    let name = '';
    let argumentsText = '';
    let finish: string | undefined;
    let sawTool = false;

    for await (const raw of stream) {
      // Count all received fields, including provider extensions that we never display.
      byteCount += Buffer.byteLength(JSON.stringify(raw), 'utf8');
      if (++chunkCount > maxChunks || byteCount > maxOutputBytes) failure('MODEL_OUTPUT_LIMIT');

      const parsed = ChunkSchema.safeParse(raw);
      if (!parsed.success) failure('MODEL_PROTOCOL_INVALID');

      const choice = parsed.data.choices[0];
      if (!choice) continue; // Optional usage-only final chunk.
      if (finish !== undefined) {
        // OpenRouter may repeat the finished choice in its final usage trailer.
        if (
          choice.delta.content ||
          choice.delta.tool_calls?.length ||
          (choice.finish_reason != null && choice.finish_reason !== finish)
        ) {
          failure('MODEL_PROTOCOL_INVALID');
        }

        continue;
      }
      if (choice.delta.content) text += choice.delta.content;

      const call = choice.delta.tool_calls?.[0];
      if (call) {
        if (expected !== 'tool') failure('MODEL_PROTOCOL_INVALID');
        sawTool = true;

        // Arguments/name may be fragmented; a call ID identifies the same indexed call.
        if (call.id && id && call.id !== id) failure('MODEL_PROTOCOL_INVALID');
        id = call.id ?? id;
        name += call.function?.name ?? '';
        argumentsText += call.function?.arguments ?? '';
        if (id.length > 128 || name.length > 64 || argumentsText.length > 2048)
          failure('MODEL_OUTPUT_LIMIT');
      }

      if (choice.finish_reason != null) finish = choice.finish_reason;
    }

    if (expected === 'text') {
      if (finish !== 'stop') failure('MODEL_PROTOCOL_INVALID');
      if (!text.trim()) failure('MODEL_STREAMING_UNSUPPORTED');

      return { text, id, name, argumentsText };
    }

    // A forced-tool assistant turn is valid without any assistant text.
    if (!sawTool) failure('MODEL_TOOLS_UNSUPPORTED');
    if (finish !== 'tool_calls' || name !== 'probe_echo' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
      failure('MODEL_PROTOCOL_INVALID');
    }

    return { text, id, name, argumentsText };
  }

  const execute = async (): Promise<ModelProbeResult> => {
    await consume(
      {
        model: options.model,
        stream: true,
        ...completionLimit(options.baseURL, options.maxCompletionTokens ?? 64),
        messages: [{ role: 'user', content: 'Reply briefly with: streaming works.' }],
      },
      'text',
      'streaming-check',
    );

    const messages: ChatCompletionMessageParam[] = [
      { role: 'user', content: 'Call probe_echo with message "compatibility check".' },
    ];
    const call = await consume(
      {
        model: options.model,
        stream: true,
        ...completionLimit(options.baseURL, options.maxCompletionTokens ?? 128),
        messages,
        tools: [tool],
        tool_choice: { type: 'function', function: { name: 'probe_echo' } },
      },
      'tool',
      'tool-call-check',
    );

    let rawArguments: unknown;

    try {
      rawArguments = JSON.parse(call.argumentsText);
    } catch {
      return failure('MODEL_PROTOCOL_INVALID');
    }

    const args = ArgumentsSchema.safeParse(rawArguments);
    if (!args.success) failure('MODEL_PROTOCOL_INVALID');

    const executeEcho = () => ({ message: args.data.message });
    const echoed = options.tracing?.enabled
      ? await options.tracing.tool({ message: args.data.message }, executeEcho)
      : executeEcho(); // Actual harmless local function execution.
    messages.push(
      {
        role: 'assistant',
        content: call.text || null,
        tool_calls: [
          {
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: call.argumentsText },
          },
        ],
      },
      { role: 'tool', tool_call_id: call.id, content: JSON.stringify(echoed) },
      { role: 'user', content: 'Briefly acknowledge receiving the tool result.' },
    );

    await consume(
      {
        model: options.model,
        stream: true,
        ...completionLimit(options.baseURL, options.maxCompletionTokens ?? 64),
        messages,
      },
      'text',
      'tool-result-continuation',
    );

    return { compatible: true, streaming: true, toolCalls: true, continuation: true };
  };

  try {
    return await Promise.race([execute(), deadline]);
  } catch (error) {
    if (error instanceof ModelProbeError) throw error;

    if (controller.signal.aborted || error instanceof OpenAI.APIConnectionTimeoutError)
      failure('MODEL_TIMEOUT');
    if (error instanceof OpenAI.APIError) {
      if (error.status === 401 || error.status === 403) failure('MODEL_AUTH_FAILED');
      if (state.phase === 'tool' && (error.status === 400 || error.status === 422))
        failure('MODEL_TOOLS_UNSUPPORTED');
      if (error instanceof OpenAI.APIConnectionError) failure('MODEL_NETWORK_FAILED');
      failure('MODEL_REQUEST_FAILED');
    }

    // Parsing/SSE decoder errors may contain raw provider content: never forward them.
    return failure('MODEL_PROTOCOL_INVALID');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}
