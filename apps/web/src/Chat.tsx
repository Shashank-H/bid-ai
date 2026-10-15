import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { ConversationDetailSchema, ConversationListSchema, ConversationSchema } from '@bid/shared';
import type { AuthResponse, Conversation, SavedTurn, StreamEvent } from '@bid/shared';
import { api, ApiError, requestId as newRequestId, streamTurn } from './api.js';
import { CitedAnswer, ToolResults } from './ToolResults.js';
import { Icon } from './Icon.js';

function initialConversation(): string | null {
  const value = new URLSearchParams(window.location.hash.slice(1)).get('conversation');

  return value && /^[a-f0-9-]{36}$/.test(value) ? value : null;
}

function HistoryTitle({ title }: { title: string }) {
  const viewport = useRef<HTMLSpanElement>(null);
  const text = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const container = viewport.current;
    const label = text.current;
    if (!container || !label) return;

    const measure = () => {
      const overflow = Math.max(0, label.scrollWidth - container.clientWidth);
      container.dataset.overflow = String(overflow > 0);
      container.style.setProperty('--title-shift', `${-overflow}px`);
      container.style.setProperty('--title-duration', `${Math.max(4, overflow / 30 + 2)}s`);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    measure();
    void document.fonts.ready.then(() => {
      if (container.isConnected) measure();
    });

    return () => observer.disconnect();
  }, [title]);

  return (
    <span className="history-title" ref={viewport}>
      <span ref={text}>{title}</span>
    </span>
  );
}

