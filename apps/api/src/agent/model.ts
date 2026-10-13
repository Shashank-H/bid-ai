import OpenAI from 'openai';
import { z } from 'zod';
import type { ModelRunner } from './service.js';
import type { TracingRuntime } from '../observability/tracing.js';
import { readAgentSettings, readModelSettings } from '../env.js';
import { HttpError } from '../errors.js';
import { modelTools } from '../tools/registry.js';
import { VisibleText } from './visible-text.js';
import type { ToolCall } from './state.js';

const Chunk = z.object({ choices: z.array(z.object({ index: z.literal(0),
  delta: z.object({ content: z.string().nullable().optional(),
    tool_calls: z.array(z.object({ index: z.number().int().min(0).max(11), id: z.string().max(128).optional(),
      type: z.literal('function').optional(), function: z.object({ name: z.string().max(128).optional(),
        arguments: z.string().max(16_384).optional() }).optional() })).max(12).optional() }),
  finish_reason: z.string().nullable().optional(),
})).max(1) });

export function modelRunner(env: NodeJS.ProcessEnv, tracing: TracingRuntime): ModelRunner {
  return async (state, signal, emit) => {
    const settings = readModelSettings(env);
    const agent = readAgentSettings(env);
    const messages = state.evidence.length ? [...state.messages, {
      role: 'system' as const,
      content: `First obtain all tool data requested by the user, including configuration history when requested. This note is not an instruction to stop using tools.
For your final answer, the only allowed evidence IDs are: ${JSON.stringify(state.evidence.map((item) => item.evidenceId))}.
Use the sections Observation:, Hypothesis:, Recommendation:. Cite your observations with exact IDs in square brackets, for example [${state.evidence[0]!.evidenceId}]. Label hypotheses as uncertain and recommendations as suggestions; these do not require forced citations.
Copy IDs verbatim. Do not add "evidenceId:" inside brackets, shorten an ID, or invent a date-range citation. Reusing a relevant ID across sections is allowed.`,
    }] : state.messages;

    if (Buffer.byteLength(JSON.stringify(messages)) > 131_072) {
      throw new HttpError(429, 'BUDGET_EXCEEDED', 'The model context byte limit was reached.');
    }
    const client = new OpenAI({ baseURL: settings.baseURL, apiKey: settings.apiKey, maxRetries: 0,
      timeout: Math.min(settings.timeoutMs, agent.deadlineMs) });

    try {
      return await tracing.generation('investigation-model', client, async (observed) => {
        const stream = await observed.chat.completions.create({ model: settings.model, stream: true,
          stream_options: { include_usage: true }, messages, tools: modelTools,
          max_tokens: agent.maxCompletionTokens,
          ...(settings.reasoningEffort === undefined ? {} : { reasoning_effort: settings.reasoningEffort }),
          ...(settings.temperature === undefined ? {} : { temperature: settings.temperature }) }, { signal });
        const calls = new Map<number, ToolCall>();
        const filter = new VisibleText();
        let text = '';
        let chunks = 0;
        let rawBytes = 0;
        let finish: string | null = null;
        let secretTail = '';
        const append = (visible: string, final = false) => {
          let safe = (secretTail + visible).replaceAll(settings.apiKey, '[REDACTED]');
          secretTail = '';

          if (!final) {
            for (let length = Math.min(settings.apiKey.length - 1, safe.length); length > 0; length--) {
              if (safe.endsWith(settings.apiKey.slice(0, length))) {
                secretTail = safe.slice(-length);
                safe = safe.slice(0, -length);
                break;
              }
            }
          }

          if (!safe) return;
          text += safe;
          if (Buffer.byteLength(text) > 65_536) throw new HttpError(429, 'BUDGET_EXCEEDED', 'The visible model output limit was reached.');
          emit(safe);
        };

        for await (const raw of stream) {
          signal.throwIfAborted();
          rawBytes += Buffer.byteLength(JSON.stringify(raw));
          if (++chunks > 25_000 || rawBytes > 1_048_576) throw new HttpError(429, 'BUDGET_EXCEEDED', 'The model stream limit was reached.');

          const parsed = Chunk.safeParse(raw);
          if (!parsed.success) throw new HttpError(502, 'MODEL_INCOMPATIBLE', 'The endpoint returned an unsupported stream.');
          const choice = parsed.data.choices[0];
          if (!choice) continue;
          if (finish) throw new HttpError(502, 'MODEL_INCOMPATIBLE', 'The endpoint sent content after finishing.');

          if (choice.delta.content) append(filter.push(choice.delta.content));
          for (const fragment of choice.delta.tool_calls ?? []) {
            const call = calls.get(fragment.index) ?? { id: '', name: '', argumentsJson: '' };
            if (fragment.id && fragment.id !== call.id) call.id += fragment.id;
            if (fragment.function?.name && fragment.function.name !== call.name) call.name += fragment.function.name;
            call.argumentsJson += fragment.function?.arguments ?? '';
            if (call.id.length > 128 || call.name.length > 128 || Buffer.byteLength(call.argumentsJson) > 16_384) {
              throw new HttpError(429, 'BUDGET_EXCEEDED', 'The streamed tool argument limit was reached.');
            }
            calls.set(fragment.index, call);
          }
          if (choice.finish_reason) finish = choice.finish_reason;
        }

        append(filter.finish(), true);
        if (!finish || !['stop', 'tool_calls'].includes(finish)) {
          throw new HttpError(502, 'MODEL_INCOMPATIBLE', 'The endpoint did not complete a supported streamed response.');
        }

        const completed = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
        if (completed.some((call) => !/^[A-Za-z0-9_-]{1,128}$/.test(call.id) || !/^[a-z_]{1,128}$/.test(call.name))
          || new Set(completed.map((call) => call.id)).size !== completed.length || finish === 'tool_calls' && !completed.length) {
          throw new HttpError(502, 'MODEL_INCOMPATIBLE', 'The endpoint returned incomplete tool calls.');
        }

        return { text, calls: completed, message: completed.length ? { role: 'assistant', content: text || null,
          tool_calls: completed.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.argumentsJson } })) }
          : { role: 'assistant', content: text } };
      });
    } catch (error) {
      if (error instanceof HttpError || signal.aborted) throw error;
      if (error instanceof OpenAI.APIConnectionTimeoutError) throw new HttpError(504, 'TIMEOUT', 'The model request timed out.');
      if (error instanceof OpenAI.APIConnectionError || error instanceof OpenAI.APIError && [401, 403, 429, 500, 502, 503].includes(error.status ?? 0)) {
        throw new HttpError(503, 'DEPENDENCY_UNAVAILABLE', 'The configured model is unavailable or could not authorize the request.');
      }

      throw new HttpError(502, 'MODEL_INCOMPATIBLE', 'The configured model could not complete a streaming tool request.');
    }
  };
}
