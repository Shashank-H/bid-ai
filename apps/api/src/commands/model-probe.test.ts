import { describe, expect, it, vi } from 'vitest';
import { ModelProbeError, runModelProbe } from './model-probe.js';

const options = {
  baseURL: 'http://llama.invalid/v1',
  apiKey: 'sentinel-private-key',
  model: 'llama-demo',
};

function chunk(delta: Record<string, unknown>, finish: string | null = null) {
  return {
    id: 'chat-test',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'llama-demo',
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

function sse(chunks: unknown[]) {
  const wire = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  const encoded = new TextEncoder().encode(wire);

  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        // Fragment the transport, not just the tool arguments, to exercise the SDK SSE decoder.
        for (let i = 0; i < encoded.length; i += 7) controller.enqueue(encoded.slice(i, i + 7));

        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

const text = () =>
  sse([
    chunk({ role: 'assistant', content: 'streaming ' }),
    chunk({ content: 'works' }),
    chunk({}, 'stop'),
  ]);

const call = () =>
  sse([
    chunk({
      role: 'assistant',
      tool_calls: [
        {
          index: 0,
          id: 'call_echo',
          type: 'function',
          function: { name: 'probe_', arguments: '{"mes' },
        },
      ],
    }),
    chunk({
      tool_calls: [{ index: 0, function: { name: 'echo', arguments: 'sage":"compatibility ' } }],
    }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: 'check"}' } }] }),
    chunk({}, 'tool_calls'),
  ]);

function script(responses: Array<() => Response | Promise<Response>>) {
  const bodies: Array<Record<string, unknown>> = [];
  const fetcher: typeof globalThis.fetch = vi.fn(async (input, init) => {
    const raw = init?.body ?? (input instanceof Request ? await input.text() : '');
    bodies.push(JSON.parse(String(raw)) as Record<string, unknown>);
    const next = responses.shift();
    if (!next) throw new Error('unexpected extra request');

    return await next();
  });

  return { fetcher, bodies };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  const error = await promise.catch((e: unknown) => e);

  expect(error).toBeInstanceOf(ModelProbeError);
  expect(error).toMatchObject({ code, message: code });
  expect(String(error)).not.toContain(options.apiKey);
}

