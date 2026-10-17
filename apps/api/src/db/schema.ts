import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { ToolResult } from '@bid/shared';

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey(),
    userId: text('user_id').notNull(),
    publisherId: text('publisher_id').notNull(),
    threadId: uuid('thread_id').notNull(),
    title: text('title').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    activeTurnId: uuid('active_turn_id'),
    leaseGeneration: integer('lease_generation').notNull().default(0),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  },
  (table) => [
    index('conversations_owner').on(table.userId, table.publisherId, table.createdAt, table.id),
    uniqueIndex('conversations_thread').on(table.threadId),
  ],
);

export const turns = pgTable(
  'turns',
  {
    id: uuid('id').primaryKey(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id),
    requestId: uuid('request_id').notNull(),
    status: text('status').notNull(),
    input: text('input').notNull(),
    safeOutput: text('safe_output').notNull().default(''),
    errorCode: text('error_code'),
    resumeCount: integer('resume_count').notNull().default(0),
    modelAttempts: integer('model_attempts').notNull().default(0),
    specialistAttempts: integer('specialist_attempts').notNull().default(0),
    decisionAttempts: integer('decision_attempts').notNull().default(0),
    toolAttempts: integer('tool_attempts').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('turns_request').on(table.conversationId, table.requestId),
    index('turns_conversation').on(table.conversationId, table.createdAt, table.id),
    check(
      'turns_status',
      sql`${table.status} in ('running', 'completed', 'interrupted', 'cancelled', 'error')`,
    ),
    check('turns_input_size', sql`octet_length(${table.input}) <= 8192`),
    check('turns_output_size', sql`octet_length(${table.safeOutput}) <= 65536`),
  ],
);

export const toolExecutions = pgTable(
  'tool_executions',
  {
    id: uuid('id').primaryKey(),
    turnId: uuid('turn_id')
      .notNull()
      .references(() => turns.id),
    toolCallId: text('tool_call_id').notNull(),
    name: text('name').notNull(),
    argumentsJson: text('arguments_json').notNull(),
    result: jsonb('result').$type<ToolResult>(),
    errorCode: text('error_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('tool_execution_call').on(table.turnId, table.toolCallId),
    check('tool_input_size', sql`octet_length(${table.argumentsJson}) <= 16384`),
    check(
      'tool_result_size',
      sql`${table.result} is null or octet_length(${table.result}::text) <= 32768`,
    ),
  ],
);
