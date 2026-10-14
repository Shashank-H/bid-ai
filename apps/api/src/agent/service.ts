import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import type { StreamEvent } from '@bid/shared';
import type { TracingRuntime } from '../observability/tracing.js';
import type { UserPublisherContext } from '../domain/interfaces.js';
import type { AuthorizedRequest, Authorization } from '../auth/authorization.js';
import type { ConversationRepository } from '../db/conversations.js';
import { HttpError } from '../errors.js';
import { buildAgentGraph } from './graph.js';
import type { ModelStep } from './graph.js';
import { initialState } from './state.js';
import type { State } from './state.js';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { FencedPostgresSaver } from './checkpointer.js';
import { investigationPrompt } from './prompt.js';
import { validateAnswer } from './evidence.js';
import { ConfigurationError, readAgentSettings } from '../env.js';
import { reportFailure } from '../observability/diagnostics.js';

export type AcceptedTurn = Awaited<ReturnType<ConversationRepository['accept']>>;
export type ModelContext = { conversationId: string; turnId: string; correlationId: string; publisherId: string };
export type ModelRunner = (state: State, signal: AbortSignal, emit: (text: string) => void, context?: ModelContext) => Promise<ModelStep>;

export class AgentService {
  private readonly saver: PostgresSaver;
  private readonly saverPool: pg.Pool;
  private readonly active = new Map<string, { userId: string; controller: AbortController; visible: () => string }>();

  constructor(readonly conversations: ConversationRepository, private readonly authorization: Authorization,
    private readonly model: ModelRunner, private readonly tracing: TracingRuntime,
    private readonly settings = readAgentSettings()) {
    this.saverPool = new pg.Pool({ connectionString: conversations.postgres.pool.options.connectionString, max: 5,
      connectionTimeoutMillis: 2500, idleTimeoutMillis: 10_000, statement_timeout: 5000, query_timeout: 6000 });
    this.saverPool.on('error', () => {});
    this.saver = new PostgresSaver(this.saverPool, undefined, { schema: 'agent_checkpoints' });
  }

  async prepare(auth: AuthorizedRequest, conversationId: string, input: { requestId: string; message: string } | { resumeId: string }) {
    if ('resumeId' in input) {
      const config = await this.conversations.checkpointConfig(auth.identity, conversationId);
      const saved = await this.saver.getTuple(config);

      if (!saved || saved.checkpoint.channel_values['turnId'] !== input.resumeId) {
        throw new HttpError(409, 'CONFLICT', 'This turn has no recoverable checkpoint.');
      }
    }

    return this.conversations.accept(auth.identity, conversationId, input);
  }

  async cancel(identity: UserPublisherContext, conversationId: string, turnId: string) {
    await this.conversations.turn(identity, conversationId, turnId);
    const local = this.active.get(turnId);
    await this.conversations.cancel(identity, conversationId, turnId, local?.visible());
    local?.controller.abort('STOP');

    return { cancelled: true };
  }

  cancelUser(userId: string) {
    for (const active of this.active.values()) if (active.userId === userId) active.controller.abort('LOGOUT');
  }

  async shutdown() {
    for (const active of this.active.values()) active.controller.abort('SHUTDOWN');
    await this.saverPool.end();
  }

  async run(auth: AuthorizedRequest, accepted: AcceptedTurn, resume: boolean,
    controller: AbortController, emit: (event: StreamEvent) => void) {
    let handled: HttpError | undefined;

    try {
      await this.tracing.turn({ conversationId: accepted.conversation.id, turnId: accepted.turn.id,
        publisherId: auth.identity.publisherId }, async () => {
        handled = await this.execute(auth, accepted, resume, controller, emit);
        if (handled) throw handled;
      });
    } catch (cause) {
      // The failure was already persisted and streamed; rethrowing would send a second HTTP error.
      if (cause !== handled) throw cause;
    }
  }

