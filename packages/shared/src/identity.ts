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

export const PublicUserSchema = UserSchema.pick({ userId: true, login: true });

export type User = z.infer<typeof UserSchema>;
export type PublicUser = z.infer<typeof PublicUserSchema>;
export type PublisherMembership = z.infer<typeof PublisherMembershipSchema>;
