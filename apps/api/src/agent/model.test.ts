import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { modelRunner } from './model.js';
import { initialState } from './state.js';
import { initializeTracing } from '../observability/tracing.js';

const env = {
  LLM_BASE_URL: 'http://model.invalid/v1',
  LLM_API_KEY: 'test-private-key',
  LLM_MODEL: 'test-model',
};

function chunk(delta: Record<string, unknown>, finish: string | null = null) {
  return {
    id: 'chat-test',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'test-model',
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

async function run(chunks: unknown[]) {
  const wire =
    chunks.map((value) => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n';
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(wire, { headers: { 'content-type': 'text/event-stream' } })),
  );
  const emitted: string[] = [];
  const result = await modelRunner(env, initializeTracing({ enabled: false }))(
    initialState('turn-test', [{ role: 'user', content: 'What about my revenue?' }]),
    new AbortController().signal,
    (text) => emitted.push(text),
  );

  return { result, emitted };
}

beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('model stream completion', () => {
  it.each(['stop', 'tool_calls'])(
    'accepts a repeated %s finish in an empty usage trailer',
    async (finish) => {
      const calls =
        finish === 'tool_calls'
          ? [
              {
                index: 1,
                id: 'call_metrics',
                type: 'function',
                function: { name: 'get_metrics', arguments: '{}' },
              },
            ]
          : [];
      const { result, emitted } = await run([
        chunk({ content: 'Public answer', tool_calls: calls }),
        chunk({}, finish),
        {
          ...chunk({ content: '', role: 'assistant' }, finish),
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
        { choices: [], usage: { total_tokens: 15 } },
      ]);

      expect(result.text).toBe('Public answer');
      expect(emitted.join('')).toBe('Public answer');
      expect(result.calls).toHaveLength(calls.length);
      if (calls.length)
        expect(result.calls[0]).toEqual({
          id: 'call_metrics',
          name: 'get_metrics',
          argumentsJson: '{}',
        });
    },
  );

  it.each([
    ['https://api.openai.com/v1', 'max_completion_tokens', 'max_tokens'],
    ['http://compatible.invalid/v1', 'max_tokens', 'max_completion_tokens'],
  ])('uses the supported completion limit for %s', async (baseURL, expected, absent) => {
    const wire = `data: ${JSON.stringify(chunk({ content: 'Answer' }, 'stop'))}\n\ndata: [DONE]\n\n`;
    const fetcher = vi.fn(
      async () => new Response(wire, { headers: { 'content-type': 'text/event-stream' } }),
    );
    vi.stubGlobal('fetch', fetcher);
    await modelRunner({ ...env, LLM_BASE_URL: baseURL }, initializeTracing({ enabled: false }))(
      initialState('turn-test', [{ role: 'user', content: 'Hello' }]),
      new AbortController().signal,
      () => {},
    );
    const init = fetcher.mock.calls[0] as unknown as [unknown, RequestInit];
    const request = JSON.parse(init[1].body as string) as Record<string, unknown>;

    expect(request[expected!]).toBe(4096);
    expect(request).not.toHaveProperty(absent!);
  });

  it('logs provider rejection details and preserves the cause without exposing the key', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                code: 'unsupported_parameter',
                type: 'invalid_request_error',
                param: 'max_tokens',
                message: `Unsupported parameter max_tokens; private key ${env.LLM_API_KEY}`,
              },
            }),
            {
              status: 400,
              headers: { 'content-type': 'application/json', 'x-request-id': 'req-rejected' },
            },
          ),
      ),
    );
    const invoke = modelRunner(env, initializeTracing({ enabled: false }));

    await expect(
      invoke(
        initialState('turn-test', [{ role: 'user', content: 'Hello' }]),
        new AbortController().signal,
        () => {},
        {
          conversationId: 'conversation-test',
          turnId: 'turn-test',
          correlationId: 'correlation-test',
          publisherId: 'publisher-a',
        },
      ),
    ).rejects.toMatchObject({
      code: 'MODEL_INCOMPATIBLE',
      diagnostics: {
        stage: 'request',
        httpStatus: 400,
        providerRequestId: 'req-rejected',
        model: 'test-model',
      },
      cause: { status: 400, param: 'max_tokens' },
    });

    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).toContain('unsupported_parameter');
    expect(logged).toContain('req-rejected');
    expect(logged).toContain('correlation-test');
    expect(logged).not.toContain(env.LLM_API_KEY);
  });

  it('records validation paths, stream shape and partial output on malformed chunks', async () => {
    await expect(
      run([
        chunk({ content: 'Partial response' }),
        { choices: [{ index: 0, delta: { content: 42 } }] },
      ]),
    ).rejects.toMatchObject({
      diagnostics: {
        stage: 'stream',
        chunks: 2,
        partialOutput: 'Partial response',
        validationIssues: expect.arrayContaining([
          expect.objectContaining({ path: ['choices', 0, 'delta', 'content'] }),
        ]),
      },
    });
  });

  it('records an unsupported finish reason and partial answer', async () => {
    await expect(
      run([chunk({ content: 'Partial response' }), chunk({}, 'length')]),
    ).rejects.toMatchObject({
      diagnostics: {
        stage: 'validate_response',
        finishReason: 'length',
        partialOutput: 'Partial response',
      },
    });
  });

  it.each([
    chunk({ content: 'late content' }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '{}' } }] }),
    chunk({}, 'tool_calls'),
  ])(
    'rejects content, tool fragments or a conflicting finish after completion',
    async (trailer) => {
      await expect(
        run([chunk({ content: 'answer' }), chunk({}, 'stop'), trailer]),
      ).rejects.toMatchObject({ code: 'MODEL_INCOMPATIBLE' });
    },
  );
});
