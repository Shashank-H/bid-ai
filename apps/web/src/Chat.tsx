import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { ConversationDetailSchema, ConversationListSchema, ConversationSchema } from '@bid/shared';
import type { Conversation, DashboardView, SavedTurn, StreamEvent } from '@bid/shared';
import { api, ApiError, requestId as newRequestId, streamTurn } from './api.js';
import { AgentActivity, CitedAnswer, ToolResults } from './ToolResults.js';
import { Icon } from './Icon.js';
import './agent-panel.css';

export function Chat({
  onUnauthorized,
  onClose,
  onConversationChange,
  onShowEvidence,
}: {
  onUnauthorized: () => void;
  onClose: () => void;
  onConversationChange?: () => void;
  onShowEvidence?: (view: DashboardView, title: string) => void;
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [listCursor, setListCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [turns, setTurns] = useState<SavedTurn[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [live, setLive] = useState<SavedTurn | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const selectedId = useRef<string | null>(null);
  const generation = useRef(0);
  const active = useRef<{
    controller: AbortController;
    conversationId: string | null;
    turnId: string | null;
  } | null>(null);
  const createdConversation = useRef<string | null>(null);
  const pendingRequest = useRef<{ conversationId: string; text: string; requestId: string } | null>(
    null,
  );
  const chatScroll = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const historyScroll = useRef<{ height: number; top: number } | null>(null);
  const question = useRef<HTMLTextAreaElement>(null);
  const historyButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    mounted.current = true;
    window.history.replaceState(null, '', window.location.pathname + window.location.search);

    return () => {
      mounted.current = false;
      generation.current++;
      // Detach the browser stream only. The server completes and persists accepted work.
      active.current?.controller.abort();
    };
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
    question.current.style.height = `${Math.min(question.current.scrollHeight, 180)}px`;
  }, [message]);

  function failed(cause: unknown) {
    if (!mounted.current) return;
    if (cause instanceof ApiError && cause.status === 401) onUnauthorized();
    else setError(cause instanceof Error ? cause.message : 'The chat is unavailable.');
  }

  async function loadList(cursor?: string) {
    const page = await api(
      `/api/conversations${cursor ? `?cursor=${cursor}` : ''}`,
      ConversationListSchema,
    );
    if (!mounted.current) return;
    setConversations((old) => (cursor ? [...old, ...page.conversations] : page.conversations));
    setListCursor(page.nextCursor);
  }

  async function reload(id: string, cursor?: string, preserveHistory = false) {
    const epoch = generation.current;
    const page = await api(
      `/api/conversations/${id}${cursor ? `?cursor=${cursor}` : ''}`,
      ConversationDetailSchema,
    );
    if (!mounted.current || epoch !== generation.current || selectedId.current !== id) return;
    if (cursor && chatScroll.current) {
      historyScroll.current = {
        height: chatScroll.current.scrollHeight,
        top: chatScroll.current.scrollTop,
      };
      followLatest.current = false;
    }
    setTurns((old) => {
      if (preserveHistory) {
        const refreshed = new Set(page.turns.map((turn) => turn.id));
        return [...old.filter((turn) => !refreshed.has(turn.id)), ...page.turns].sort((a, b) =>
          a.createdAt.localeCompare(b.createdAt),
        );
      }
      return cursor ? [...page.turns, ...old] : page.turns;
    });
    if (!preserveHistory) setHistoryCursor(page.nextCursor);
    if (preserveHistory) {
      setLive(null);
      setError('');
    }
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
    void reload(selected)
      .catch((cause: unknown) => {
        if (!disposed) failed(cause);
      })
      .finally(() => {
        if (!disposed && mounted.current) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [selected]);

  // A restored conversation can still be running after its original browser stream closed.
  const hasRunningTurn =
    live?.status === 'running' || turns.some((turn) => turn.status === 'running');
  useEffect(() => {
    if (!selected || busy || !hasRunningTurn) return;
    const timer = window.setInterval(() => {
      void reload(selected, undefined, true).catch(failed);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [selected, busy, hasRunningTurn]);

  function detach() {
    generation.current++;
    active.current?.controller.abort();
    active.current = null;
    setBusy(false);
    pendingRequest.current = null;
  }

  function newChat() {
    detach();
    followLatest.current = true;
    selectedId.current = null;
    setSelected(null);
    setTurns([]);
    setLive(null);
    setHistoryCursor(null);
    setMessage('');
    setError('');
    setLoading(false);
    setHistoryOpen(false);
    onConversationChange?.();
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    question.current?.focus();
  }

  function selectConversation(id: string) {
    setHistoryOpen(false);
    if (id === selected) return;
    detach();
    followLatest.current = true;
    selectedId.current = id;
    setLoading(true);
    setTurns([]);
    setLive(null);
    setHistoryCursor(null);
    setMessage('');
    setSelected(id);
    onConversationChange?.();
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
    const operation = {
      controller: new AbortController(),
      conversationId: selected,
      turnId: resume?.id ?? null,
    };
    active.current = operation;
    const attached = () => mounted.current && active.current === operation;
    const savedIds = new Set(turns.map((turn) => turn.id));
    setBusy(true);
    setError('');
    try {
      if (!operation.conversationId) {
        const conversation = await api('/api/conversations', ConversationSchema, {});
        if (!attached()) return;
        operation.conversationId = conversation.id;
        selectedId.current = conversation.id;
        createdConversation.current = conversation.id;
        setSelected(conversation.id);
      }
      const conversationId = operation.conversationId;
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
        operation.controller.signal,
        (event) => {
          if (attached()) streamEvent(event);
        },
      );
    } catch (cause) {
      if (attached() && !operation.controller.signal.aborted) failed(cause);
    } finally {
      if (attached()) {
        if (operation.conversationId) {
          try {
            const page = await api(
              `/api/conversations/${operation.conversationId}`,
              ConversationDetailSchema,
            );
            if (attached()) {
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
            }
          } catch (cause) {
            if (attached()) {
              failed(cause);
              // A broken transport does not mean the backend interrupted its work.
              // Keep provisional state until polling retrieves the authoritative status.
              setLive((turn) => (turn && operation.turnId ? { ...turn, status: 'running' } : null));
            }
          }
        }
        if (attached()) {
          active.current = null;
          setBusy(false);
          question.current?.focus();
        }
      }
    }
  }

  async function stop(turn?: SavedTurn) {
    const epoch = generation.current;
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
      if (epoch === generation.current) failed(cause);
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

  return (
    <section
      className="agent-chat chat-panel"
      aria-labelledby="chat-heading"
      onKeyDown={(event) => {
        if (historyOpen && event.key === 'Escape') {
          setHistoryOpen(false);
          historyButton.current?.focus();
        }
      }}
    >
      <header className="chat-header agent-header">
        <button
          ref={historyButton}
          type="button"
          className="secondary agent-icon-button"
          aria-label={historyOpen ? 'Back to chat' : 'Chat history'}
          aria-expanded={historyOpen}
          aria-controls="agent-history"
          onClick={() => {
            setHistoryOpen((open) => !open);
            if (!historyOpen) void loadList().catch(failed);
          }}
        >
          <span aria-hidden="true">{historyOpen ? '←' : '☰'}</span>
        </button>
        <div className="agent-heading">
          <span className="hint">Investigation assistant</span>
          <h1 id="chat-heading">
            {historyOpen ? 'Chat history' : (currentConversation?.title ?? 'New chat')}
          </h1>
        </div>
        <button
          type="button"
          className="secondary agent-icon-button"
          aria-label="New chat"
          title="New chat"
          onClick={newChat}
        >
          <Icon name="compose" />
        </button>
        <button
          type="button"
          className="secondary agent-icon-button"
          aria-label="Close agent panel"
          title="Close agent panel"
          onClick={onClose}
        >
          <span aria-hidden="true">→</span>
        </button>
      </header>
      {historyOpen && (
        <nav className="agent-history-menu" id="agent-history" aria-label="Chat history">
          <div className="agent-history-heading">
            <h2>Recent conversations</h2>
          </div>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
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
                  title={conversation.title}
                >
                  {conversation.title}
                </button>
              </li>
            ))}
          </ul>
          {listCursor && (
            <button
              type="button"
              className="text-button"
              onClick={() => void loadList(listCursor).catch(failed)}
            >
              More chats
            </button>
          )}
        </nav>
      )}
      <div
        className="chat-scroll"
        hidden={historyOpen}
        ref={chatScroll}
        onScroll={(event) => {
          const scroll = event.currentTarget;
          followLatest.current = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 96;
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
              <Icon name="chat" />
              <h2>What would you like to explore?</h2>
              <p>
                Ask about your publisher’s performance. Open supporting data in the dashboard when
                you need it.
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
                <AgentActivity turn={turn} />
                {turn.text ? (
                  <CitedAnswer turn={turn} />
                ) : (
                  turn.status !== 'running' && <p className="hint">No answer saved.</p>
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
                  <div className="actions">
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => {
                        if (selected) void reload(selected).catch(failed);
                      }}
                    >
                      Refresh response
                    </button>
                    <button className="secondary" onClick={() => void stop(turn)}>
                      Cancel response
                    </button>
                  </div>
                )}
                {!!turn.tools.length && (
                  <ToolResults
                    turnId={turn.id}
                    tools={turn.tools}
                    onShowEvidence={onShowEvidence}
                  />
                )}
              </div>
            </article>
          ))}
        </div>
      </div>
      <div className="composer-area" hidden={historyOpen}>
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
            ? 'Working. Closing this panel will not cancel the investigation.'
            : 'Synthetic data · Estimated revenue · Read-only assistant'}
        </p>
      </div>
    </section>
  );
}
