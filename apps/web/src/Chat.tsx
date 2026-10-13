import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ConversationDetailSchema, ConversationListSchema, ConversationSchema } from '@bid/shared';
import type { AuthResponse, Conversation, SavedTurn, StreamEvent } from '@bid/shared';
import { api, ApiError, requestId as newRequestId, streamTurn } from './api.js';
import { CitedAnswer, ToolResults } from './ToolResults.js';

function initialConversation(): string | null {
  const value = new URLSearchParams(window.location.hash.slice(1)).get('conversation');

  return value && /^[a-f0-9-]{36}$/.test(value) ? value : null;
}

export function Chat({ auth, onUnauthorized }: { auth: AuthResponse; onUnauthorized: () => void }) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [listCursor, setListCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(initialConversation);
  const [turns, setTurns] = useState<SavedTurn[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [live, setLive] = useState<SavedTurn | null>(null);
  const [busy, setBusy] = useState(false);
  const active = useRef<{ controller: AbortController; conversationId: string; turnId: string | null } | null>(null);

  useEffect(() => () => { active.current?.controller.abort(); }, []);

  function failed(cause: unknown) {
    if (cause instanceof ApiError && cause.status === 401) onUnauthorized();
    else setError(cause instanceof Error ? cause.message : 'The investigation is unavailable.');
  }

  async function loadList(cursor?: string) {
    const page = await api(`/api/conversations${cursor ? `?cursor=${cursor}` : ''}`, ConversationListSchema);
    setConversations((old) => cursor ? [...old, ...page.conversations] : page.conversations);
    setListCursor(page.nextCursor);
  }

  async function reload(id: string, cursor?: string) {
    const page = await api(`/api/conversations/${id}${cursor ? `?cursor=${cursor}` : ''}`, ConversationDetailSchema);
    setTurns((old) => cursor ? [...page.turns, ...old] : page.turns);
    setHistoryCursor(page.nextCursor);
  }

  useEffect(() => {
    void loadList().catch(failed);
  }, []);

  useEffect(() => {
    if (!selected) return;
    let disposed = false;
    setLoading(true);
    setError('');
    window.history.replaceState(null, '', `#conversation=${selected}`);

    void api(`/api/conversations/${selected}`, ConversationDetailSchema).then((page) => {
      if (!disposed) { setTurns(page.turns); setHistoryCursor(page.nextCursor); }
    }).catch((cause: unknown) => { if (!disposed) failed(cause); }).finally(() => { if (!disposed) setLoading(false); });

    return () => { disposed = true; };
  }, [selected]);

  async function newChat() {
    setLoading(true);
    setError('');

    try {
      const conversation = await api('/api/conversations', ConversationSchema, {});
      setConversations((old) => [conversation, ...old]);
      setTurns([]);
      setSelected(conversation.id);
    } catch (cause) {
      failed(cause);
    } finally {
      setLoading(false);
    }
  }

  function streamEvent(event: StreamEvent) {
    if (event.type === 'turn-start' && active.current) active.current.turnId = event.turnId;
    if (event.type === 'turn-error') setError(event.error.message);

    setLive((turn) => {
      if (!turn) return turn;
      if (event.type === 'turn-start') return { ...turn, id: event.turnId };
      if (event.type === 'text-reset') return { ...turn, text: '' };
      if (event.type === 'text-delta') return { ...turn, text: turn.text + event.text };
      if (event.type === 'tool-start') return { ...turn, tools: [...turn.tools.filter((tool) => tool.toolCallId !== event.toolCallId),
        { toolCallId: event.toolCallId, name: event.toolName, argumentsJson: event.argumentsJson ?? '{}', result: null, errorCode: null }] };
      if (event.type === 'tool-result') return { ...turn, tools: turn.tools.map((tool) => tool.toolCallId === event.toolCallId ? { ...tool, result: event.result } : tool) };
      if (event.type === 'tool-error') return { ...turn, tools: turn.tools.map((tool) => tool.toolCallId === event.toolCallId ? { ...tool, errorCode: event.error.code } : tool) };
      if (event.type === 'turn-complete') return { ...turn, status: 'completed' };
      if (event.type === 'turn-cancelled') return { ...turn, status: 'cancelled', errorCode: 'CANCELLED' };
      if (event.type === 'turn-error') return { ...turn, status: 'error', errorCode: event.error.code };
      return turn;
    });
  }

  async function investigate(resume?: SavedTurn) {
    if (!selected || active.current || loading) return;
    const text = resume?.input ?? message.trim();
    if (!text || new TextEncoder().encode(text).length > 8192) {
      setError('Enter a question up to 8192 bytes.');
      return;
    }

    const controller = new AbortController();
    const requestId = newRequestId();
    const conversationId = selected;
    active.current = { controller, conversationId, turnId: resume?.id ?? null };
    setBusy(true);
    setError('');
    setLive({ id: resume?.id ?? requestId, input: text, text: '', status: 'running', errorCode: null,
      createdAt: new Date().toISOString(), tools: resume?.tools ?? [] });
    if (!resume) setMessage('');

    try {
      await streamTurn(resume ? `/api/conversations/${conversationId}/turns/${resume.id}/resume` : `/api/conversations/${conversationId}/turns`,
        conversationId, resume ? {} : { requestId, message: text }, controller.signal, streamEvent);
    } catch (cause) {
      if (!controller.signal.aborted) failed(cause);
    } finally {
      active.current = null;
      setBusy(false);
      try {
        await reload(conversationId);
        await loadList();
        setLive(null);
      } catch (cause) {
        failed(cause);
        setLive((turn) => turn ? { ...turn, status: 'interrupted' } : null);
      }
    }
  }

  async function stop(turn?: SavedTurn) {
    const current = active.current;
    const id = turn?.id ?? current?.turnId;
    const conversationId = current?.conversationId ?? selected;
    if (!id || !conversationId) return;

    try {
      const response = await fetch(`/api/conversations/${conversationId}/turns/${id}/cancel`, { method: 'POST',
        credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error('The turn could not be stopped. Reload its status.');
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

  const displayTurns = live ? [...turns.filter((turn) => turn.id !== live.id), live] : turns;
  const blocked = turns.some((turn) => turn.status === 'running' || turn.status === 'interrupted');

  return <div className="chat-layout">
    <aside className="status-panel conversations" aria-labelledby="conversations-heading">
      <h2 id="conversations-heading">Saved investigations</h2>
      <button type="button" onClick={() => void newChat()} disabled={loading || busy}>New chat</button>
      {!conversations.length && <p className="hint">No conversations yet.</p>}
      <ul>{conversations.map((conversation) => <li key={conversation.id}>
        <button type="button" className="secondary" aria-current={selected === conversation.id ? 'page' : undefined}
          onClick={() => setSelected(conversation.id)} disabled={loading || busy}>{conversation.title}</button>
      </li>)}</ul>
      {listCursor && <button type="button" className="secondary" onClick={() => void loadList(listCursor).catch(failed)}>More conversations</button>}
    </aside>
    <section className="status-panel investigation" aria-labelledby="chat-heading">
      <h2 id="chat-heading">Read-only investigation</h2>
      <p className="hint">Demo data · {auth.availablePeriod.startDate} to {auth.availablePeriod.endDate} UTC · Estimated revenue</p>
      {error && <p className="error" role="alert">{error}</p>}
      {loading && <p role="status">Loading saved conversation…</p>}
      {!selected && <p>Start a new chat or select a saved investigation.</p>}
      {historyCursor && selected && <button className="secondary" onClick={() => void reload(selected, historyCursor).catch(failed)}>Older messages</button>}
      {selected && <button type="button" className="secondary" disabled={loading || busy} onClick={() => void reload(selected).catch(failed)}>Reload saved status</button>}
      <div className="messages">{displayTurns.map((turn) => <article key={turn.id} className="turn">
        <h3>You</h3><p className="message-text">{turn.input}</p>
        <h3>Investigation · {turn.status}</h3>
        {turn.status !== 'completed' && <p className="hint">Incomplete / provisional — not a validated final finding.{turn.errorCode ? ` ${turn.errorCode}` : ''}</p>}
        {turn.text ? <CitedAnswer turn={turn} /> : <p>No answer saved yet.</p>}
        <ToolResults turnId={turn.id} tools={turn.tools} />
        {turn.status === 'interrupted' && !busy && <div className="actions">
          <button onClick={() => void investigate(turn)}>Resume investigation</button><button className="secondary" onClick={() => void stop(turn)}>Cancel interrupted turn</button>
        </div>}
        {turn.status === 'running' && !busy && <button className="secondary" onClick={() => void stop(turn)}>Cancel active turn</button>}
      </article>)}</div>
      {selected && <form className="composer" onSubmit={submit}>
        <label htmlFor="question">Ask about your auction performance</label>
        <textarea id="question" rows={3} value={message} onChange={(event) => setMessage(event.target.value)} maxLength={8192}
          disabled={busy || loading || blocked} placeholder="What changed in my performance?" required />
        <div className="actions">
          <button type="submit" disabled={busy || loading || blocked || !message.trim()}>Investigate</button>
          {busy && <button type="button" className="secondary" onClick={() => void stop()} disabled={!active.current?.turnId}>Stop</button>}
          {busy && <span role="status">Investigating… responses are provisional until evidence is validated.</span>}
        </div>
      </form>}
    </section>
  </div>;
}
