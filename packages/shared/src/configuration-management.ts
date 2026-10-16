import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common.js';
import { ConfigurationSettingsSchema } from './configuration.js';
import { PrebidConfigurationSchema } from './prebid.js';

export const ConfigurationPublicationSchema = z.strictObject({
  publisherId: IdSchema,
  versionId: TimestampSchema,
  configurationVersion: z.number().int().positive(),
  publishedAt: TimestampSchema,
  authorUserId: IdSchema,
  coauthor: z.literal('agent').optional(),
  source: z.enum(['seed', 'published']),
  previousVersionId: TimestampSchema.nullable(),
  settings: ConfigurationSettingsSchema,
  prebid: PrebidConfigurationSchema,
});

export const ConfigurationDraftSchema = z.strictObject({
  prebid: PrebidConfigurationSchema,
  baseVersionId: TimestampSchema.nullable(),
  updatedAt: TimestampSchema,
  updatedByUserId: IdSchema,
  agentContributed: z.boolean(),
});

export const ConfigurationDraftProposalSchema = z.strictObject({
  proposalId: IdSchema,
  publisherId: IdSchema,
  createdAt: TimestampSchema,
  proposedByUserId: IdSchema,
  baseVersionId: TimestampSchema.nullable(),
  before: PrebidConfigurationSchema,
  after: PrebidConfigurationSchema,
  rationale: z.string().trim().min(1).max(4000),
  evidenceIds: z.array(IdSchema).min(1).max(50),
  status: z.enum(['pending', 'approved', 'rejected', 'superseded']),
  decidedAt: TimestampSchema.optional(),
  decidedByUserId: IdSchema.optional(),
});

export const ConfigurationWorkspaceSchema = z.strictObject({
  publisherId: IdSchema,
  // Never reset when a draft is cleared: old tabs must not pass a later draft's CAS.
  revision: z.number().int().nonnegative(),
  current: ConfigurationPublicationSchema.nullable(),
  draft: ConfigurationDraftSchema.nullable(),
  proposal: ConfigurationDraftProposalSchema.nullable(),
});

export const SaveConfigurationDraftSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  prebid: PrebidConfigurationSchema,
  sourceVersionId: TimestampSchema.optional(),
});

export const PublishConfigurationDraftSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  expectedCurrentVersionId: TimestampSchema.nullable(),
  requestId: IdSchema,
});

export const ProposeConfigurationDraftSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  prebid: PrebidConfigurationSchema,
  rationale: z.string().trim().min(1).max(4000),
  evidenceIds: z.array(IdSchema).min(1).max(50),
});

export const DecideConfigurationDraftSchema = z.strictObject({
  proposalId: IdSchema,
  expectedRevision: z.number().int().nonnegative(),
  decision: z.enum(['approve', 'reject']),
});

export const ConfigurationVersionPageInputSchema = z.strictObject({
  limit: z.number().int().min(1).max(25).optional(),
  cursor: z.string().min(1).max(1000).optional(),
});

export const ConfigurationVersionPageSchema = z.strictObject({
  versions: z.array(ConfigurationPublicationSchema).max(25),
  nextCursor: z.string().max(1000).nullable(),
});

export type ConfigurationPublication = z.infer<typeof ConfigurationPublicationSchema>;
export type ConfigurationDraft = z.infer<typeof ConfigurationDraftSchema>;
export type ConfigurationDraftProposal = z.infer<typeof ConfigurationDraftProposalSchema>;
export type ConfigurationWorkspace = z.infer<typeof ConfigurationWorkspaceSchema>;
export type SaveConfigurationDraft = z.infer<typeof SaveConfigurationDraftSchema>;
export type PublishConfigurationDraft = z.infer<typeof PublishConfigurationDraftSchema>;
export type ProposeConfigurationDraft = z.infer<typeof ProposeConfigurationDraftSchema>;
export type DecideConfigurationDraft = z.infer<typeof DecideConfigurationDraftSchema>;
export type ConfigurationVersionPageInput = z.infer<typeof ConfigurationVersionPageInputSchema>;
export type ConfigurationVersionPage = z.infer<typeof ConfigurationVersionPageSchema>;
