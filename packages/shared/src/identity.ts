import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common.js';

// Persistence contracts, not public user-response contracts. Never return hashes to clients.
export const UserSchema = z.strictObject({
  userId: IdSchema,
  login: z.string().min(1).max(254),
  credentialHash: z.string().min(32).max(1024),
  createdAt: TimestampSchema,
  disabled: z.boolean(),
});

export const PublisherMembershipSchema = z.strictObject({
  userId: IdSchema,
  publisherId: IdSchema,
  role: z.enum(['viewer', 'operator']),
});

export const SessionSchema = z.strictObject({
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  userId: IdSchema,
  createdAt: TimestampSchema,
  expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).refine(({ createdAt, expiresAt }) => expiresAt * 1000 > Date.parse(createdAt), {
  message: 'Session expiry must follow creation',
});

export const PublicUserSchema = UserSchema.pick({ userId: true, login: true });

export type User = z.infer<typeof UserSchema>;
export type PublicUser = z.infer<typeof PublicUserSchema>;
export type PublisherMembership = z.infer<typeof PublisherMembershipSchema>;
export type Session = z.infer<typeof SessionSchema>;
