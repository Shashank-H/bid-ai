import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common.js';
import { PublisherDatasetMetadataSchema } from './dataset.js';
import { PublicUserSchema } from './identity.js';
import { ToolResultSchema } from './protocol.js';

export const LogoutResponseSchema = z.strictObject({ loggedOut: z.literal(true) });
export const DuplicateTurnResponseSchema = z.strictObject({
  duplicate: z.literal(true),
  turnId: z.uuid(),
  status: z.enum(['running', 'completed', 'interrupted', 'cancelled', 'error']),
});

export const AuthResponseSchema = PublisherDatasetMetadataSchema.extend({
  user: PublicUserSchema,
  publisherId: IdSchema,
});
export const ConversationSchema = z.strictObject({
  id: z.uuid(),
  title: z.string().max(80),
  publisherId: IdSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export const ConversationListSchema = z.strictObject({
  conversations: z.array(ConversationSchema).max(20),
  nextCursor: z.uuid().nullable(),
});
export const SavedToolSchema = z.strictObject({
  toolCallId: IdSchema,
  name: IdSchema,
  argumentsJson: z.string().max(16_384),
  result: ToolResultSchema.nullable(),
  errorCode: z.string().max(100).nullable(),
});
export const SavedTurnSchema = z.strictObject({
  id: z.uuid(),
  input: z.string().max(8192),
  text: z.string().max(65_536),
  status: z.enum(['running', 'completed', 'interrupted', 'cancelled', 'error']),
  errorCode: z.string().max(100).nullable(),
  createdAt: TimestampSchema,
  tools: z.array(SavedToolSchema).max(12),
});
export const ConversationDetailSchema = z.strictObject({
  conversation: ConversationSchema,
  turns: z.array(SavedTurnSchema).max(10),
  nextCursor: z.uuid().nullable(),
});

export type AuthResponse = z.infer<typeof AuthResponseSchema>;
export type Conversation = z.infer<typeof ConversationSchema>;
export type SavedTurn = z.infer<typeof SavedTurnSchema>;
export type SavedTool = z.infer<typeof SavedToolSchema>;
