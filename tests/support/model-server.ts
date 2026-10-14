import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';

export async function startModelServer(host = '127.0.0.1', port = 0) {
  let requests = 0;
  const server = createServer(async (request, response) => {
    if (request.url !== '/v1/chat/completions' || request.method !== 'POST') {
      response.writeHead(404).end();
      return;
    }

    let body = '';
    for await (const part of request) {
      body += part;
      if (body.length > 262144) {
        response.writeHead(413).end();
        return;
      }
    }

    requests++;
    const input = JSON.parse(body) as {
      messages: Array<{ role: string; content?: string }>;
      model: string;
    };
    const question =
      input.messages.filter((message) => message.role === 'user').at(-1)?.content ?? '';
    const tools = input.messages.filter((message) => message.role === 'tool');
    const lastUserIndex = input.messages.map((message) => message.role).lastIndexOf('user');
    const currentTools = input.messages
      .slice(lastUserIndex)
      .filter((message) => message.role === 'tool');
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
    const chunk = (delta: unknown, finish_reason: string | null = null) =>
      write(response, {
        id: 'mock-completion',
        object: 'chat.completion.chunk',
        created: 1,
        model: input.model,
        choices: [{ index: 0, delta, finish_reason }],
      });

    if (question.includes('mock:slow')) {
      chunk({ content: 'Waiting for the demo investigation…' });
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 10_000);
        response.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      if (response.destroyed) return;
    }

    if (!currentTools.length) {
      const month = input.messages.some(
        (message) => message.role === 'system' && message.content?.includes('2026-02'),
      )
        ? '02'
        : '01';
      const period = { startDate: `2026-${month}-01`, endDate: `2026-${month}-14` };
      const calls = [
        { name: 'performance_summary', arguments: JSON.stringify(period) },
        {
          name: 'compare_periods',
          arguments: JSON.stringify({
            previous: { ...period, endDate: `2026-${month}-07` },
            current: { ...period, startDate: `2026-${month}-08` },
          }),
        },
        { name: 'configuration_history', arguments: JSON.stringify(period) },
      ];
      if (question.includes('mock:malformed')) calls[0]!.arguments = '{invalid';
      if (question.includes('mock:unknown')) calls[0]!.name = 'mutate_configuration';

      // Multiple indices arrive out of order and arguments span distinct chunks.
      for (const index of [2, 0, 1]) {
        const call = calls[index]!;
        const middle = Math.floor(call.arguments.length / 2);
        chunk({
          tool_calls: [
            {
              index,
              id: `mock_call_${index}`,
              type: 'function',
              function: { name: call.name, arguments: call.arguments.slice(0, middle) },
            },
          ],
        });
        chunk({ tool_calls: [{ index, function: { arguments: call.arguments.slice(middle) } }] });
      }
      chunk({}, 'tool_calls');
    } else {
      const results = currentTools.map((message) => JSON.parse(message.content ?? '{}'));
      const comparison = results.find((result) => result.data?.kind === 'period-comparison');
      const history = results.find((result) => result.data?.kind === 'configuration-history');
      const firstEvidence = comparison?.evidence[0]?.evidenceId;
      const changeEvidence = history?.evidence.at(-1)?.evidenceId;
      const final = question.includes('mock:fake-citation')
        ? 'Observation: revenue fell [invented-evidence].'
        : firstEvidence
          ? `Observation: Estimated revenue changed from $${comparison.data.previous.estimatedRevenue.toFixed(2)} to $${comparison.data.current.estimatedRevenue.toFixed(2)} [${firstEvidence}].\n\nHypothesis: The recorded configuration timing may be related; correlation is not proof [${changeEvidence ?? firstEvidence}].\n\nRecommendation: Investigate a controlled comparison before changing settings [${firstEvidence}].`
          : 'I could not retrieve authorized observations. No analytical finding is available.';
      chunk({ reasoning_content: 'PRIVATE_SEPARATE_REASONING_SENTINEL', content: '<thi' });
      chunk({ content: 'nk>PRIVATE_INLINE_REASONING_SENTINEL</th' });
      chunk({ content: 'ink>' });
      for (let offset = 0; offset < final.length; offset += 80)
        chunk({ content: final.slice(offset, offset + 80) });
      chunk({}, 'stop');
      write(response, {
        choices: [],
        usage: {
          prompt_tokens: tools.length + 50,
          completion_tokens: 100,
          total_tokens: tools.length + 150,
        },
      });
    }

    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Mock model did not bind');

  return {
    url: `http://${host}:${address.port}/v1`,
    get requests() {
      return requests;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function write(response: ServerResponse, value: unknown) {
  if (!response.destroyed) response.write(`data: ${JSON.stringify(value)}\n\n`);
}
