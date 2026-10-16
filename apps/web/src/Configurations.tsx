import { useEffect, useState } from 'react';
import { ConfigurationVersionPageSchema, ConfigurationWorkspaceSchema } from '@bid/shared';
import type { AuthResponse, ConfigurationVersionPage, ConfigurationWorkspace } from '@bid/shared';
import { api, ApiError } from './api.js';
import { ConfigurationEditor } from './ConfigurationEditor.js';
import { ConfigurationVersion } from './ConfigurationVersion.js';
import './configuration.css';

export type ConfigurationRoute =
  { kind: 'list' } | { kind: 'draft' } | { kind: 'version'; versionId: string };
export function configurationRoute(path: string): ConfigurationRoute | null {
  if (path === '/configurations' || path === '/configurations/') return { kind: 'list' };
  if (path === '/configurations/draft') return { kind: 'draft' };
  const match = /^\/configurations\/versions\/([^/]+)$/.exec(path);
  if (!match) return null;
  try {
    const versionId = decodeURIComponent(match[1]!);
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(versionId) ||
      !Number.isFinite(Date.parse(versionId))
    )
      return null;
    return { kind: 'version', versionId };
  } catch {
    return null;
  }
}

export function Configurations({
  route,
  auth,
  onNavigate,
  onUnauthorized,
  onDirtyChange,
}: {
  route: ConfigurationRoute;
  auth: AuthResponse;
  onNavigate: (path: string) => void;
  onUnauthorized: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [workspace, setWorkspace] = useState<ConfigurationWorkspace | null>(null);
  const [page, setPage] = useState<ConfigurationVersionPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const routeKey = route.kind === 'version' ? route.versionId : route.kind;
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void Promise.all([
      api(
        '/api/configurations/workspace',
        ConfigurationWorkspaceSchema,
        undefined,
        controller.signal,
      ),
      route.kind === 'list'
        ? api(
            '/api/configurations/versions?limit=20',
            ConfigurationVersionPageSchema,
            undefined,
            controller.signal,
          )
        : Promise.resolve(null),
    ])
      .then(([state, versions]) => {
        if (controller.signal.aborted) return;
        setWorkspace(state);
        setPage(versions);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiError && cause.status === 401) onUnauthorized();
        else setError(cause instanceof Error ? cause.message : 'Configurations are unavailable.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [routeKey, retry]);

  useEffect(() => {
    const controller = new AbortController();
    function refreshWorkspace() {
      void api(
        '/api/configurations/workspace',
        ConfigurationWorkspaceSchema,
        undefined,
        controller.signal,
      )
        .then((next) => {
          if (!controller.signal.aborted)
            setWorkspace((old) => (!old || next.revision >= old.revision ? next : old));
        })
        .catch((cause: unknown) => {
          if (controller.signal.aborted) return;
          if (cause instanceof ApiError && cause.status === 401) onUnauthorized();
          else
            setError(
              cause instanceof Error ? cause.message : 'Shared draft could not be refreshed.',
            );
        });
    }
    window.addEventListener('configuration-updated', refreshWorkspace);
    return () => {
      controller.abort();
      window.removeEventListener('configuration-updated', refreshWorkspace);
    };
  }, []);

  async function loadMore() {
    if (!page?.nextCursor) return;
    setLoadingMore(true);
    setError('');
    try {
      const next = await api(
        `/api/configurations/versions?limit=20&cursor=${encodeURIComponent(page.nextCursor)}`,
        ConfigurationVersionPageSchema,
      );
      setPage((old) =>
        old ? { versions: [...old.versions, ...next.versions], nextCursor: next.nextCursor } : next,
      );
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) onUnauthorized();
      else setError(cause instanceof Error ? cause.message : 'More versions could not be loaded.');
    } finally {
      setLoadingMore(false);
    }
  }
  if (loading) return <p role="status">Loading configurations…</p>;
  if (!workspace)
    return (
      <section>
        <p role="alert" className="error">
          {error || 'Configuration is unavailable.'}
        </p>
        <button type="button" className="secondary" onClick={() => setRetry((value) => value + 1)}>
          Try again
        </button>
      </section>
    );
  return (
    <div className="configurations">
      {route.kind === 'draft' ? (
        <ConfigurationEditor
          workspace={workspace}
          auth={auth}
          onWorkspace={setWorkspace}
          onPublished={(publication) =>
            onNavigate(`/configurations/versions/${encodeURIComponent(publication.versionId)}`)
          }
          onUnauthorized={onUnauthorized}
          onDirtyChange={onDirtyChange}
        />
      ) : route.kind === 'version' ? (
        <ConfigurationVersion
          versionId={route.versionId}
          workspace={workspace}
          onNavigate={onNavigate}
          onWorkspace={setWorkspace}
          onUnauthorized={onUnauthorized}
        />
      ) : (
        <>
          <div className="configuration-heading">
            <div>
              <h2>Current configuration</h2>
              <p className="hint">
                Published versions are immutable. Work together in one shared draft.
              </p>
            </div>
            <button type="button" onClick={() => onNavigate('/configurations/draft')}>
              Edit draft
            </button>
          </div>
          {workspace.current ? (
            <section className="configuration-current">
              <p>
                <strong>{workspace.current.publishedAt}</strong>
              </p>
              <p className="hint">
                Author: {workspace.current.authorUserId}
                {workspace.current.coauthor ? ' · Coauthor: Agent' : ''}
              </p>
              <dl>
                <div>
                  <dt>Global banner floor</dt>
                  <dd>${workspace.current.settings.floorCpm.toFixed(2)} CPM</dd>
                </div>
                <div>
                  <dt>Auction timeout</dt>
                  <dd>{workspace.current.settings.auctionTimeoutMs} ms</dd>
                </div>
                <div>
                  <dt>Enabled bidders</dt>
                  <dd>{workspace.current.settings.enabledBidders.join(', ')}</dd>
                </div>
              </dl>
              <button
                type="button"
                className="secondary"
                onClick={() =>
                  onNavigate(
                    `/configurations/versions/${encodeURIComponent(workspace.current!.versionId)}`,
                  )
                }
              >
                Open current version
              </button>
            </section>
          ) : (
            <p role="status">No published configuration is available.</p>
          )}
          {workspace.draft && (
            <p className="configuration-notice">
              Shared draft saved by {workspace.draft.updatedByUserId}
              {workspace.draft.agentContributed ? ' · Agent contributed' : ''}. It has not been
              published.
            </p>
          )}
          <section className="configuration-section">
            <h2>Published history</h2>
            {page?.versions.length ? (
              <div className="configuration-history">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Published (UTC)</th>
                      <th scope="col">Author</th>
                      <th scope="col">Coauthor</th>
                      <th scope="col">Version</th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.versions.map((version) => (
                      <tr key={version.versionId}>
                        <th scope="row">
                          <button
                            type="button"
                            className="text-button"
                            onClick={() =>
                              onNavigate(
                                `/configurations/versions/${encodeURIComponent(version.versionId)}`,
                              )
                            }
                          >
                            {version.publishedAt}
                          </button>
                        </th>
                        <td>{version.authorUserId}</td>
                        <td>{version.coauthor ? 'Agent' : '—'}</td>
                        <td>
                          {workspace.current?.versionId === version.versionId
                            ? 'Current'
                            : version.source === 'seed'
                              ? 'Synthetic seed'
                              : 'Published'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="hint">Published configurations will appear here.</p>
            )}
            {page?.nextCursor && (
              <button
                type="button"
                className="secondary"
                disabled={loadingMore}
                onClick={() => void loadMore()}
              >
                {loadingMore ? 'Loading…' : 'Load more versions'}
              </button>
            )}
          </section>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
        </>
      )}
    </div>
  );
}