  private async execute(auth: AuthorizedRequest, accepted: AcceptedTurn, resume: boolean,
    controller: AbortController, emit: (event: StreamEvent) => void) {
    const { turn, generation, conversation } = accepted;
    const identity = auth.identity;
    const correlationId = randomUUID();
    const fields = { conversationId: conversation.id, turnId: turn.id, correlationId };
    const context = { identity, correlationId, signal: controller.signal };
    const guard = async () => {
      controller.signal.throwIfAborted();
      const current = await this.authorization.resolveUser(identity.userId, auth.expiresAt);
      if (current.identity.publisherId !== identity.publisherId) throw new HttpError(401, 'UNAUTHORIZED', 'Publisher authorization changed.');
      await this.conversations.assertLease(identity, conversation.id, turn.id, generation);
    };
    let visible = '';
    let terminal: State | null = null;
    const timer = setTimeout(() => controller.abort('TIMEOUT'), this.settings.deadlineMs);
    const expiry = setTimeout(() => controller.abort('AUTH_EXPIRED'), Math.max(0, auth.expiresAt * 1000 - Date.now()));
    this.active.set(turn.id, { userId: identity.userId, controller, visible: () => visible });
    emit({ ...fields, type: 'turn-start' });

    try {
      const config = await this.conversations.checkpointConfig(identity, conversation.id);
      const saver = new FencedPostgresSaver(this.saverPool, (operation) =>
        this.conversations.withFence(identity, conversation.id, turn.id, generation, operation));
      const graph = buildAgentGraph(saver, { context, tracing: this.tracing, guard, conversationId: conversation.id, turnId: turn.id,
        reserve: (kind) => this.conversations.reserveAttempt(identity, conversation.id, turn.id, generation, kind),
        emit, loadTool: (call) => this.conversations.loadTool(identity, conversation.id, turn.id, call),
        saveTool: async (state) => {
          const execution = state.executions.at(-1)!;
          await this.conversations.saveTool(identity, conversation.id, turn.id, generation, execution);
        }, finalize: async (state) => {
          if (!state.answer.trim()) throw new HttpError(502, 'MODEL_INCOMPATIBLE', 'The model returned no visible answer.');
          validateAnswer(state);
        }, model: (state) => {
          visible = '';
          emit({ ...fields, type: 'text-reset' });

          return this.model(state, controller.signal, (text) => {
            visible += text;
            for (let offset = 0; offset < text.length; offset += 16_384) {
              emit({ ...fields, type: 'text-delta', text: text.slice(offset, offset + 16_384) });
            }
          }, { ...fields, publisherId: identity.publisherId });
        } });
      const saved = resume ? await graph.getState(config) : null;
      const savedState = saved?.values as State | undefined;
      const history = resume ? { messages: [], omitted: false } : await this.conversations.recentContext(identity, conversation.id);
      const messages = [{ role: 'system' as const, content: investigationPrompt(identity) }, ...(history.omitted ? [{ role: 'system' as const, content: 'Older conversation context was omitted to stay within limits.' }] : []),
        ...history.messages, { role: 'user' as const, content: turn.input }];
      const state = savedState?.done ? savedState : await graph.invoke(resume ? null : initialState(turn.id, messages), { ...config, signal: controller.signal, recursionLimit: 50, durability: 'sync' });

      terminal = state;
      await guard();
      await this.conversations.finish(identity, conversation.id, turn.id, generation, 'completed', state.answer);
      emit({ ...fields, type: 'turn-complete', evidence: state.evidence });
    } catch (cause) {
      const reason = controller.signal.reason;
      const cancelled = reason === 'STOP' || reason === 'LOGOUT';
      const interrupted = !cancelled && (controller.signal.aborted || terminal !== null
        || cause instanceof HttpError && cause.code === 'DEPENDENCY_UNAVAILABLE');
      const error = reason === 'TIMEOUT' ? { code: 'TIMEOUT' as const, message: 'The turn exceeded its deadline.' }
        : cause instanceof HttpError ? { code: cause.code, message: cause.message }
        : cause instanceof ConfigurationError ? { code: 'DEPENDENCY_UNAVAILABLE' as const, message: 'Model settings are not configured.' }
        : { code: 'INTERNAL_ERROR' as const, message: 'The investigation could not be completed.' };

      try {
        await this.conversations.finish(identity, conversation.id, turn.id, generation,
          cancelled ? 'cancelled' : interrupted ? 'interrupted' : 'error', terminal?.answer ?? visible, cancelled ? 'CANCELLED' : error.code);
      } catch (projectionError) {
        // An expired/replaced lease cannot overwrite its successor; recovery handles projection gaps.
        reportFailure('turn_projection_failed', { ...fields, publisherId: identity.publisherId }, projectionError,
          [process.env['LLM_API_KEY'] ?? '', process.env['LANGFUSE_SECRET_KEY'] ?? '']);
      }

      const failure = new HttpError(cancelled ? 409 : cause instanceof HttpError ? cause.status : 500,
        cancelled ? 'CANCELLED' : error.code, cancelled ? 'The turn was cancelled.' : error.message, { cause,
          diagnostics: { ...fields, publisherId: identity.publisherId, abortReason: reason,
            outcome: cancelled ? 'cancelled' : interrupted ? 'interrupted' : 'error', visibleCharacters: visible.length } });
      if (!cancelled) reportFailure('investigation_failed', { ...fields, publisherId: identity.publisherId,
        traceId: this.tracing.traceId }, failure, [process.env['LLM_API_KEY'] ?? '', process.env['LANGFUSE_SECRET_KEY'] ?? '']);

      emit(cancelled ? { ...fields, type: 'turn-cancelled' } : { ...fields, type: 'turn-error', error });

      return failure;
    } finally {
      clearTimeout(timer);
      clearTimeout(expiry);
      this.active.delete(turn.id);
    }
  }
}