export function Chat({
  auth,
  onUnauthorized,
  onLogout,
}: {
  auth: AuthResponse;
  onUnauthorized: () => void;
  onLogout: () => void;
}) {
  const [historyCollapsed, setHistoryCollapsed] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [listCursor, setListCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(initialConversation);
  const [turns, setTurns] = useState<SavedTurn[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(Boolean(selected));
  const [message, setMessage] = useState('');
  const [live, setLive] = useState<SavedTurn | null>(null);
  const [busy, setBusy] = useState(false);
  const active = useRef<{
    controller: AbortController;
    conversationId: string | null;
    turnId: string | null;
  } | null>(null);
  const createdConversation = useRef<string | null>(null);
  const pendingRequest = useRef<{ conversationId: string; text: string; requestId: string } | null>(
    null,
  );
  const historyPanel = useRef<HTMLDetailsElement>(null);
  const activityPanel = useRef<HTMLDetailsElement>(null);
  const chatScroll = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const historyScroll = useRef<{ height: number; top: number } | null>(null);
  const question = useRef<HTMLTextAreaElement>(null);
  const desktop = window.matchMedia('(min-width: 1101px)').matches;

  useEffect(
    () => () => {
      active.current?.controller.abort();
    },
    [],
  );

  useEffect(() => {
    const media = window.matchMedia('(min-width: 1101px)');
    const update = () => {
      if (historyPanel.current) historyPanel.current.open = media.matches;
      if (activityPanel.current) activityPanel.current.open = media.matches;
    };
    media.addEventListener('change', update);

    return () => media.removeEventListener('change', update);
  }, []);

  useLayoutEffect(() => {
    const scroll = chatScroll.current;
    const previous = historyScroll.current;
    if (scroll && previous) {
      scroll.scrollTop = previous.top + scroll.scrollHeight - previous.height;
      historyScroll.current = null;
    }
  }, [turns]);

  useEffect(() => {
    const scroll = chatScroll.current;
    if (scroll && followLatest.current) scroll.scrollTop = scroll.scrollHeight;
  }, [live?.text, live?.tools.length, turns.length]);

  useEffect(() => {
    if (!question.current) return;
    question.current.style.height = 'auto';
    question.current.style.height = `${Math.min(question.current.scrollHeight, 220)}px`;
  }, [message]);

  function failed(cause: unknown) {
    if (cause instanceof ApiError && cause.status === 401) onUnauthorized();
    else setError(cause instanceof Error ? cause.message : 'The chat is unavailable.');
  }

  async function loadList(cursor?: string) {
    const page = await api(
      `/api/conversations${cursor ? `?cursor=${cursor}` : ''}`,
      ConversationListSchema,
    );
    setConversations((old) => (cursor ? [...old, ...page.conversations] : page.conversations));
    setListCursor(page.nextCursor);
  }

  async function reload(id: string, cursor?: string) {
    const page = await api(
      `/api/conversations/${id}${cursor ? `?cursor=${cursor}` : ''}`,
      ConversationDetailSchema,
    );
    if (cursor && chatScroll.current) {
      historyScroll.current = {
        height: chatScroll.current.scrollHeight,
        top: chatScroll.current.scrollTop,
      };
      followLatest.current = false;
    }
    setTurns((old) => (cursor ? [...page.turns, ...old] : page.turns));
    setHistoryCursor(page.nextCursor);
  }

  useEffect(() => {
    void loadList().catch(failed);
  }, []);

  useEffect(() => {
    if (!selected) return;
    window.history.replaceState(null, '', `#conversation=${selected}`);
    if (createdConversation.current === selected) {
      createdConversation.current = null;
      return;
    }

    let disposed = false;
    setLoading(true);
    setError('');

    void api(`/api/conversations/${selected}`, ConversationDetailSchema)
      .then((page) => {
        if (!disposed) {
          setTurns(page.turns);
          setHistoryCursor(page.nextCursor);
        }
      })
      .catch((cause: unknown) => {
        if (!disposed) failed(cause);
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });

    return () => {
      disposed = true;
    };
  }, [selected]);

  function newChat() {
    if (active.current) return;
    followLatest.current = true;
    setSelected(null);
    setTurns([]);
    setLive(null);
    setHistoryCursor(null);
    setMessage('');
    setError('');
    setLoading(false);
    pendingRequest.current = null;
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    if (!desktop && historyPanel.current) historyPanel.current.open = false;
    question.current?.focus();
  }

  function selectConversation(id: string) {
    if (active.current || loading || id === selected) return;
    followLatest.current = true;
    setLoading(true);
    setTurns([]);
    setLive(null);
    setHistoryCursor(null);
    setMessage('');
    pendingRequest.current = null;
    setSelected(id);
    if (!desktop && historyPanel.current) historyPanel.current.open = false;
  }

  function streamEvent(event: StreamEvent) {
    if (event.type === 'turn-start' && active.current) {
      active.current.turnId = event.turnId;
      if (pendingRequest.current) setMessage('');
      pendingRequest.current = null;
      void loadList().catch(failed);
    }
    if (event.type === 'turn-error') setError(event.error.message);

    setLive((turn) => {
      if (!turn) return turn;
      if (event.type === 'turn-start') return { ...turn, id: event.turnId };
      if (event.type === 'text-reset') return { ...turn, text: '' };
      if (event.type === 'text-delta') return { ...turn, text: turn.text + event.text };
      if (event.type === 'tool-start')
        return {
          ...turn,
          tools: [
            ...turn.tools.filter((tool) => tool.toolCallId !== event.toolCallId),
            {
              toolCallId: event.toolCallId,
              name: event.toolName,
              argumentsJson: event.argumentsJson ?? '{}',
              result: null,
              errorCode: null,
            },
          ],
        };
      if (event.type === 'tool-result')
        return {
          ...turn,
          tools: turn.tools.map((tool) =>
            tool.toolCallId === event.toolCallId ? { ...tool, result: event.result } : tool,
          ),
        };
      if (event.type === 'tool-error')
        return {
          ...turn,
          tools: turn.tools.map((tool) =>
            tool.toolCallId === event.toolCallId ? { ...tool, errorCode: event.error.code } : tool,
          ),
        };
      if (event.type === 'turn-complete') return { ...turn, status: 'completed' };
      if (event.type === 'turn-cancelled')
        return { ...turn, status: 'cancelled', errorCode: 'CANCELLED' };
      if (event.type === 'turn-error')
        return { ...turn, status: 'error', errorCode: event.error.code };
      return turn;
    });
  }

  async function investigate(resume?: SavedTurn) {
    if (
      active.current ||
      loading ||
      (!resume && turns.some((turn) => turn.status === 'running' || turn.status === 'interrupted'))
    )
      return;
    const text = resume?.input ?? message.trim();
    if (!text || new TextEncoder().encode(text).length > 8192) {
      setError('Enter a message up to 8192 bytes.');
      return;
    }

    const controller = new AbortController();
    const savedIds = new Set(turns.map((turn) => turn.id));
    let conversationId = selected;
    active.current = { controller, conversationId, turnId: resume?.id ?? null };
    setBusy(true);
    setError('');

    try {
      if (!conversationId) {
        const conversation = await api('/api/conversations', ConversationSchema, {});
        if (controller.signal.aborted) return;
        conversationId = conversation.id;
        active.current!.conversationId = conversationId;
        createdConversation.current = conversationId;
        setSelected(conversationId);
      }

      const previous = pendingRequest.current;
      const requestId =
        previous?.conversationId === conversationId && previous.text === text
          ? previous.requestId
          : newRequestId();
      if (!resume) pendingRequest.current = { conversationId, text, requestId };
      followLatest.current = true;
      setLive({
        id: resume?.id ?? requestId,
        input: text,
        text: '',
        status: 'running',
        errorCode: null,
        createdAt: new Date().toISOString(),
        tools: resume?.tools ?? [],
      });

      await streamTurn(
        resume
          ? `/api/conversations/${conversationId}/turns/${resume.id}/resume`
          : `/api/conversations/${conversationId}/turns`,
        conversationId,
        resume ? {} : { requestId, message: text },
        controller.signal,
        streamEvent,
      );
    } catch (cause) {
      if (!controller.signal.aborted) failed(cause);
    } finally {
      if (conversationId && !controller.signal.aborted) {
        try {
          const page = await api(`/api/conversations/${conversationId}`, ConversationDetailSchema);
          setTurns(page.turns);
          setHistoryCursor(page.nextCursor);
          if (
            pendingRequest.current &&
            page.turns.some((turn) => !savedIds.has(turn.id) && turn.input === text)
          ) {
            setMessage('');
            pendingRequest.current = null;
          }
          setLive(null);
          await loadList();
        } catch (cause) {
          failed(cause);
          setLive((turn) =>
            turn && active.current?.turnId ? { ...turn, status: 'interrupted' } : null,
          );
        }
      } else if (conversationId) {
        try {
          await reload(conversationId);
          setLive(null);
        } catch (cause) {
          failed(cause);
        }
      }
      active.current = null;
      setBusy(false);
      question.current?.focus();
    }
  }

  async function stop(turn?: SavedTurn) {
    const current = active.current;
    const id = turn?.id ?? current?.turnId;
    const conversationId = current?.conversationId ?? selected;
    if (!id || !conversationId) return;

    try {
      const response = await fetch(`/api/conversations/${conversationId}/turns/${id}/cancel`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error('The response could not be stopped. Reload its status.');
      current?.controller.abort();
      if (!current) await reload(conversationId);
    } catch (cause) {
      failed(cause);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void investigate();
  }

  function composerKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void investigate();
    }
  }

  const displayTurns = live ? [...turns.filter((turn) => turn.id !== live.id), live] : turns;
  const blocked = displayTurns.some(
    (turn) => turn.status === 'running' || turn.status === 'interrupted',
  );
  const currentConversation = conversations.find((conversation) => conversation.id === selected);
  const toolTurns = displayTurns.filter((turn) => turn.tools.length);

  return (
    <div className={`chat-layout${historyCollapsed ? ' history-collapsed' : ''}`}>
      <details
        id="chat-history"
        className="side-panel history-panel"
        ref={historyPanel}
        open={desktop}
      >
        <summary className="panel-toggle">
          <Icon name="chat" />
          Chat history
        </summary>
        <div className="side-panel-body">
          <div className="history-top">
            <span className="brand">
              Bid Intelligence<span className="brand-dot">.</span>
            </span>
          </div>
          <nav className="workspace-nav" aria-label="Workspace">
            <button
              type="button"
              className="new-chat secondary"
              aria-label="New"
              title="New chat"
              onClick={newChat}
              disabled={loading || busy}
            >
              <Icon name="compose" />
              <span className="nav-label">New</span>
            </button>
            <button
              type="button"
              className="rail-history secondary"
              aria-label="Show chat history"
              title="Chat history"
              onClick={() => setHistoryCollapsed(false)}
            >
              <Icon name="chat" />
            </button>
          </nav>
          <nav className="history-list" aria-label="Chat history">
            {!conversations.length && (
              <p className="hint">Your chats will appear here after you send a message.</p>
            )}
            <ul>
              {conversations.map((conversation) => (
                <li key={conversation.id}>
                  <button
                    type="button"
                    className="history-item"
                    aria-current={selected === conversation.id ? 'page' : undefined}
                    onClick={() => selectConversation(conversation.id)}
                    disabled={loading || busy}
                    title={conversation.title}
                  >
                    <HistoryTitle title={conversation.title} />
                  </button>
                </li>
              ))}
            </ul>
            {listCursor && (
              <button
                type="button"
                className="text-button"
                disabled={loading || busy}
                onClick={() => void loadList(listCursor).catch(failed)}
              >
                More chats
              </button>
            )}
          </nav>
          <div className="account">
            <span className="account-login">{auth.user.login}</span>
            <span className="hint">{auth.publisherId}</span>
            <button
              type="button"
              className="text-button"
              aria-label="Log out"
              title="Log out"
              onClick={onLogout}
              disabled={busy}
            >
              <Icon name="logout" />
              <span className="nav-label">Log out</span>
            </button>
          </div>
        </div>
      </details>
      <section className="chat-panel" aria-labelledby="chat-heading">
        <header className="chat-header">
          <div className="chat-heading-group">
            <button
              type="button"
              className="history-collapse secondary"
              aria-label={historyCollapsed ? 'Show chat history' : 'Hide chat history'}
              aria-expanded={!historyCollapsed}
              aria-controls="chat-history"
              onClick={() => setHistoryCollapsed((collapsed) => !collapsed)}
              title={historyCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              <Icon name="panel" />
            </button>
            <h1 id="chat-heading">{currentConversation?.title ?? 'New chat'}</h1>
          </div>
          <span className="hint">Read-only</span>
        </header>
        <div
          className="chat-scroll"
          ref={chatScroll}
          onScroll={(event) => {
            const scroll = event.currentTarget;
            followLatest.current =
              scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 96;
          }}
        >
          <div className="messages">
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            {loading && (
              <p className="loading-message" role="status">
                Loading chat…
              </p>
            )}
            {!loading && !displayTurns.length && (
              <div className="empty-chat">
                <h2>What would you like to explore?</h2>
                <p>
                  Ask about your auction performance. Answers are grounded in your publisher’s data.
                </p>
              </div>
            )}
            {historyCursor && selected && (
              <button
                className="text-button"
                disabled={loading || busy}
                onClick={() => void reload(selected, historyCursor).catch(failed)}
              >
                Older messages
              </button>
            )}
            {displayTurns.map((turn) => (
              <article key={turn.id} className="turn">
                <div className="user-message">
                  <h2 className="sr-only">You</h2>
                  <p className="message-text">{turn.input}</p>
                </div>
                <div className="assistant-message">
                  <h2 className="message-role">Assistant</h2>
                  {turn.text ? (
                    <CitedAnswer turn={turn} />
                  ) : (
                    <p className="hint" role={turn.status === 'running' ? 'status' : undefined}>
                      {turn.status === 'running' ? 'Thinking…' : 'No answer saved.'}
                    </p>
                  )}
                  {turn.status !== 'completed' && (
                    <p className="turn-status">
                      {turn.status === 'running'
                        ? 'Working · response is provisional'
                        : `${turn.status} · incomplete response`}
                      {turn.errorCode ? ` · ${turn.errorCode}` : ''}
                    </p>
                  )}
                  {turn.status === 'interrupted' && !busy && (
                    <div className="actions">
                      <button onClick={() => void investigate(turn)}>Resume</button>
                      <button className="secondary" onClick={() => void stop(turn)}>
                        Cancel response
                      </button>
                    </div>
                  )}
                  {turn.status === 'running' && !busy && (
                    <button className="secondary" onClick={() => void stop(turn)}>
                      Cancel response
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        </div>
        <div className="composer-area">
          <form className="composer" onSubmit={submit}>
            <label htmlFor="question" className="sr-only">
              Message Bid Intelligence
            </label>
            <textarea
              ref={question}
              id="question"
              rows={2}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={composerKey}
              maxLength={8192}
              disabled={busy || loading || blocked}
              placeholder="Ask about your auction performance…"
              required
              aria-describedby="composer-hint"
            />
            <div className="composer-controls">
              <span className="composer-key-hint">Shift + Enter for a new line</span>
              <div className="composer-buttons">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void stop()}
                  disabled={!busy || !active.current?.turnId}
                  aria-label="Stop"
                  title="Stop response"
                >
                  <Icon name="stop" />
                </button>
                <button
                  type="submit"
                  disabled={busy || loading || blocked || !message.trim()}
                  aria-label="Send"
                  title="Send message"
                >
                  <Icon name="send" />
                </button>
              </div>
            </div>
          </form>
          <p className="composer-note" id="composer-hint">
            {busy
              ? 'Working. Responses are provisional until evidence is validated.'
              : 'Demo data · Check the supporting evidence before relying on an answer.'}
          </p>
        </div>
      </section>
      <details className="side-panel activity-panel" ref={activityPanel} open={desktop}>
        <summary className="panel-toggle">
          <Icon name="activity" />
          Activity & evidence
        </summary>
        <div className="side-panel-body">
          <header className="activity-header">
            <h2>
              <Icon name="activity" />
              Activity
            </h2>
            {selected && (
              <button
                type="button"
                className="text-button"
                disabled={loading || busy}
                onClick={() => void reload(selected).catch(failed)}
                aria-label="Refresh"
                title="Refresh activity"
              >
                <Icon name="refresh" />
              </button>
            )}
          </header>
          <div className="activity-scroll">
            {!toolTurns.length && (
              <div className="activity-empty">
                <p>No tool activity yet.</p>
                <p className="hint">
                  Tool calls and supporting evidence will appear here as the assistant works.
                </p>
              </div>
            )}
            {toolTurns.map((turn, index) => (
              <section
                key={turn.id}
                className="activity-turn"
                aria-label={`Tool activity for message ${index + 1}`}
              >
                <p className="activity-question" title={turn.input}>
                  {turn.input}
                </p>
                <ToolResults turnId={turn.id} tools={turn.tools} />
              </section>
            ))}
          </div>
          <details className="data-context">
            <summary>
              <Icon name="database" />
              Data context
            </summary>
            <p className="hint">
              {auth.availablePeriod
                ? `${auth.availablePeriod.startDate} to ${auth.availablePeriod.endDate} UTC`
                : auth.status === 'loading'
                  ? 'Dataset loading; observations are not yet available.'
                  : 'No dataset available.'}
            </p>
            {auth.observedFrom && auth.observedThrough && (
              <p className="hint">
                Observation bounds: {auth.observedFrom} to {auth.observedThrough}.
              </p>
            )}
            {!!auth.partialDates?.length && (
              <p className="hint">
                Partial UTC dates: {auth.partialDates.join(', ')}. Weekly comparisons use complete
                dates only.
              </p>
            )}
            <p className="hint">
              Synthetic demo data. Earnings are estimated revenue. Tools cannot change configuration
              or deploy to your website.
            </p>
          </details>
        </div>
      </details>
    </div>
  );
}
