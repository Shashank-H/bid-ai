import { useMemo, type MouseEvent } from 'react';
import { configurationTargetPath } from '@bid/shared';
import type {
  AnalyticsEvidence,
  ConfigurationTarget,
  DashboardView,
  SavedTool,
  SavedTurn,
} from '@bid/shared';
import { ConfigurationProposal } from './ConfigurationProposal.js';
import { Icon } from './Icon.js';
import { EvidenceIndicator } from './EvidenceIndicator.js';
import './evidence.css';

const toolNames: Record<string, string> = {
  performance_summary: 'Publisher performance',
  compare_periods: 'Performance comparison',
  bidder_performance: 'Bidder performance',
  current_configuration: 'Current configuration',
  configuration_history: 'Configuration history',
  configuration_read: 'Configuration snapshot',
  configuration_versions: 'Published versions',
  configuration_compare: 'Configuration comparison',
  configuration_propose_draft: 'Draft update proposal',
  configuration_navigate: 'Open configuration',
};

function evidenceId(turnId: string, id: string): string {
  return `evidence-${turnId}-${id}`;
}

function reveal(event: MouseEvent<HTMLAnchorElement>, id: string) {
  event.preventDefault();
  const anchor = document.getElementById(id);
  const target = anchor?.closest<HTMLElement>('.evidence-card') ?? anchor;
  if (!target) return;

  target.scrollIntoView({ block: 'nearest' });
  const trigger = target.querySelector<HTMLButtonElement>('.evidence-indicator');
  trigger?.focus({ preventScroll: true });
  trigger?.click();
}

export function CitedAnswer({ turn }: { turn: SavedTurn }) {
  const ids = new Set(
    turn.tools.flatMap((tool) => tool.result?.evidence.map((entry) => entry.evidenceId) ?? []),
  );
  const parts = turn.text.split(/(\[[A-Za-z0-9._:-]+\])/g);

  return (
    <p className="message-text">
      {parts.map((part, index) => {
        const reference = part.startsWith('[') ? part.slice(1, -1) : '';
        const id = evidenceId(turn.id, reference);

        return ids.has(reference) ? (
          <a key={index} href={`#${id}`} onClick={(event) => reveal(event, id)}>
            {part}
          </a>
        ) : (
          part
        );
      })}
    </p>
  );
}

type Card = {
  title: string;
  summary: string;
  ids: string[];
  view?: DashboardView;
  coverage?: AnalyticsEvidence['coverage'];
};

/** Build evidence cards without treating navigation/approval controls as observations. */
function cardsFor(tool: SavedTool): Card[] {
  const result = tool.result;
  if (!result) return [];
  if (
    !result.evidence.length &&
    (result.data?.kind === 'configuration-navigation' ||
      result.data?.kind === 'configuration-draft-proposal')
  )
    return [];

  const analytics = result.evidence.filter((entry) => entry.analytics);

  if (analytics.length) {
    return analytics.map((entry) => ({ ...entry.analytics!, ids: [entry.evidenceId] }));
  }

  const data = result.data;
  const title =
    data?.kind === 'configuration-document'
      ? data.target.kind === 'draft'
        ? `Shared draft · revision ${data.revision}`
        : data.target.kind === 'version'
          ? `Configuration version ${data.target.versionId}`
          : 'Configuration snapshot'
      : (toolNames[tool.name] ?? 'Investigation');

  return [
    {
      title,
      summary: result.summary,
      ids: result.evidence.map((entry) => entry.evidenceId),
    },
  ];
}

