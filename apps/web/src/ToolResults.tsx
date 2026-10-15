import type { MouseEvent } from 'react';
import type { AnalyticsEvidence, DashboardView, SavedTool, SavedTurn } from '@bid/shared';
import { Icon } from './Icon.js';
import { EvidenceIndicator } from './EvidenceIndicator.js';
import './evidence.css';

const toolNames: Record<string, string> = {
  performance_summary: 'Publisher performance',
  compare_periods: 'Performance comparison',
  bidder_performance: 'Bidder performance',
  current_configuration: 'Current configuration',
  configuration_history: 'Configuration history',
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

/** Render backend evidence as-is; legacy results keep their saved summary and citation anchors. */
function cardsFor(tool: SavedTool): Card[] {
  const result = tool.result;
  if (!result) return [];
  const analytics = result.evidence.filter((entry) => entry.analytics);

  if (analytics.length) {
    return analytics.map((entry) => ({ ...entry.analytics!, ids: [entry.evidenceId] }));
  }

  return [
    {
      title: toolNames[tool.name] ?? 'Investigation',
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

export function ToolResults({
  turnId,
  tools,
  onShowEvidence,
}: {
  turnId: string;
  tools: SavedTool[];
  onShowEvidence?: ((view: DashboardView, title: string) => void) | undefined;
}) {
  return (
    <div className="investigation-evidence" aria-label="Supporting investigations">
      {tools.map((tool) => (
        <div key={tool.toolCallId} className="investigation-tool">
          {tool.errorCode && (
            <p className="tool-progress" role="status">
              <Icon name="error" />
              {toolNames[tool.name] ?? 'Investigation'} · Could not complete ({tool.errorCode})
            </p>
          )}
          {cardsFor(tool).map((card, index) => (
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
                    <strong>Filters</strong> · {card.view.period.startDate} –{' '}
                    {card.view.period.endDate} UTC
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
                <h4>Tool input</h4>
                <pre>{tool.argumentsJson}</pre>
                <h4>Observed result</h4>
                <pre>{JSON.stringify(tool.result?.data, null, 2)}</pre>
              </details>
            </EvidenceIndicator>
          ))}
        </div>
      ))}
    </div>
  );
}
