import { randomUUID } from 'node:crypto';
import { and, desc, eq, exists, inArray, lt, or, sql } from 'drizzle-orm';
import type { UserPublisherContext } from '../domain/interfaces.js';
import type { Postgres } from './postgres.js';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { SavedToolExecution, ToolCall } from '../agent/state.js';
import { conversations, toolExecutions, turns } from './schema.js';
import { HttpError, notFound } from '../errors.js';
import { AGENT_LIMITS } from '../agent/policy.js';

export class ConversationRepository {
  constructor(readonly postgres: Postgres) {}

  private owner(identity: UserPublisherContext) {
    return and(
      eq(conversations.userId, identity.userId),
      eq(conversations.publisherId, identity.publisherId),
    );
  }

  async create(identity: UserPublisherContext) {
    const [conversation] = await this.postgres.db
      .insert(conversations)
      .values({
        id: randomUUID(),
        threadId: randomUUID(),
        userId: identity.userId,
        publisherId: identity.publisherId,
        title: 'New investigation',
      })
      .returning();

    return this.publicConversation(conversation!);
  }

  async owned(identity: UserPublisherContext, id: string) {
    const [conversation] = await this.postgres.db
      .select()
      .from(conversations)
      .where(and(this.owner(identity), eq(conversations.id, id)))
      .limit(1);

    if (!conversation) notFound();

    return conversation;
  }

  async checkpointConfig(identity: UserPublisherContext, id: string) {
    const row = await this.owned(identity, id);

    // The root LangGraph namespace is empty; subgraph namespaces are not client-selectable.
    return { configurable: { thread_id: row.threadId, checkpoint_ns: '' } };
  }