function activityText(turn: SavedTurn): string {
  const pending = turn.tools.find((tool) => !tool.result && !tool.errorCode);
  if (!pending) {
    if (turn.text) return 'Writing the response. The answer is still provisional.';
    return turn.tools.length
      ? 'Reviewing the retrieved results and preparing the response…'
      : 'Preparing the investigation and choosing the relevant data…';
  }

  let args: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(pending.argumentsJson);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      args = parsed as Record<string, unknown>;
  } catch {
    /* Partial arguments are not yet a scope. */
  }
  const period = (value: unknown): string => {
    if (!value || typeof value !== 'object') return '';
    const { startDate, endDate } = value as Record<string, unknown>;
    return typeof startDate === 'string' &&
      typeof endDate === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(startDate) &&
      /^\d{4}-\d{2}-\d{2}$/.test(endDate)
      ? ` (${startDate} – ${endDate} UTC)`
      : '';
  };
  const scope = period(args);

  switch (pending.name) {
    case 'performance_summary':
      return `Checking publisher performance${scope}…`;
    case 'compare_periods':
      return `Comparing current${period(args.current)} and previous${period(args.previous)} performance…`;
    case 'bidder_performance':
      return `Examining bidder requests, responses, latency and estimated revenue${scope}…`;
    case 'current_configuration':
      return 'Reading the current auction settings and enabled bidders…';
    case 'configuration_history':
      return `Checking the recorded configuration changes${scope}…`;
    default:
      return 'Retrieving supporting data for the investigation…';
  }
}

export function AgentActivity({ turn }: { turn: SavedTurn }) {
  if (turn.status !== 'running') return null;

  return (
    <p className="agent-activity" role="status" aria-live="polite" aria-atomic="true">
      <Icon name="activity" />
      <span>{activityText(turn)}</span>
    </p>
  );
}

function configurationTargets(tool: SavedTool): ConfigurationTarget[] {
  const data = tool.result?.data;
  const targets: ConfigurationTarget[] =
    tool.result?.evidence.flatMap((entry) =>
      entry.configurationTarget ? [entry.configurationTarget] : [],
    ) ?? [];
  if (
    data?.kind === 'configuration-document' ||
    data?.kind === 'configuration-draft-proposal' ||
    data?.kind === 'configuration-navigation'
  )
    targets.push(data.target);
  if (data?.kind === 'configuration-comparison') targets.push(data.left, data.right);
  if (data?.kind === 'configuration-version-list')
    targets.push(
      ...data.versions.map((version) => ({
        kind: 'version' as const,
        versionId: version.versionId,
      })),
    );
  return [...new Map(targets.map((target) => [configurationTargetPath(target), target])).values()];
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }

  return value;
}

function cardKey(tool: SavedTool, card: Card): string {
  const result = tool.result!;
  const data = result.data;
  const targets = configurationTargets(tool);
  const snapshot =
    data?.kind === 'configuration-document'
      ? data.prebid
      : data?.kind === 'configuration'
        ? data.configuration?.prebid
        : undefined;

  // Old and new read tools can describe the same immutable configuration snapshot.
  if (
    snapshot &&
    targets.length === 1 &&
    result.evidence.length &&
    result.evidence.every((entry) => entry.source === 'configuration')
  ) {
    return JSON.stringify(
      stableValue({
        kind: 'configuration-snapshot',
        publishers: [...new Set(result.evidence.map((entry) => entry.publisherId))].sort(),
        target: targets[0],
        snapshot,
        revision:
          data?.kind === 'configuration-document' && data.target.kind === 'draft'
            ? data.revision
            : undefined,
      }),
    );
  }

  const references = result.evidence
    .filter((entry) => card.ids.includes(entry.evidenceId))
    .map(({ evidenceId: _id, observedAt: _time, analytics: _analytics, ...reference }) =>
      JSON.stringify(stableValue(reference)),
    )
    .sort();

  return JSON.stringify(
    stableValue({
      references,
      data,
      view: card.view,
      coverage: card.coverage,
      // Legacy results without a structured snapshot cannot safely ignore their summaries.
      summary: data === undefined ? card.summary : undefined,
      tool: references.length ? undefined : tool.name,
    }),
  );
}

function cardsForTurn(tools: SavedTool[]): (Card & { tools: SavedTool[] })[] {
  const unique = new Map<string, Card & { tools: SavedTool[] }>();

  for (const tool of tools) {
    for (const card of cardsFor(tool)) {
      const key = cardKey(tool, card);
      const existing = unique.get(key);

      if (existing) {
        existing.ids = [...new Set([...existing.ids, ...card.ids])];
        if (!existing.tools.some((entry) => entry.toolCallId === tool.toolCallId)) {
          existing.tools.push(tool);
        }
      } else {
        unique.set(key, { ...card, tools: [tool] });
      }
    }
  }

  return [...unique.values()];
}

