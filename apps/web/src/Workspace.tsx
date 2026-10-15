import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { AuthResponse, DashboardView } from '@bid/shared';
import { Chat } from './Chat.js';
import { Dashboard } from './Dashboard.js';
import { Icon } from './Icon.js';
import './workspace.css';

export function defaultDashboardView(auth: AuthResponse): DashboardView | null {
  if (!auth.availablePeriod || auth.status === 'loading' || auth.status === 'empty') return null;
  const partial = new Set(auth.partialDates ?? []);
  let end = Date.parse(auth.availablePeriod.endDate);

  while (
    end >= Date.parse(auth.availablePeriod.startDate) &&
    partial.has(new Date(end).toISOString().slice(0, 10))
  )
    end -= 86_400_000;
  if (end < Date.parse(auth.availablePeriod.startDate)) return null;

  return {
    kind: 'publisher-performance',
    metric: 'estimatedRevenue',
    period: {
      startDate: new Date(
        Math.max(Date.parse(auth.availablePeriod.startDate), end - 6 * 86_400_000),
      )
        .toISOString()
        .slice(0, 10),
      endDate: new Date(end).toISOString().slice(0, 10),
    },
  };
}

function panelWidth(width: number): number {
  return Math.max(320, Math.min(width, 640, window.innerWidth - 496));
}