  publicConversation(row: typeof conversations.$inferSelect) {
    return {
      id: row.id,
      title: row.title,
      publisherId: row.publisherId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async list(identity: UserPublisherContext, cursor?: string) {
    const before = cursor ? await this.owned(identity, cursor) : null;
    const rows = await this.postgres.db
      .select()
      .from(conversations)
      .where(
        and(
          this.owner(identity),
          exists(
            this.postgres.db
              .select({ id: turns.id })
              .from(turns)
              .where(eq(turns.conversationId, conversations.id)),
          ),
          before
            ? or(
                lt(conversations.createdAt, before.createdAt),
                and(eq(conversations.createdAt, before.createdAt), lt(conversations.id, before.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(conversations.createdAt), desc(conversations.id))
      .limit(21);

    return {
      conversations: rows.slice(0, 20).map((row) => this.publicConversation(row)),
      nextCursor: rows.length > 20 ? rows[19]!.id : null,
    };
  }

  async turn(identity: UserPublisherContext, conversationId: string, turnId: string) {
    await this.owned(identity, conversationId);

    const [turn] = await this.postgres.db
      .select()
      .from(turns)
      .where(and(eq(turns.conversationId, conversationId), eq(turns.id, turnId)))
      .limit(1);

    if (!turn) notFound();

    return turn;
  }

  async detail(identity: UserPublisherContext, id: string, cursor?: string) {
    const conversation = await this.owned(identity, id);
    const before = cursor ? await this.turn(identity, id, cursor) : null;
    const rows = await this.postgres.db
      .select()
      .from(turns)
      .where(
        and(
          eq(turns.conversationId, id),
          before
            ? or(
                lt(turns.createdAt, before.createdAt),
                and(eq(turns.createdAt, before.createdAt), lt(turns.id, before.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(turns.createdAt), desc(turns.id))
      .limit(11);
    const page = rows.slice(0, 10);
    const tools = page.length
      ? await this.postgres.db
          .select()
          .from(toolExecutions)
          .where(
            inArray(
              toolExecutions.turnId,
              page.map((row) => row.id),
            ),
          )
          .orderBy(toolExecutions.createdAt)
          .limit(120)
      : [];

    return {
      conversation: this.publicConversation(conversation),
      turns: page.reverse().map((turn) => ({
        id: turn.id,
        input: turn.input,
        text: turn.safeOutput,
        status:
          turn.status === 'running' &&
          conversation.leaseExpiresAt &&
          conversation.leaseExpiresAt.getTime() <= Date.now()
            ? 'interrupted'
            : turn.status,
        errorCode: turn.errorCode,
        createdAt: turn.createdAt.toISOString(),
        tools: tools
          .filter((tool) => tool.turnId === turn.id)
          .map((tool) => ({
            toolCallId: tool.toolCallId,
            name: tool.name,
            argumentsJson: tool.argumentsJson,
            result: tool.result,
            errorCode: tool.errorCode,
          })),
      })),
      nextCursor: rows.length > 10 ? rows[9]!.id : null,
    };
  }

  async recentContext(identity: UserPublisherContext, conversationId: string) {
    await this.owned(identity, conversationId);
    const rows = await this.postgres.db
      .select()
      .from(turns)
      .where(and(eq(turns.conversationId, conversationId), eq(turns.status, 'completed')))
      .orderBy(desc(turns.createdAt), desc(turns.id))
      .limit(5);
    const tools = rows.length
      ? await this.postgres.db
          .select()
          .from(toolExecutions)
          .where(
            inArray(
              toolExecutions.turnId,
              rows.map((row) => row.id),
            ),
          )
          .orderBy(toolExecutions.createdAt)
          .limit(60)
      : [];
    let omitted = rows.length > 4;
    const groups: ChatCompletionMessageParam[][] = rows
      .slice(0, 4)
      .reverse()
      .map((turn) => {
        const executions = tools.filter((tool) => tool.turnId === turn.id);
        const messages: ChatCompletionMessageParam[] = [{ role: 'user', content: turn.input }];

        if (executions.length) {
          messages.push({
            role: 'assistant',
            tool_calls: executions.map((tool) => ({
              id: tool.toolCallId,
              type: 'function',
              function: { name: tool.name, arguments: tool.argumentsJson },
            })),
          });
          for (const tool of executions)
            messages.push({
              role: 'tool',
              tool_call_id: tool.toolCallId,
              content: JSON.stringify(
                tool.result ?? { error: { code: 'TOOL_FAILED', message: 'This tool failed.' } },
              ),
            });
        }

        messages.push({ role: 'assistant', content: turn.safeOutput });

        return messages;
      });

    while (groups.length && Buffer.byteLength(JSON.stringify(groups.flat())) > 65_536) {
      groups.shift();
      omitted = true;
    }

    return { messages: groups.flat(), omitted };
  }

  async accept(
    identity: UserPublisherContext,
    conversationId: string,
    input: { requestId: string; message: string } | { resumeId: string },
  ) {
    return this.postgres.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(conversations)
        .where(and(this.owner(identity), eq(conversations.id, conversationId)))
        .for('update');
      if (!row) notFound();

      const now = new Date();
      let turn: typeof turns.$inferSelect;

      if ('requestId' in input) {
        const [existing] = await tx
          .select()
          .from(turns)
          .where(
            and(eq(turns.conversationId, conversationId), eq(turns.requestId, input.requestId)),
          );
        if (existing)
          return {
            conversation: row,
            turn: existing,
            generation: row.leaseGeneration,
            duplicate: true,
          };
        if (row.activeTurnId)
          conflict(
            'Resume or cancel the interrupted investigation before sending another message.',
          );

        const [created] = await tx
          .insert(turns)
          .values({
            id: randomUUID(),
            conversationId,
            requestId: input.requestId,
            input: input.message,
            status: 'running',
          })
          .returning();
        turn = created!;
      } else {
        const [existing] = await tx
          .select()
          .from(turns)
          .where(and(eq(turns.conversationId, conversationId), eq(turns.id, input.resumeId)));
        if (!existing) notFound();
        if (
          row.activeTurnId !== existing.id ||
          !['running', 'interrupted'].includes(existing.status) ||
          (row.leaseExpiresAt && row.leaseExpiresAt > now)
        )
          conflict('This turn cannot be resumed.');
        if (existing.resumeCount >= 3)
          conflict('The resume limit was reached. Cancel this turn and start a new question.');

        const [resumed] = await tx
          .update(turns)
          .set({
            status: 'running',
            resumeCount: existing.resumeCount + 1,
            safeOutput: '',
            errorCode: null,
            updatedAt: now,
          })
          .where(eq(turns.id, existing.id))
          .returning();
        turn = resumed!;
      }

      const generation = row.leaseGeneration + 1;
      await tx
        .update(conversations)
        .set({
          activeTurnId: turn.id,
          leaseGeneration: generation,
          leaseExpiresAt: new Date(now.getTime() + 115_000),
          updatedAt: now,
          title: row.title === 'New investigation' ? turn.input.slice(0, 80) : row.title,
        })
        .where(eq(conversations.id, conversationId));

      return { conversation: row, turn, generation, duplicate: false };
    });
  }

  async assertLease(
    identity: UserPublisherContext,
    conversationId: string,
    turnId: string,
    generation: number,
  ) {
    const row = await this.owned(identity, conversationId);

    if (
      row.activeTurnId !== turnId ||
      row.leaseGeneration !== generation ||
      !row.leaseExpiresAt ||
      row.leaseExpiresAt.getTime() <= Date.now()
    )
      conflict('This turn no longer owns its execution lease.');
  }

  async withFence<T>(
    identity: UserPublisherContext,
    conversationId: string,
    turnId: string,
    generation: number,
    operation: (tx: Parameters<Parameters<Postgres['db']['transaction']>[0]>[0]) => Promise<T>,
  ): Promise<T> {
    return this.postgres.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(conversations)
        .where(and(this.owner(identity), eq(conversations.id, conversationId)))
        .for('update');

      if (
        !row ||
        row.activeTurnId !== turnId ||
        row.leaseGeneration !== generation ||
        !row.leaseExpiresAt ||
        row.leaseExpiresAt.getTime() <= Date.now()
      )
        conflict('This turn no longer owns its execution lease.');

      return operation(tx);
    });
  }

  async cancel(
    identity: UserPublisherContext,
    conversationId: string,
    turnId: string,
    text?: string,
  ) {
    await this.postgres.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(conversations)
        .where(and(this.owner(identity), eq(conversations.id, conversationId)))
        .for('update');
      if (!row) notFound();
      const [turn] = await tx
        .select()
        .from(turns)
        .where(and(eq(turns.conversationId, conversationId), eq(turns.id, turnId)));
      if (!turn) notFound();
      if (turn.status === 'cancelled') return;
      if (row.activeTurnId !== turnId || !['running', 'interrupted'].includes(turn.status))
        conflict('This turn is no longer active.');

      await tx
        .update(turns)
        .set({
          status: 'cancelled',
          errorCode: 'CANCELLED',
          safeOutput: text ?? turn.safeOutput,
          updatedAt: new Date(),
        })
        .where(eq(turns.id, turnId));
      await tx
        .update(conversations)
        .set({
          activeTurnId: null,
          leaseExpiresAt: null,
          leaseGeneration: row.leaseGeneration + 1,
          updatedAt: new Date(),
        })
        .where(eq(conversations.id, conversationId));
    });
  }

  async reserveAttempt(
    identity: UserPublisherContext,
    conversationId: string,
    turnId: string,
    generation: number,
    kind: 'model' | 'specialist' | 'decision' | 'tool',
  ) {
    await this.withFence(identity, conversationId, turnId, generation, async (tx) => {
      const column =
        kind === 'model' || kind === 'specialist'
          ? turns.specialistAttempts
          : kind === 'decision'
            ? turns.decisionAttempts
            : turns.toolAttempts;
      const limit =
        kind === 'specialist'
          ? AGENT_LIMITS.specialists - 1
          : kind === 'model'
            ? AGENT_LIMITS.specialists
            : kind === 'decision'
              ? AGENT_LIMITS.decisions
              : AGENT_LIMITS.tools;
      const increments =
        kind === 'model' || kind === 'specialist'
          ? {
              modelAttempts: sql`${turns.modelAttempts} + 1`,
              specialistAttempts: sql`${column} + 1`,
            }
          : kind === 'decision'
            ? {
                modelAttempts: sql`${turns.modelAttempts} + 1`,
                decisionAttempts: sql`${column} + 1`,
              }
            : { toolAttempts: sql`${column} + 1` };
      const [updated] = await tx
        .update(turns)
        .set(increments)
        .where(
          and(
            eq(turns.id, turnId),
            eq(turns.conversationId, conversationId),
            lt(column, limit),
            ...(kind === 'tool' ? [] : [lt(turns.modelAttempts, AGENT_LIMITS.models)]),
          ),
        )
        .returning({ id: turns.id });

      if (!updated)
        throw new HttpError(
          429,
          'BUDGET_EXCEEDED',
          'The cumulative turn execution budget was reached.',
        );
    });
  }

  async loadTool(
    identity: UserPublisherContext,
    conversationId: string,
    turnId: string,
    call: ToolCall,
  ): Promise<SavedToolExecution | null> {
    await this.turn(identity, conversationId, turnId);
    const [row] = await this.postgres.db
      .select()
      .from(toolExecutions)
      .where(and(eq(toolExecutions.turnId, turnId), eq(toolExecutions.toolCallId, call.id)))
      .limit(1);

    if (!row) return null;
    if (row.name !== call.name || row.argumentsJson !== call.argumentsJson)
      conflict('Saved tool input does not match its checkpoint.');

    return {
      ...call,
      result: row.result,
      error: row.errorCode
        ? { code: 'TOOL_FAILED', message: 'This tool previously failed.' }
        : null,
    };
  }

  async saveTool(
    identity: UserPublisherContext,
    conversationId: string,
    turnId: string,
    generation: number,
    execution: SavedToolExecution,
  ) {
    await this.withFence(identity, conversationId, turnId, generation, async (tx) => {
      await tx
        .insert(toolExecutions)
        .values({
          id: randomUUID(),
          turnId,
          toolCallId: execution.id,
          name: execution.name,
          argumentsJson: execution.argumentsJson,
          result: execution.result,
          errorCode: execution.error?.code ?? null,
        })
        .onConflictDoUpdate({
          target: [toolExecutions.turnId, toolExecutions.toolCallId],
          set: { result: execution.result, errorCode: execution.error?.code ?? null },
        });
    });
  }

  async finish(
    identity: UserPublisherContext,
    conversationId: string,
    turnId: string,
    generation: number,
    status: 'completed' | 'interrupted' | 'cancelled' | 'error',
    text: string,
    errorCode: string | null = null,
  ) {
    await this.postgres.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(conversations)
        .where(and(this.owner(identity), eq(conversations.id, conversationId)))
        .for('update');
      if (!row || row.activeTurnId !== turnId || row.leaseGeneration !== generation)
        conflict('This turn no longer owns its execution lease.');

      await tx
        .update(turns)
        .set({ status, safeOutput: text, errorCode, updatedAt: new Date() })
        .where(and(eq(turns.conversationId, conversationId), eq(turns.id, turnId)));
      await tx
        .update(conversations)
        .set({
          activeTurnId: status === 'interrupted' ? turnId : null,
          leaseExpiresAt: status === 'interrupted' ? new Date(0) : null,
          updatedAt: new Date(),
        })
        .where(eq(conversations.id, conversationId));
    });
  }

  async assertReady(): Promise<boolean> {
    try {
      await this.postgres.db.select({ id: conversations.id }).from(conversations).limit(1);
      await this.postgres.pool.query('SELECT 1 FROM agent_checkpoints.checkpoints LIMIT 1');

      return true;
    } catch {
      return false;
    }
  }
}

export function conflict(message: string): never {
  throw new HttpError(409, 'CONFLICT', message);
}
