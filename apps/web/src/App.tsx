import { useEffect, useState } from 'react';

type Status = 'checking' | 'ready' | 'unavailable';

const REQUEST_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 15_000;

export function App() {
  const [status, setStatus] = useState<Status>('checking');
  const [retry, setRetry] = useState(0);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);

  useEffect(() => {
    let disposed = false;
    let activeRequest: AbortController | undefined;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;

    async function check() {
      const controller = new AbortController();
      activeRequest = controller;
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const response = await fetch('/api/health/ready', {
          signal: controller.signal,
          cache: 'no-store',
          headers: { Accept: 'application/json' },
        });

        if (!response.ok) throw new Error('API not ready');

        // A successful response must be JSON, not an SPA fallback or proxy error page.
        const payload: unknown = await response.json();

        if (!payload || typeof payload !== 'object' || !('status' in payload) || payload.status !== 'ready') {
          throw new Error('API readiness response is invalid');
        }

        if (!disposed) setStatus('ready');
      } catch {
        if (!disposed) setStatus('unavailable');
      } finally {
        clearTimeout(timeout);

        if (!disposed) {
          setCheckedAt(new Date());
          pollTimer = setTimeout(() => {
            void check();
          }, POLL_INTERVAL_MS);
        }
      }
    }

    setStatus('checking');
    void check();

    return () => {
      disposed = true;
      activeRequest?.abort();
      clearTimeout(pollTimer);
    };
  }, [retry]);

  const message = status === 'ready'
    ? 'API and database resources are ready.'
    : status === 'checking'
      ? 'Checking API and database readiness…'
      : 'API is unavailable or its database resources are not ready.';

  return (
    <main className="foundation">
      <p className="eyebrow">Local development · Phase 0</p>
      <h1>Bid Intelligence</h1>
      <p className="intro">The shared foundation is in place. Publisher login, chat, and investigation tools will arrive in Phase 1.</p>
      <section className="status-panel" aria-labelledby="status-heading">
        <h2 id="status-heading">Foundation status</h2>
        <p className={`status status-${status}`} role="status" aria-live="polite" aria-atomic="true">
          <span className="status-label">{status === 'ready' ? 'Ready' : status === 'checking' ? 'Checking' : 'Unavailable'}</span>
          <span>{message}</span>
        </p>
        {status === 'unavailable' && <p className="hint">Check the API and DynamoDB containers, then retry. This page checks again automatically every 15 seconds.</p>}
        <div className="actions">
          <button type="button" onClick={() => setRetry((value) => value + 1)} disabled={status === 'checking'}>
            {status === 'checking' ? 'Checking…' : 'Check again'}
          </button>
          {checkedAt && <p className="last-check">Last checked <time dateTime={checkedAt.toISOString()}>{checkedAt.toLocaleTimeString()}</time></p>}
        </div>
      </section>
      <p className="scope">No publisher data is loaded. Synthetic earnings in later phases will be labeled estimated revenue.</p>
    </main>
  );
}
