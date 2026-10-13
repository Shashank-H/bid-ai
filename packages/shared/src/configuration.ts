import { z } from 'zod';
import { CurrencySchema, IdSchema, TimestampSchema } from './common.js';

export const ConfigurationSettingsSchema = z.strictObject({
  floorCpm: z.number().min(0).max(100),
  auctionTimeoutMs: z.number().int().min(100).max(10_000),
  enabledBidders: z.array(IdSchema).min(1).max(50)
    .refine((ids) => new Set(ids).size === ids.length, { message: 'Bidder IDs must be unique' }),
  currency: CurrencySchema,
});

export const ConfigurationSchema = z.strictObject({
  publisherId: IdSchema,
  version: z.number().int().positive(),
  updatedAt: TimestampSchema,
  updatedByUserId: IdSchema,
  settings: ConfigurationSettingsSchema,
});

export const ConfigurationHistorySchema = z.strictObject({
  historyId: IdSchema,
  publisherId: IdSchema,
  version: z.number().int().positive(),
  timestamp: TimestampSchema,
  updatedByUserId: IdSchema,
  before: ConfigurationSettingsSchema.nullable(),
  after: ConfigurationSettingsSchema,
  proposalId: IdSchema.optional(),
  approvingUserId: IdSchema.optional(),
}).refine(({ proposalId, approvingUserId }) => Boolean(proposalId) === Boolean(approvingUserId), {
  message: 'Agent-approved changes require both proposal and approver attribution',
});

export type ConfigurationSettings = z.infer<typeof ConfigurationSettingsSchema>;
export type Configuration = z.infer<typeof ConfigurationSchema>;
export type ConfigurationHistory = z.infer<typeof ConfigurationHistorySchema>;
