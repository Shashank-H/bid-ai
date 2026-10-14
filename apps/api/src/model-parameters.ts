import type { ModelSettings } from './env.js';

export function modelTuning(settings: Pick<ModelSettings, 'reasoningEffort' | 'temperature'>) {
  return { ...(settings.reasoningEffort === undefined ? {} : { reasoning_effort: settings.reasoningEffort }),
    ...(settings.temperature === undefined ? {} : { temperature: settings.temperature }) };
}

/** OpenAI's current models use max_completion_tokens; older compatible servers may only accept max_tokens. */
export function completionLimit(baseURL: string, tokens: number): { max_completion_tokens: number } | { max_tokens: number } {
  return new URL(baseURL).hostname === 'api.openai.com'
    ? { max_completion_tokens: tokens }
    : { max_tokens: tokens };
}