export function ToolResults({
  turnId,
  tools,
  onShowEvidence,
  onNavigateConfiguration,
  onUnauthorized,
}: {
  turnId: string;
  tools: SavedTool[];
  onShowEvidence?: ((view: DashboardView, title: string) => void) | undefined;
  onNavigateConfiguration?: ((path: string) => void) | undefined;
  onUnauthorized?: (() => void) | undefined;
}) {
  const cards = useMemo(() => cardsForTurn(tools), [tools]);
  const targets = [
    ...new Map(
      tools
        .flatMap(configurationTargets)
        .map((target) => [configurationTargetPath(target), target]),
    ).values(),
  ];
  const proposals = [
    ...new Set(
      tools.flatMap((tool) =>
        tool.result?.data?.kind === 'configuration-draft-proposal'
          ? [tool.result.data.proposalId]
          : [],
      ),
    ),
  ];

  return (
    <div className="investigation-evidence" aria-label="Supporting investigations">
      {targets.map((target) => (
        <button
          key={configurationTargetPath(target)}
          className="secondary"
          onClick={() => onNavigateConfiguration?.(configurationTargetPath(target))}
        >
          {target.kind === 'draft'
            ? 'Open shared draft'
            : target.kind === 'list'
              ? 'Open configurations'
              : `Open version ${target.versionId}`}
        </button>
      ))}
      {tools
        .filter((tool) => tool.errorCode)
        .map((tool) => (
          <p key={tool.toolCallId} className="tool-progress" role="status">
            <Icon name="error" />
            {toolNames[tool.name] ?? 'Investigation'} · Could not complete ({tool.errorCode})
          </p>
        ))}
      {cards.map((card, index) => (
        <EvidenceIndicator
          key={index}
          title={card.title}
          anchorIds={card.ids.map((id) => evidenceId(turnId, id))}
        >
          <h3>
            <Icon name="evidence" />
            {card.title}
          </h3>
          <p>{card.summary}</p>
          {card.view && (
            <div className="evidence-filters">
              <span>
                <strong>Filters</strong> · {card.view.period.startDate} – {card.view.period.endDate}{' '}
                UTC
              </span>
              {card.view.comparisonPeriod && (
                <span>
                  Compared with {card.view.comparisonPeriod.startDate} –{' '}
                  {card.view.comparisonPeriod.endDate} UTC
                </span>
              )}
              <span>
                Metric: Estimated revenue
                {card.view.kind === 'bidder-performance'
                  ? ` · Bidders: ${card.view.bidderIds.length ? card.view.bidderIds.join(', ') : 'All'}`
                  : ' · Publisher performance'}
              </span>
            </div>
          )}
          {card.coverage?.some(
            (period) => period.missingDates.length || period.partialDates.length,
          ) && (
            <p className="evidence-coverage">
              Coverage is incomplete:{' '}
              {card.coverage
                .map(
                  (period, i) =>
                    `${i ? 'Previous' : 'Current'} period: ${period.missingDates.length} missing, ${period.partialDates.length} partial UTC dates`,
                )
                .join('; ')}
              . Inspect the dashboard for details.
            </p>
          )}
          {card.view && onShowEvidence && (
            <button
              className="secondary show-evidence"
              onClick={() => onShowEvidence(card.view!, card.title)}
            >
              <Icon name="chart" />
              Show in dashboard
            </button>
          )}
          <details className="tool-diagnostics">
            <summary>Technical details</summary>
            {card.tools.map((tool) => (
              <div key={tool.toolCallId}>
                <h4>{toolNames[tool.name] ?? 'Investigation'} · Tool input</h4>
                <pre>{tool.argumentsJson}</pre>
                <h4>Observed result</h4>
                <p>{tool.result?.summary}</p>
                <pre>{JSON.stringify(tool.result?.data, null, 2)}</pre>
              </div>
            ))}
          </details>
        </EvidenceIndicator>
      ))}
      {proposals.map((proposalId) => (
        <ConfigurationProposal
          key={proposalId}
          proposalId={proposalId}
          onUnauthorized={onUnauthorized}
        />
      ))}
    </div>
  );
}
