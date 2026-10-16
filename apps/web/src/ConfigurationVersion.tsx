import { useEffect, useState } from 'react';
import { ConfigurationPublicationSchema, ConfigurationWorkspaceSchema } from '@bid/shared';
import type { ConfigurationPublication, ConfigurationWorkspace } from '@bid/shared';
import { api, ApiError } from './api.js';
import { ConfigurationDiff } from './ConfigurationEditor.js';

export function ConfigurationVersion({
  versionId,
  workspace,
  onNavigate,
  onWorkspace,
  onUnauthorized,
}: {
  versionId: string;
  workspace: ConfigurationWorkspace;
  onNavigate: (path: string) => void;
  onWorkspace: (workspace: ConfigurationWorkspace) => void;
  onUnauthorized: () => void;
}) {
  const [version, setVersion] = useState<ConfigurationPublication | null>(null);
  const [previous, setPrevious] = useState<ConfigurationPublication | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setVersion(null);
    setPrevious(null);
    void api(
      `/api/configurations/versions/${encodeURIComponent(versionId)}`,
      ConfigurationPublicationSchema,
      undefined,
      controller.signal,
    )
      .then(async (result) => {
        if (controller.signal.aborted) return;
        setVersion(result);
        if (result.previousVersionId) {
          const baseline = await api(
            `/api/configurations/versions/${encodeURIComponent(result.previousVersionId)}`,
            ConfigurationPublicationSchema,
            undefined,
            controller.signal,
          );
          if (!controller.signal.aborted) setPrevious(baseline);
        }
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiError && cause.status === 401) onUnauthorized();
        else setError(cause instanceof Error ? cause.message : 'Version could not be loaded.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [versionId]);

  async function useAsDraft() {
    if (
      !version ||
      !window.confirm(
        'Replace the shared draft with this published configuration? Existing saved draft work will be replaced. Publishing will still be a separate action.',
      )
    )
      return;
    setBusy(true);
    setError('');
    try {
      const result = await api(
        '/api/configurations/draft',
        ConfigurationWorkspaceSchema,
        {
          expectedRevision: workspace.revision,
          prebid: version.prebid,
          sourceVersionId: version.versionId,
        },
        undefined,
        'PUT',
      );
      onWorkspace(result);
      onNavigate('/configurations/draft');
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) onUnauthorized();
      else setError(cause instanceof Error ? cause.message : 'Shared draft could not be updated.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="configuration-version">
      <button type="button" className="text-button" onClick={() => onNavigate('/configurations')}>
        ← Published history
      </button>
      {loading && <p role="status">Loading published version…</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {version && (
        <>
          <div className="configuration-heading">
            <div>
              <h2>Published {version.publishedAt}</h2>
              <p className="hint">
                Author: {version.authorUserId}
                {version.coauthor ? ' · Coauthor: Agent' : ''}
                {version.source === 'seed' ? ' · Synthetic seed' : ''}
              </p>
            </div>
            <span className="configuration-badge">
              {workspace.current?.versionId === version.versionId
                ? 'Current'
                : 'Published · read-only'}
            </span>
          </div>
          <button
            type="button"
            className="secondary"
            disabled={busy || loading}
            onClick={() => void useAsDraft()}
          >
            {busy ? 'Updating draft…' : 'Use as draft'}
          </button>
          <section className="configuration-section">
            <h3>Diff against previous publication</h3>
            {previous ? (
              <ConfigurationDiff before={previous.prebid} after={version.prebid} />
            ) : (
              <p className="hint">
                {version.previousVersionId
                  ? 'Previous publication is unavailable.'
                  : 'Initial configuration; no previous publication.'}
              </p>
            )}
          </section>
          <section className="configuration-section">
            <h3>Published Prebid document</h3>
            <pre className="configuration-document">{JSON.stringify(version.prebid, null, 2)}</pre>
          </section>
        </>
      )}
    </div>
  );
}
