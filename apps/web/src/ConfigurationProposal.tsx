import { useEffect, useState } from 'react';
import { ConfigurationWorkspaceSchema } from '@bid/shared';
import type { ConfigurationWorkspace } from '@bid/shared';
import { api, ApiError } from './api.js';
import { ConfigurationDiff } from './ConfigurationEditor.js';
import './configuration.css';

/** Saved chat contains only an ID; never treat a transcript's pending status as authority. */
export function ConfigurationProposal({
  proposalId,
  onUnauthorized,
}: {
  proposalId: string;
  onUnauthorized?: (() => void) | undefined;
}) {
  const [workspace, setWorkspace] = useState<ConfigurationWorkspace | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    const updated = () => setRefresh((value) => value + 1);
    window.addEventListener('configuration-updated', updated);
    return () => window.removeEventListener('configuration-updated', updated);
  }, []);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError('');
    void api('/api/configurations/workspace', ConfigurationWorkspaceSchema)
      .then((value) => {
        if (!disposed) setWorkspace(value);
      })
      .catch((cause: unknown) => {
        if (disposed) return;
        if (cause instanceof ApiError && cause.status === 401) onUnauthorized?.();
        setError(cause instanceof Error ? cause.message : 'Could not load draft proposal status.');
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [proposalId, refresh]);

  const proposal = workspace?.proposal?.proposalId === proposalId ? workspace.proposal : null;

  async function decide(decision: 'approve' | 'reject') {
    if (!workspace || !proposal || proposal.status !== 'pending') return;
    setBusy(true);
    setError('');
    try {
      const result = await api(
        '/api/configurations/proposal/decision',
        ConfigurationWorkspaceSchema,
        {
          proposalId,
          expectedRevision: workspace.revision,
          decision,
        },
      );
      setWorkspace(result);
      window.dispatchEvent(new Event('configuration-updated'));
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) onUnauthorized?.();
      setError(cause instanceof Error ? cause.message : 'Could not apply this decision.');
      // Re-read after a conflict, but retain its explanation until explicit retry.
      const latest = await api('/api/configurations/workspace', ConfigurationWorkspaceSchema).catch(
        () => null,
      );
      if (latest) setWorkspace(latest);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="configuration-proposal" aria-label="Configuration draft proposal">
      <h3>Review draft update</h3>
      {loading ? (
        <p role="status">Checking proposal status…</p>
      ) : proposal ? (
        <>
          <p>{proposal.rationale}</p>
          <p className="hint">
            This updates the one shared draft only. Publishing is a separate human action;
            performance is unverified.
          </p>
          <ConfigurationDiff before={proposal.before} after={proposal.after} />
          <p>
            Status:{' '}
            <strong>
              {proposal.status === 'approved' ? 'Draft updated — not published' : proposal.status}
            </strong>
          </p>
          {proposal.status === 'pending' && (
            <div className="configuration-actions">
              <button disabled={busy || !!error} onClick={() => void decide('approve')}>
                Update draft
              </button>
              <button
                className="secondary"
                disabled={busy || !!error}
                onClick={() => void decide('reject')}
              >
                Reject
              </button>
            </div>
          )}
        </>
      ) : (
        <p>This proposal is no longer current. Review the latest shared draft instead.</p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!loading && (
        <button
          className="text-button"
          disabled={busy}
          onClick={() => setRefresh((value) => value + 1)}
        >
          Refresh status
        </button>
      )}
    </section>
  );
}
