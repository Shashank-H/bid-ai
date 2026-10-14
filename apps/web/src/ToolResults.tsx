import type { MouseEvent } from 'react';
import type { SavedTool, SavedTurn } from '@bid/shared';
import { Icon, type IconName } from './Icon.js';

const toolIcons: Record<string, IconName> = {
  performance_summary: 'chart',
  compare_periods: 'compare',
  bidder_performance: 'chart',
  current_configuration: 'settings',
  configuration_history: 'history',
};

function evidenceId(turnId: string, id: string): string {
  return `evidence-${turnId}-${id}`;
}

function reveal(event: MouseEvent<HTMLAnchorElement>, id: string) {
  event.preventDefault();
  const target = document.getElementById(id);
  if (!target) return;

  for (let node: HTMLElement | null = target; node; node = node.parentElement) {
    if (node instanceof HTMLDetailsElement) node.open = true;
  }
  target.focus();
  target.scrollIntoView({ block: 'nearest' });
}

export function CitedAnswer({ turn }: { turn: SavedTurn }) {
  const ids = new Set(turn.tools.flatMap((tool) => tool.result?.evidence.map((entry) => entry.evidenceId) ?? []));
  const parts = turn.text.split(/(\[[A-Za-z0-9._:-]+\])/g);

  return <p className="message-text">{parts.map((part, index) => {
    const reference = part.startsWith('[') ? part.slice(1, -1) : '';
    const id = evidenceId(turn.id, reference);

    return ids.has(reference) ? <a key={index} href={`#${id}`} onClick={(event) => reveal(event, id)}>{part}</a> : part;
  })}</p>;
}

export function ToolResults({ turnId, tools }: { turnId: string; tools: SavedTool[] }) {
  return <div className="tool-results">{tools.map((tool) => <details key={tool.toolCallId} className="tool-card">
    <summary><Icon name={toolIcons[tool.name] ?? 'activity'} /><span>{tool.name}</span><span className={`tool-state${tool.errorCode ? ' tool-state-error' : ''}`}>
      <Icon name={tool.errorCode ? 'error' : tool.result ? 'check' : 'clock'} />{tool.errorCode ? `Error: ${tool.errorCode}` : tool.result ? 'Completed' : 'Running'}
    </span></summary>
    <h4>Validated tool input</h4><pre>{tool.argumentsJson}</pre>
    {tool.result && <>
      <p>{tool.result.summary}</p>
      <h4>Observed demo results · Estimated revenue</h4><pre>{JSON.stringify(tool.result.data, null, 2)}</pre>
      <h4>Supporting evidence</h4>
      {tool.result.evidence.map((entry) => <details key={entry.evidenceId} id={evidenceId(turnId, entry.evidenceId)} tabIndex={-1} className="evidence">
        <summary><Icon name="evidence" />{entry.source} · {entry.observedAt.slice(0, 10)}</summary>
        <dl><dt>Evidence ID</dt><dd>{entry.evidenceId}</dd><dt>Record</dt><dd>{entry.recordId}</dd>
          <dt>Publisher</dt><dd>{entry.publisherId}</dd><dt>Observed at (UTC)</dt><dd>{entry.observedAt}</dd>
          <dt>Data</dt><dd>Demo observations</dd></dl>
      </details>)}
      {!tool.result.evidence.length && <p>No observations in the requested period.</p>}
    </>}
  </details>)}</div>;
}