describe('OpenAI-compatible model diagnostic', () => {
  it('streams text, validates fragmented arguments, executes echo and continues without tool-turn text', async () => {
    const { fetcher, bodies } = script([text, call, text]);

    await expect(runModelProbe({ ...options, fetch: fetcher })).resolves.toEqual({
      compatible: true,
      streaming: true,
      toolCalls: true,
      continuation: true,
    });

    expect(bodies).toHaveLength(3);
    expect(bodies.every((b) => b['stream'] === true && b['model'] === options.model)).toBe(true);
    expect(bodies[1]?.['tool_choice']).toEqual({
      type: 'function',
      function: { name: 'probe_echo' },
    });

    const messages = bodies[2]?.['messages'] as Array<Record<string, unknown>>;

    expect(messages.find((m) => m['role'] === 'tool')).toEqual({
      role: 'tool',
      tool_call_id: 'call_echo',
      content: '{"message":"compatibility check"}',
    });
    expect(messages.find((m) => m['role'] === 'assistant')).toMatchObject({
      content: null,
      tool_calls: [
        {
          id: 'call_echo',
          type: 'function',
          function: { name: 'probe_echo', arguments: '{"message":"compatibility check"}' },
        },
      ],
    });
  });

  it('accepts repeated finish markers in usage trailers for all three requests', async () => {
    const withUsage = (finish: string, delta: Record<string, unknown>) => () =>
      sse([
        chunk(delta),
        chunk({}, finish),
        { ...chunk({ content: '', role: 'assistant' }, finish), usage: { total_tokens: 10 } },
      ]);
    const { fetcher } = script([
      withUsage('stop', { content: 'streaming works' }),
      withUsage('tool_calls', {
        tool_calls: [
          {
            index: 0,
            id: 'call_echo',
            type: 'function',
            function: { name: 'probe_echo', arguments: '{"message":"compatibility check"}' },
          },
        ],
      }),
      withUsage('stop', { content: 'received tool result' }),
    ]);

    await expect(runModelProbe({ ...options, fetch: fetcher })).resolves.toMatchObject({
      compatible: true,
    });
  });

  it.each([
    chunk({ content: 'late content' }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '{}' } }] }),
    chunk({}, 'tool_calls'),
  ])('rejects actual content or conflicting completion after finishing', async (trailer) => {
    const { fetcher } = script([
      () => sse([chunk({ content: 'answer' }), chunk({}, 'stop'), trailer]),
    ]);

    await expectCode(runModelProbe({ ...options, fetch: fetcher }), 'MODEL_PROTOCOL_INVALID');
  });

  it('uses max_completion_tokens on the official OpenAI endpoint for all probe requests', async () => {
    const { fetcher, bodies } = script([text, call, text]);
    await runModelProbe({ ...options, baseURL: 'https://api.openai.com/v1', fetch: fetcher });

    expect(bodies.map((request) => request['max_completion_tokens'])).toEqual([64, 128, 64]);
    expect(bodies.every((request) => request['max_tokens'] === undefined)).toBe(true);
  });

  it('forwards configured reasoning and temperature settings on every probe request', async () => {
    const { fetcher, bodies } = script([text, call, text]);
    await runModelProbe({ ...options, fetch: fetcher, reasoningEffort: 'none', temperature: 0 });

    expect(bodies).toHaveLength(3);
    for (const body of bodies)
      expect(body).toMatchObject({ reasoning_effort: 'none', temperature: 0 });
  });

  it('omits optional model settings when not configured', async () => {
    const { fetcher, bodies } = script([text, call, text]);
    await runModelProbe({ ...options, fetch: fetcher });

    for (const body of bodies) {
      expect(body).not.toHaveProperty('reasoning_effort');
      expect(body).not.toHaveProperty('temperature');
    }
  });

  it('supports explicit bounded completion allowances without changing finish validation', async () => {
    const { fetcher, bodies } = script([text, call, text]);

    await expect(
      runModelProbe({
        ...options,
        fetch: fetcher,
        maxCompletionTokens: 512,
        maxOutputBytes: 262144,
      }),
    ).resolves.toMatchObject({ compatible: true });
    expect(bodies.every((body) => body['max_tokens'] === 512)).toBe(true);

    await expectCode(
      runModelProbe({ ...options, maxCompletionTokens: 1025 }),
      'MODEL_CONFIGURATION_INVALID',
    );
    const truncated = script([() => sse([chunk({ content: 'partial' }, 'length')])]);
    await expectCode(
      runModelProbe({ ...options, maxCompletionTokens: 512, fetch: truncated.fetcher }),
      'MODEL_PROTOCOL_INVALID',
    );
  });

  it('rejects JSON/nonstreaming responses', async () => {
    const { fetcher } = script([
      () =>
        new Response('{"providerPrivate":"secret"}', {
          headers: { 'content-type': 'application/json' },
        }),
    ]);

    await expectCode(runModelProbe({ ...options, fetch: fetcher }), 'MODEL_STREAMING_UNSUPPORTED');
  });

  it('requires initial text before checking tools', async () => {
    const { fetcher } = script([() => sse([chunk({}, 'stop')])]);

    await expectCode(runModelProbe({ ...options, fetch: fetcher }), 'MODEL_STREAMING_UNSUPPORTED');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects omitted tools rather than pretending a scripted answer is dispatch', async () => {
    const { fetcher } = script([text, text]);

    await expectCode(runModelProbe({ ...options, fetch: fetcher }), 'MODEL_TOOLS_UNSUPPORTED');
  });

  it.each([
    [
      'different name',
      {
        index: 0,
        id: 'call_echo',
        type: 'function',
        function: { name: 'other', arguments: '{"message":"x"}' },
      },
    ],
    [
      'second call',
      {
        index: 1,
        id: 'call_other',
        type: 'function',
        function: { name: 'probe_echo', arguments: '{"message":"x"}' },
      },
    ],
    [
      'missing id',
      {
        index: 0,
        type: 'function',
        function: { name: 'probe_echo', arguments: '{"message":"x"}' },
      },
    ],
    [
      'unknown arguments',
      {
        index: 0,
        id: 'call_echo',
        type: 'function',
        function: { name: 'probe_echo', arguments: '{"message":"x","publisherId":"B"}' },
      },
    ],
    [
      'invalid JSON',
      {
        index: 0,
        id: 'call_echo',
        type: 'function',
        function: { name: 'probe_echo', arguments: '{' },
      },
    ],
  ])('rejects malformed tool protocol: %s', async (_, malformedCall) => {
    const { fetcher } = script([
      text,
      () => sse([chunk({ tool_calls: [malformedCall] }), chunk({}, 'tool_calls')]),
    ]);

    await expectCode(runModelProbe({ ...options, fetch: fetcher }), 'MODEL_PROTOCOL_INVALID');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects a changed call ID at the same streamed tool index', async () => {
    const { fetcher } = script([
      text,
      () =>
        sse([
          chunk({
            tool_calls: [
              {
                index: 0,
                id: 'call_one',
                type: 'function',
                function: { name: 'probe_echo', arguments: '{"message":' },
              },
            ],
          }),
          chunk({ tool_calls: [{ index: 0, id: 'call_two', function: { arguments: '"x"}' } }] }),
          chunk({}, 'tool_calls'),
        ]),
    ]);

    await expectCode(runModelProbe({ ...options, fetch: fetcher }), 'MODEL_PROTOCOL_INVALID');
  });

  it('requires streamed text after the actual tool result', async () => {
    const { fetcher } = script([text, call, () => sse([chunk({}, 'stop')])]);

    await expectCode(runModelProbe({ ...options, fetch: fetcher }), 'MODEL_STREAMING_UNSUPPORTED');
  });

  it.each([401, 403])('sanitizes auth failure HTTP%s without retries', async (status) => {
    const { fetcher } = script([
      () =>
        new Response(JSON.stringify({ error: { message: options.apiKey } }), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
    ]);

    await expectCode(runModelProbe({ ...options, fetch: fetcher }), 'MODEL_AUTH_FAILED');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('reports provider rejection of forced tools separately', async () => {
    const { fetcher } = script([
      text,
      () =>
        new Response('{"error":{"message":"private provider message"}}', {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    ]);

    await expectCode(runModelProbe({ ...options, fetch: fetcher }), 'MODEL_TOOLS_UNSUPPORTED');
  });

  it('sanitizes network failures without retries', async () => {
    const { fetcher } = script([
      () => {
        throw new Error(options.apiKey);
      },
    ]);

    await expectCode(runModelProbe({ ...options, fetch: fetcher }), 'MODEL_NETWORK_FAILED');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('sanitizes malformed SSE JSON', async () => {
    const { fetcher } = script([
      () =>
        new Response('data: not-json-private\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        }),
    ]);

    await expectCode(runModelProbe({ ...options, fetch: fetcher }), 'MODEL_PROTOCOL_INVALID');
  });

  it('does not enable SDK payload logging even when OPENAI_LOG requests debug output', async () => {
    vi.stubEnv('OPENAI_LOG', 'debug');
    const logs = ['debug', 'info', 'warn', 'error'] as const;
    const spies = logs.map((level) => vi.spyOn(console, level).mockImplementation(() => undefined));

    try {
      const { fetcher } = script([text, call, text]);

      await runModelProbe({ ...options, fetch: fetcher });

      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it('bounds total output bytes', async () => {
    const { fetcher } = script([text]);

    await expectCode(
      runModelProbe({ ...options, fetch: fetcher, maxOutputBytes: 20 }),
      'MODEL_OUTPUT_LIMIT',
    );
  });

  it('bounds chunk count even with a large byte limit', async () => {
    const { fetcher } = script([
      () => sse(Array.from({ length: 513 }, () => chunk({ content: 'x' }))),
    ]);

    await expectCode(
      runModelProbe({ ...options, fetch: fetcher, maxOutputBytes: 1_048_576 }),
      'MODEL_OUTPUT_LIMIT',
    );
  });

  it('aborts a stalled stream within the total deadline', async () => {
    let signal: AbortSignal | null | undefined;

    const fetcher: typeof globalThis.fetch = vi.fn(async (_, init) => {
      signal = init?.signal;

      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            signal?.addEventListener(
              'abort',
              () => controller.error(new Error('aborted-private')),
              { once: true },
            );
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    });

    await expectCode(runModelProbe({ ...options, fetch: fetcher, timeoutMs: 40 }), 'MODEL_TIMEOUT');
    expect(signal?.aborted).toBe(true);
  });

  it('rejects incomplete or unsafe configuration before contacting the endpoint', async () => {
    const { fetcher } = script([]);

    await expectCode(
      runModelProbe({ ...options, apiKey: '', fetch: fetcher }),
      'MODEL_CONFIGURATION_INVALID',
    );

    await expectCode(
      runModelProbe({
        ...options,
        baseURL: 'http://user:password@llama.invalid/v1',
        fetch: fetcher,
      }),
      'MODEL_CONFIGURATION_INVALID',
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});
