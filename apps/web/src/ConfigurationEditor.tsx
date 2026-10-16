import { useEffect, useState } from 'react';
import {
  ConfigurationPublicationSchema,
  ConfigurationWorkspaceSchema,
  PrebidConfigurationSchema,
  getGlobalBannerFloor,
  getSlotFloorOverride,
  renameSlotFloorOverride,
  setGlobalBannerFloor,
  setSlotFloorOverride,
} from '@bid/shared';
import type {
  AuthResponse,
  ConfigurationPublication,
  ConfigurationWorkspace,
  PrebidConfiguration,
} from '@bid/shared';
import { api, ApiError, requestId } from './api.js';

export function configurationChanges(
  before: unknown,
  after: unknown,
  path = '',
): { path: string; before: unknown; after: unknown }[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (
    before !== null &&
    after !== null &&
    typeof before === 'object' &&
    typeof after === 'object'
  ) {
    const left = before as Record<string, unknown>;
    const right = after as Record<string, unknown>;
    return [...new Set([...Object.keys(left), ...Object.keys(right)])].flatMap((key) =>
      configurationChanges(left[key], right[key], path ? `${path}.${key}` : key),
    );
  }
  return [{ path: path || 'configuration', before, after }];
}

export function ConfigurationDiff({ before, after }: { before: unknown; after: unknown }) {
  const changes = configurationChanges(before, after);
  return changes.length ? (
    <div className="configuration-diff">
      <table>
        <caption>Changes compared with the selected baseline</caption>
        <thead>
          <tr>
            <th>Setting</th>
            <th>Before</th>
            <th>After</th>
          </tr>
        </thead>
        <tbody>
          {changes.map((change) => (
            <tr key={change.path}>
              <th scope="row">
                <code>{change.path}</code>
              </th>
              <td>
                <code>{JSON.stringify(change.before) ?? 'Not set'}</code>
              </td>
              <td>
                <code>{JSON.stringify(change.after) ?? 'Not set'}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <p className="hint">No changes from this baseline.</p>
  );
}

export function ConfigurationEditor({
  workspace,
  auth,
  onWorkspace,
  onPublished,
  onUnauthorized,
  onDirtyChange,
}: {
  workspace: ConfigurationWorkspace;
  auth: AuthResponse;
  onWorkspace: (workspace: ConfigurationWorkspace) => void;
  onPublished: (publication: ConfigurationPublication) => void;
  onUnauthorized: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const source = workspace.draft?.prebid ?? workspace.current?.prebid;
  const [text, setText] = useState(() => JSON.stringify(source, null, 2) ?? '');
  const [savedText, setSavedText] = useState(() => JSON.stringify(source, null, 2) ?? '');
  const [baseRevision, setBaseRevision] = useState(workspace.revision);
  const [formDocument, setFormDocument] = useState(source);
  const [editingJson, setEditingJson] = useState(false);
  const [tab, setTab] = useState<'form' | 'json'>('form');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [publishRequestId, setPublishRequestId] = useState<string | null>(null);
  const sourceText = JSON.stringify(source, null, 2) ?? '';
  const dirty = text !== savedText;
  const conflict = baseRevision !== workspace.revision;
  let parsed: ReturnType<typeof PrebidConfigurationSchema.safeParse>;
  try {
    parsed = PrebidConfigurationSchema.safeParse(JSON.parse(text));
  } catch {
    parsed = PrebidConfigurationSchema.safeParse(null);
  }
  const document = formDocument;
  const formDisabled = busy || (editingJson && !parsed.success);
  const validJson = (() => {
    try {
      JSON.parse(text);
      return true;
    } catch {
      return false;
    }
  })();

  useEffect(() => {
    if (dirty && baseRevision !== workspace.revision) {
      setError(
        'The shared draft changed while you were editing. Your local edits are preserved. Copy them before reloading the shared draft.',
      );
      setConfirming(false);
      return;
    }
    setText(sourceText);
    setSavedText(sourceText);
    setFormDocument(source);
    setEditingJson(false);
    setBaseRevision(workspace.revision);
    setConfirming(false);
    setPublishRequestId(null);
  }, [workspace.revision]);
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);

  function change(update: (next: PrebidConfiguration) => void) {
    if (!document) return;
    const next = structuredClone(document);
    update(next);
    setFormDocument(next);
    setEditingJson(false);
    setText(JSON.stringify(next, null, 2));
    setConfirming(false);
    setPublishRequestId(null);
    setStatus('');
  }
  function failed(cause: unknown) {
    if (cause instanceof ApiError && cause.status === 401) onUnauthorized();
    else setError(cause instanceof Error ? cause.message : 'Configuration could not be saved.');
  }
  async function reloadDraft() {
    if (dirty && !window.confirm('Discard your local edits and load the latest shared draft?'))
      return;
    setBusy(true);
    setError('');
    try {
      const next = await api('/api/configurations/workspace', ConfigurationWorkspaceSchema);
      const latest = JSON.stringify(next.draft?.prebid ?? next.current?.prebid, null, 2) ?? '';
      setText(latest);
      setSavedText(latest);
      setFormDocument(next.draft?.prebid ?? next.current?.prebid);
      setEditingJson(false);
      setBaseRevision(next.revision);
      setConfirming(false);
      setPublishRequestId(null);
      onWorkspace(next);
      setStatus('Latest shared draft loaded.');
    } catch (cause) {
      failed(cause);
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!parsed.success || conflict) return;
    setBusy(true);
    setError('');
    setStatus('');
    try {
      const result = await api(
        '/api/configurations/draft',
        ConfigurationWorkspaceSchema,
        { expectedRevision: baseRevision, prebid: parsed.data },
        undefined,
        'PUT',
      );
      const latest = JSON.stringify(result.draft?.prebid, null, 2);
      setText(latest);
      setSavedText(latest);
      setFormDocument(result.draft?.prebid);
      setEditingJson(false);
      setBaseRevision(result.revision);
      onWorkspace(result);
      setStatus('Shared draft saved. Published configuration is unchanged.');
    } catch (cause) {
      failed(cause);
    } finally {
      setBusy(false);
    }
  }
  async function publish() {
    if (!workspace.draft || dirty || conflict) return;
    setBusy(true);
    setError('');
    const id = publishRequestId ?? requestId();
    setPublishRequestId(id);
    try {
      const publication = await api('/api/configurations/publish', ConfigurationPublicationSchema, {
        expectedRevision: baseRevision,
        expectedCurrentVersionId: workspace.current?.versionId ?? null,
        requestId: id,
      });
      onDirtyChange(false);
      onPublished(publication);
    } catch (cause) {
      failed(cause);
    } finally {
      setBusy(false);
    }
  }

  if (!source) return <p role="status">No supported configuration is available to edit.</p>;
  return (
    <div className="configuration-editor">
      <div className="configuration-heading">
        <div>
          <h2>Shared draft</h2>
          <p className="hint">One draft for everyone in this publisher. Saving does not publish.</p>
        </div>
        <span className="configuration-badge">
          {dirty ? 'Unsaved edits' : workspace.draft ? 'Saved draft' : 'Based on current'}
        </span>
      </div>
      {workspace.draft && (
        <p className="hint">
          Last edited by {workspace.draft.updatedByUserId} · {workspace.draft.updatedAt}
          {workspace.draft.agentContributed ? ' · Agent contributed' : ''}
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}{' '}
          {error.includes('changed') || error.includes('stale')
            ? 'Reload the draft before trying again.'
            : ''}
        </p>
      )}
      {(error || conflict) && (
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => void reloadDraft()}
        >
          Reload shared draft
        </button>
      )}
      {status && (
        <p role="status" className="configuration-notice">
          {status}
        </p>
      )}
      <div
        className="configuration-tabs"
        role="tablist"
        aria-label="Configuration editor"
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const next =
            event.key === 'Home'
              ? 'form'
              : event.key === 'End'
                ? 'json'
                : tab === 'form'
                  ? 'json'
                  : 'form';
          setTab(next);
          (
            event.currentTarget.querySelector(
              `[data-editor-tab="${next}"]`,
            ) as HTMLButtonElement | null
          )?.focus();
        }}
      >
        <button
          type="button"
          className="secondary"
          role="tab"
          data-editor-tab="form"
          tabIndex={tab === 'form' ? 0 : -1}
          aria-selected={tab === 'form'}
          onClick={() => setTab('form')}
        >
          Form
        </button>
        <button
          type="button"
          className="secondary"
          role="tab"
          data-editor-tab="json"
          tabIndex={tab === 'json' ? 0 : -1}
          aria-selected={tab === 'json'}
          onClick={() => setTab('json')}
        >
          JSON
        </button>
      </div>
      {!parsed.success && (
        <div className="error" role="alert">
          <strong>
            {validJson
              ? 'Configuration validation failed'
              : 'Invalid JSON: correct the document in the JSON tab.'}
          </strong>
          {validJson && (
            <ul>
              {parsed.error.issues.slice(0, 12).map((issue, index) => (
                <li key={index}>
                  {issue.path.map(String).join('.') || 'configuration'}: {issue.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {tab === 'json' ? (
        <label className="configuration-json-label">
          Supported Prebid JSON
          <textarea
            className="configuration-json"
            spellCheck={false}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setEditingJson(true);
              try {
                const next = PrebidConfigurationSchema.safeParse(JSON.parse(event.target.value));
                if (next.success) setFormDocument(next.data);
              } catch {
                /* Keep the raw JSON and the last editable form document. */
              }
              setConfirming(false);
              setPublishRequestId(null);
              setStatus('');
            }}
            disabled={busy}
          />
        </label>
      ) : document ? (
        <div className="configuration-form">
          <fieldset disabled={formDisabled}>
            <legend>Auction and floors</legend>
            <div className="configuration-fields">
              <label>
                Banner floor (USD CPM)
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="0.01"
                  value={
                    Number.isNaN(getGlobalBannerFloor(document))
                      ? ''
                      : getGlobalBannerFloor(document)
                  }
                  onChange={(e) =>
                    change((next) => {
                      setGlobalBannerFloor(next, e.target.valueAsNumber);
                    })
                  }
                />
              </label>
              <label>
                Unmatched-rule fallback (USD CPM)
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="0.01"
                  value={
                    Number.isNaN(document.setConfig.floors.data.default)
                      ? ''
                      : document.setConfig.floors.data.default
                  }
                  onChange={(e) =>
                    change((next) => {
                      next.setConfig.floors.data.default = e.target.valueAsNumber;
                    })
                  }
                />
              </label>
              <label>
                Default timeout (ms)
                <input
                  type="number"
                  min="100"
                  max="10000"
                  value={
                    Number.isNaN(document.setConfig.bidderTimeout)
                      ? ''
                      : document.setConfig.bidderTimeout
                  }
                  onChange={(e) =>
                    change((next) => {
                      next.setConfig.bidderTimeout = e.target.valueAsNumber;
                    })
                  }
                />
              </label>
              <label>
                Request timeout override (ms)
                <input
                  type="number"
                  min="100"
                  max="10000"
                  placeholder="Use default"
                  value={document.requestBids.timeout ?? ''}
                  onChange={(e) =>
                    change((next) => {
                      if (e.target.value === '') delete next.requestBids.timeout;
                      else next.requestBids.timeout = e.target.valueAsNumber;
                    })
                  }
                />
              </label>
              <label>
                Floor skip rate (%)
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={
                    Number.isNaN(document.setConfig.floors.skipRate)
                      ? ''
                      : document.setConfig.floors.skipRate
                  }
                  onChange={(e) =>
                    change((next) => {
                      next.setConfig.floors.skipRate = e.target.valueAsNumber;
                    })
                  }
                />
              </label>
              <label>
                Price granularity
                <select
                  value={document.setConfig.priceGranularity}
                  onChange={(e) =>
                    change((next) => {
                      next.setConfig.priceGranularity = e.target
                        .value as PrebidConfiguration['setConfig']['priceGranularity'];
                    })
                  }
                >
                  {['low', 'medium', 'high', 'auto', 'dense'].map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="configuration-checkboxes">
              <label>
                <input
                  type="checkbox"
                  checked={document.setConfig.floors.enabled}
                  onChange={(e) =>
                    change((next) => {
                      next.setConfig.floors.enabled = e.target.checked;
                    })
                  }
                />
                Enable floors
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={document.setConfig.floors.enforcement.enforceJS}
                  onChange={(e) =>
                    change((next) => {
                      next.setConfig.floors.enforcement.enforceJS = e.target.checked;
                    })
                  }
                />
                Enforce client-side floors
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={document.setConfig.enableSendAllBids}
                  onChange={(e) =>
                    change((next) => {
                      next.setConfig.enableSendAllBids = e.target.checked;
                    })
                  }
                />
                Send all bids
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={document.setConfig.debug}
                  onChange={(e) =>
                    change((next) => {
                      next.setConfig.debug = e.target.checked;
                    })
                  }
                />
                Debug
              </label>
            </div>
          </fieldset>
          {document.adUnits.map((unit, unitIndex) => (
            <fieldset key={unitIndex} disabled={formDisabled}>
              <legend>Ad unit: {unit.code}</legend>
              <div className="configuration-fields">
                <label>
                  Ad unit code
                  <input
                    value={unit.code}
                    onChange={(e) =>
                      change((next) => {
                        const code = e.target.value;

                        if (
                          code === '*' ||
                          code.includes('|') ||
                          next.adUnits.some(
                            (other, index) => index !== unitIndex && other.code === code,
                          )
                        )
                          return;

                        renameSlotFloorOverride(next, next.adUnits[unitIndex]!.code, code);
                        next.adUnits[unitIndex]!.code = code;
                      })
                    }
                  />
                </label>
                {unit.mediaTypes.banner.sizes.map((size, sizeIndex) => (
                  <div className="configuration-size" key={sizeIndex}>
                    <label>
                      Width {sizeIndex + 1}
                      <input
                        type="number"
                        min="1"
                        max="10000"
                        value={Number.isNaN(size[0]) ? '' : size[0]}
                        onChange={(e) =>
                          change((next) => {
                            next.adUnits[unitIndex]!.mediaTypes.banner.sizes[sizeIndex]![0] =
                              e.target.valueAsNumber;
                          })
                        }
                      />
                    </label>
                    <label>
                      Height {sizeIndex + 1}
                      <input
                        type="number"
                        min="1"
                        max="10000"
                        value={Number.isNaN(size[1]) ? '' : size[1]}
                        onChange={(e) =>
                          change((next) => {
                            next.adUnits[unitIndex]!.mediaTypes.banner.sizes[sizeIndex]![1] =
                              e.target.valueAsNumber;
                          })
                        }
                      />
                    </label>
                  </div>
                ))}
              </div>
              <div className="configuration-checkboxes">
                {document.mockAdapters.map((adapter) => (
                  <label key={adapter.bidder}>
                    <input
                      type="checkbox"
                      checked={unit.bids.some((bid) => bid.bidder === adapter.bidder)}
                      disabled={unit.bids.length === 1 && unit.bids[0]?.bidder === adapter.bidder}
                      onChange={(e) =>
                        change((next) => {
                          const bids = next.adUnits[unitIndex]!.bids;
                          next.adUnits[unitIndex]!.bids = e.target.checked
                            ? [
                                ...bids,
                                {
                                  bidder: adapter.bidder,
                                  params: {
                                    placementId: unit.bids[0]?.params.placementId ?? unit.code,
                                  },
                                },
                              ]
                            : bids.filter((bid) => bid.bidder !== adapter.bidder);
                        })
                      }
                    />
                    {adapter.bidder}
                  </label>
                ))}
              </div>
              <details className="configuration-overrides">
                <summary>
                  Slot overrides
                  <span className="configuration-override-status">
                    {getSlotFloorOverride(document, unit.code) === undefined
                      ? 'Using global floor'
                      : `Floor: ${getSlotFloorOverride(document, unit.code)} USD CPM`}
                  </span>
                </summary>
                <div className="configuration-fields">
                  <label>
                    Slot floor override (USD CPM)
                    <input
                      type="number"
                      min="0"
                      max="100"
                      step="0.01"
                      placeholder={`Inherit ${getGlobalBannerFloor(document)} USD CPM`}
                      value={getSlotFloorOverride(document, unit.code) ?? ''}
                      onChange={(e) =>
                        change((next) => {
                          setSlotFloorOverride(
                            next,
                            next.adUnits[unitIndex]!.code,
                            e.target.value === '' ? undefined : e.target.valueAsNumber,
                          );
                        })
                      }
                    />
                    <span className="hint">Leave blank to use the global banner floor.</span>
                  </label>
                </div>
              </details>
              <p className="hint">
                Effective slot floor:{' '}
                {getSlotFloorOverride(document, unit.code) ?? getGlobalBannerFloor(document)} USD
                CPM. Global floor enablement, skip rate and enforcement still apply. Adapter
                parameters, extra sizes and supported advanced fields are available in JSON.
              </p>
            </fieldset>
          ))}
        </div>
      ) : (
        <p className="hint">
          Open JSON to correct validation errors. Your document has not been discarded.
        </p>
      )}
      <section className="configuration-section">
        <h3>Diff against published current</h3>
        {parsed.success ? (
          <ConfigurationDiff before={workspace.current?.prebid} after={parsed.data} />
        ) : (
          <p className="hint">A valid document is needed to show the diff.</p>
        )}
      </section>
      <div className="configuration-actions">
        <button
          type="button"
          disabled={busy || conflict || !parsed.success || (!dirty && !!workspace.draft)}
          onClick={() => void save()}
        >
          {busy && !confirming ? 'Saving…' : 'Save draft'}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={busy || conflict || dirty || !workspace.draft}
          onClick={() => setConfirming(true)}
        >
          Publish
        </button>
      </div>
      {dirty && <p className="hint">Save your edits before publishing.</p>}
      {confirming && (
        <section className="configuration-confirm" role="region" aria-label="Confirm publication">
          <h3>Publish this saved draft?</h3>
          <p>
            Author: <strong>{auth.user.userId}</strong>
            {workspace.draft?.agentContributed && (
              <>
                {' '}
                · Coauthor: <strong>Agent</strong>
              </>
            )}
          </p>
          <p>
            Performance is unverified. This updates stored configuration only; it does not deploy to
            a live website.
          </p>
          <details>
            <summary>Exact saved configuration to publish</summary>
            <pre>{JSON.stringify(workspace.draft?.prebid, null, 2)}</pre>
          </details>
          <div className="configuration-actions">
            <button type="button" disabled={busy} onClick={() => void publish()}>
              {busy ? 'Publishing…' : 'Confirm publish'}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
