import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { getGlobalBannerFloor, setGlobalBannerFloor } from '../../packages/shared/src/index.js';
import type { ToolResult } from '../../packages/shared/src/index.js';

export async function startModelServer(
  host = '127.0.0.1',
  port = 0,
  profile: 'fixture' | 'phase3' = 'fixture',
) {
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
      // Provisional text belongs to the tool-planning round, not the final cited answer.
      if (!currentTools.length) chunk({ content: 'Waiting for the demo investigation…' });
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 10_000);
        response.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      if (response.destroyed) return;
    }

    const results = currentTools.map((message) => JSON.parse(message.content ?? '{}'));
    const configuration = configurationCalls(question, results);
    if (configuration?.length || !currentTools.length) {
      const month = input.messages.some(
        (message) => message.role === 'system' && message.content?.includes('2026-02'),
      )
        ? '02'
        : '01';
      const period = { startDate: `2026-${month}-01`, endDate: `2026-${month}-14` };
      const calls =
        configuration ??
        (profile === 'phase3'
          ? phase3Calls(question)
          : [
              { name: 'performance_summary', arguments: JSON.stringify(period) },
              {
                name: 'compare_periods',
                arguments: JSON.stringify({
                  previous: { ...period, endDate: `2026-${month}-07` },
                  current: { ...period, startDate: `2026-${month}-08` },
                }),
              },
              { name: 'configuration_history', arguments: JSON.stringify(period) },
            ]);
      if (question.includes('mock:malformed')) calls[0]!.arguments = '{invalid';
      if (question.includes('mock:unknown')) calls[0]!.name = 'mutate_configuration';

      // Multiple indices arrive out of order and arguments span distinct chunks.
      const indices = calls.map((_, index) => index).reverse();
      for (const index of indices) {
        const call = calls[index]!;
        const middle = Math.floor(call.arguments.length / 2);
        chunk({
          tool_calls: [
            {
              index,
              id: `mock_call_${currentTools.length}_${index}`,
              type: 'function',
              function: { name: call.name, arguments: call.arguments.slice(0, middle) },
            },
          ],
        });
        chunk({ tool_calls: [{ index, function: { arguments: call.arguments.slice(middle) } }] });
      }
      chunk({}, 'tool_calls');
    } else {
      const comparison = results.find((result) => result.data?.kind === 'period-comparison');
      const history = results.find((result) => result.data?.kind === 'configuration-history');
      const firstEvidence = comparison?.evidence[0]?.evidenceId;
      const changeEvidence = history?.evidence.at(-1)?.evidenceId;
      const final =
        configuration !== null
          ? configurationAnswer(results)
          : profile === 'phase3'
            ? phase3Answer(results)
            : question.includes('mock:fake-citation')
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

function phase3Calls(question: string) {
  const call = (name: string, input: unknown) => ({ name, arguments: JSON.stringify(input) });
  if (/beacon|bidder/i.test(question)) {
    const previous = { startDate: '2026-09-28', endDate: '2026-10-04' };
    const current = { startDate: '2026-10-05', endDate: '2026-10-18' };
    return [
      call('compare_periods', { previous, current }),
      call('bidder_performance', previous),
      call('bidder_performance', current),
      call('performance_summary', current),
    ];
  }

  return [
    call('compare_periods', {
      previous: { startDate: '2026-09-07', endDate: '2026-09-13' },
      current: { startDate: '2026-09-14', endDate: '2026-09-20' },
    }),
    call('current_configuration', {}),
    call('configuration_history', { startDate: '2026-09-07', endDate: '2026-09-20' }),
  ];
}

type Phase3Result = {
  data?: {
    kind: string;
    period?: { startDate: string; endDate: string };
    previous?: { estimatedRevenue: number };
    current?: { estimatedRevenue: number };
    configuration?: { settings: { floorCpm: number } };
    history?: Array<{ before: { floorCpm: number } | null; after: { floorCpm: number } }>;
    bidders?: Array<{ bidderId: string; responses: number; lateResponses: number }>;
  };
  evidence: Array<{ evidenceId: string; bidderId?: string }>;
};

/** Test model answers only from authorized tool JSON, never from generator scenarios. */
function phase3Answer(results: Phase3Result[]): string {
  const comparison = results.find((result) => result.data?.kind === 'period-comparison');
  const reference = comparison?.evidence[0]?.evidenceId;
  if (!reference || !comparison?.data?.previous || !comparison.data.current)
    return 'No authorized observations were available.';

  const observation = `Observation: Estimated revenue changed from $${comparison.data.previous.estimatedRevenue.toFixed(2)} to $${comparison.data.current.estimatedRevenue.toFixed(2)} [${reference}].`;
  const periods = results.filter((result) => result.data?.kind === 'bidder-performance');
  if (periods.length) {
    const baseline = periods.find((result) => result.data?.period?.startDate === '2026-09-28');
    const current = periods.find((result) => result.data?.period?.startDate === '2026-10-05');
    const before = baseline?.data?.bidders?.find((bidder) => bidder.bidderId === 'beacon');
    const after = current?.data?.bidders?.find((bidder) => bidder.bidderId === 'beacon');
    const bidderReference = current?.evidence.find(
      (entry) => entry.bidderId === 'beacon',
    )?.evidenceId;
    if (!before?.responses || !after?.responses || !bidderReference)
      return 'No authorized bidder observations were available.';

    return `${observation}\n\nBeacon late-offer share changed from ${((100 * before.lateResponses) / before.responses).toFixed(2)}% to ${((100 * after.lateResponses) / after.responses).toFixed(2)}% [${bidderReference}].\n\nHypothesis: Latency may affect eligibility; this comparison alone does not establish cause [${bidderReference}].\n\nRecommendation: Investigate latency using these period aggregates; synthetic estimated revenue is not verified payment [${bidderReference}].`;
  }

  const history = results.find((result) => result.data?.kind === 'configuration-history');
  const configuration = results.find((result) => result.data?.kind === 'configuration');
  const change = history?.data?.history?.at(-1);
  const changeReference = history?.evidence.at(-1)?.evidenceId;
  const configurationReference = configuration?.evidence[0]?.evidenceId;
  if (
    !change?.before ||
    !changeReference ||
    !configurationReference ||
    !configuration?.data?.configuration
  )
    return 'No authorized configuration observations were available.';

  return `${observation}\n\nThe recorded floor changed from $${change.before.floorCpm.toFixed(2)} to $${change.after.floorCpm.toFixed(2)} [${changeReference}]. Current floor is $${configuration.data.configuration.settings.floorCpm.toFixed(2)} [${configurationReference}].\n\nHypothesis: Timing may be related, but correlation is not proof [${reference}].\n\nRecommendation: Investigate a controlled comparison; synthetic estimated revenue is not verified payment [${reference}].`;
}

/** Configuration scenarios derive every draft field and evidence reference from tool results. */
function configurationCalls(question: string, results: ToolResult[]) {
  if (!question.includes('mock:configuration-')) return null;
  const call = (name: string, input: unknown) => ({ name, arguments: JSON.stringify(input) });
  if (!results.length) {
    if (question.includes('mock:configuration-navigation'))
      return [
        call('configuration_navigate', {
          target: { kind: /history/i.test(question) ? 'list' : 'draft' },
        }),
      ];
    if (question.includes('mock:configuration-propose'))
      return [
        call('configuration_read', { selection: { kind: 'draft' } }),
        call('configuration_read', { selection: { kind: 'current' } }),
      ];
    return [call('configuration_read', { selection: { kind: 'current' } })];
  }
  if (
    question.includes('mock:configuration-propose') &&
    !results.some((result) => result.data?.kind === 'configuration-draft-proposal')
  ) {
    const documents = results.flatMap((result) =>
      result.data?.kind === 'configuration-document' ? [result.data] : [],
    );
    const source =
      documents.find((document) => document.target.kind === 'draft' && document.prebid) ??
      documents.find((document) => document.prebid);
    if (!source?.prebid) return [];
    const prebid = structuredClone(source.prebid);
    const previous = getGlobalBannerFloor(prebid);
    const floor = previous === 0.91 ? 0.92 : 0.91;

    setGlobalBannerFloor(prebid, floor);
    prebid.setConfig.floors.data.default = floor;
    return [
      call('configuration_propose_draft', {
        expectedRevision: source.revision,
        prebid,
        rationale:
          'Review a supported floor adjustment; historical performance is not a prediction.',
        evidenceIds: [
          ...new Set(results.flatMap((result) => result.evidence.map((entry) => entry.evidenceId))),
        ],
      }),
    ];
  }
  return [];
}

function configurationAnswer(results: ToolResult[]): string {
  const evidenceId = results.flatMap((result) => result.evidence)[0]?.evidenceId;
  if (!evidenceId)
    return 'Insufficient evidence: No authorized observations were retrieved for this investigation.';
  const proposal = results.find((result) => result.data?.kind === 'configuration-draft-proposal');
  return `Observation: ${proposal ? 'A draft update is awaiting explicit human review; nothing was published' : 'The authorized configuration was retrieved'} [${evidenceId}].\n\nHypothesis: Configuration differences do not establish future performance gains.\n\nRecommendation: ${proposal ? 'Review the Update draft card, then publish separately only if appropriate' : 'Inspect the linked configuration; stored settings do not deploy a live website'}.`;
}