export function Workspace({
  auth,
  onUnauthorized,
  onLogout,
  darkTheme,
  onToggleTheme,
}: {
  auth: AuthResponse;
  onUnauthorized: () => void;
  onLogout: () => void;
  darkTheme: boolean;
  onToggleTheme: () => void;
}) {
  const [agentOpen, setAgentOpen] = useState(false);
  const [view, setView] = useState<DashboardView | null>(() => defaultDashboardView(auth));
  const [evidenceTitle, setEvidenceTitle] = useState<string | null>(null);
  const [agentWidth, setAgentWidth] = useState(() =>
    panelWidth(Math.round(window.innerWidth * 0.3)),
  );
  const [resizing, setResizing] = useState(false);
  const drag = useRef<{ x: number; width: number; pointerId: number } | null>(null);

  useEffect(() => {
    const resize = () => setAgentWidth((width) => panelWidth(width));
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  function applyView(next: DashboardView) {
    setEvidenceTitle(null);
    setView(next);
  }

  function showEvidence(next: DashboardView, title: string) {
    setView(next);
    setEvidenceTitle(title);
    if (window.matchMedia('(max-width: 1000px)').matches) setAgentOpen(false);
  }

  function navigate(kind: DashboardView['kind']) {
    if (!view) return;
    applyView(
      kind === 'publisher-performance'
        ? { kind, metric: 'estimatedRevenue', period: view.period }
        : { kind, metric: 'estimatedRevenue', period: view.period, bidderIds: [] },
    );
  }

  return (
    <div
      className={`workspace${agentOpen ? ' agent-open' : ''}${resizing && agentOpen ? ' is-resizing' : ''}`}
      style={{ '--agent-panel-width': `${agentWidth}px` } as CSSProperties}
    >
      <nav className="navigation-rail" aria-label="Workspace">
        <span className="rail-brand" title="Bid Intelligence">
          bi<span>.</span>
        </span>
        <button
          className="rail-button secondary"
          aria-label="Publisher performance"
          title="Publisher performance"
          aria-current={view?.kind === 'publisher-performance' ? 'page' : undefined}
          onClick={() => navigate('publisher-performance')}
        >
          <Icon name="chart" />
          <span>Overview</span>
        </button>
        <button
          className="rail-button secondary"
          aria-label="Bidder performance"
          title="Bidder performance"
          aria-current={view?.kind === 'bidder-performance' ? 'page' : undefined}
          onClick={() => navigate('bidder-performance')}
        >
          <Icon name="compare" />
          <span>Bidders</span>
        </button>
        <div className="rail-bottom">
          <button
            className="rail-button secondary"
            aria-label={`Switch to ${darkTheme ? 'light' : 'dark'} theme`}
            aria-pressed={darkTheme}
            onClick={onToggleTheme}
          >
            <span aria-hidden="true">{darkTheme ? '☀' : '☾'}</span>
            <span>{darkTheme ? 'Light' : 'Dark'}</span>
          </button>
          <button
            className="rail-button secondary"
            aria-label="Log out"
            title={`Log out ${auth.user.login}`}
            onClick={onLogout}
          >
            <Icon name="logout" />
            <span>Log out</span>
          </button>
        </div>
      </nav>
      <section className="dashboard-main" aria-label="Analytics dashboard">
        <header className="workspace-header">
          <div>
            <p className="workspace-eyebrow">
              {auth.publisherId} <span> / Analytics</span>
            </p>
            <h1>
              {view?.kind === 'bidder-performance' ? 'Bidder performance' : 'Performance overview'}
            </h1>
          </div>
        </header>
        <div className="dashboard-content">
          {evidenceTitle && (
            <div className="evidence-view-banner" role="status">
              <Icon name="evidence" />
              <span>
                Evidence for: <strong>{evidenceTitle}</strong>
              </span>
              <button className="text-button" onClick={() => setEvidenceTitle(null)}>
                Explore freely
              </button>
            </div>
          )}
          <Dashboard
            auth={auth}
            view={view}
            onViewChange={applyView}
            onUnauthorized={onUnauthorized}
          />
        </div>
      </section>
      {!agentOpen && (
        <button
          className="agent-launcher"
          onClick={() => {
            setEvidenceTitle(null);
            setAgentOpen(true);
          }}
          aria-label="Open agent"
        >
          <Icon name="chat" /> Ask agent
        </button>
      )}
      {agentOpen && (
        <aside className="agent-slot" id="agent-panel" aria-label="Investigation agent">
          <div
            className="agent-resize-handle"
            role="separator"
            tabIndex={0}
            aria-label="Resize agent panel"
            aria-orientation="vertical"
            aria-controls="agent-panel"
            aria-valuemin={320}
            aria-valuemax={Math.max(320, Math.min(640, window.innerWidth - 496))}
            aria-valuenow={agentWidth}
            title="Drag to resize · Arrow keys adjust width"
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              event.currentTarget.focus();
              drag.current = { x: event.clientX, width: agentWidth, pointerId: event.pointerId };
              event.currentTarget.setPointerCapture(event.pointerId);
              setResizing(true);
            }}
            onPointerMove={(event) => {
              if (drag.current?.pointerId !== event.pointerId) return;
              setAgentWidth(panelWidth(drag.current.width + drag.current.x - event.clientX));
            }}
            onPointerUp={() => {
              drag.current = null;
              setResizing(false);
            }}
            onPointerCancel={() => {
              drag.current = null;
              setResizing(false);
            }}
            onLostPointerCapture={() => {
              drag.current = null;
              setResizing(false);
            }}
            onDoubleClick={() => setAgentWidth(panelWidth(Math.round(window.innerWidth * 0.3)))}
            onKeyDown={(event) => {
              const delta = event.key === 'ArrowLeft' ? 24 : event.key === 'ArrowRight' ? -24 : 0;
              if (delta || event.key === 'Home' || event.key === 'End') {
                event.preventDefault();
                setAgentWidth((width) =>
                  panelWidth(
                    event.key === 'Home' ? 320 : event.key === 'End' ? 640 : width + delta,
                  ),
                );
              }
            }}
          />
          <Chat
            onUnauthorized={onUnauthorized}
            onClose={() => {
              setEvidenceTitle(null);
              setAgentOpen(false);
            }}
            onConversationChange={() => setEvidenceTitle(null)}
            onShowEvidence={showEvidence}
          />
        </aside>
      )}
    </div>
  );
}
