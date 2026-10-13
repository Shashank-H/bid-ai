import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common.js';
import { ConfigurationSettingsSchema } from './configuration.js';

export const EvidenceReferenceSchema = z.strictObject({
  evidenceId: IdSchema,
  publisherId: IdSchema,
  source: z.enum(['daily-metrics', 'bidder-metrics', 'configuration', 'configuration-history']),
  recordId: IdSchema,
  observedAt: TimestampSchema,
  synthetic: z.boolean(),
});

export const FindingSchema = z.strictObject({
  kind: z.enum(['observation', 'hypothesis', 'recommendation']),
  text: z.string().min(1).max(4000),
  evidenceIds: z.array(IdSchema).min(1).max(50),
});

export const SafeErrorSchema = z.strictObject({
  code: z.enum(['UNAUTHORIZED', 'INVALID_INPUT', 'NOT_IMPLEMENTED', 'DEPENDENCY_UNAVAILABLE', 'TOOL_FAILED', 'MODEL_INCOMPATIBLE', 'BUDGET_EXCEEDED', 'TIMEOUT', 'CANCELLED', 'INTERNAL_ERROR']),
  message: z.string().min(1).max(500),
});

export const ToolResultSchema = z.strictObject({
  // Bounded serialized results; additional model/provider fields are not accepted here.
  summary: z.string().max(4000),
  evidence: z.array(EvidenceReferenceSchema).max(100),
  findings: z.array(FindingSchema).max(50),
}).refine(({ evidence, findings }) => {
  const ids = new Set(evidence.map((entry) => entry.evidenceId));

  return ids.size === evidence.length && findings.every((finding) => finding.evidenceIds.every((id) => ids.has(id)));
}, { message: 'Findings require unique, present evidence references' });

const StreamFields = { turnId: IdSchema, correlationId: IdSchema };

export const StreamEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...StreamFields, type: z.literal('turn-start') }),
  z.strictObject({ ...StreamFields, type: z.literal('text-delta'), text: z.string().max(16_384) }),
  z.strictObject({ ...StreamFields, type: z.literal('tool-start'), toolCallId: IdSchema, toolName: IdSchema }),
  z.strictObject({ ...StreamFields, type: z.literal('tool-result'), toolCallId: IdSchema, result: ToolResultSchema }),
  z.strictObject({ ...StreamFields, type: z.literal('tool-error'), toolCallId: IdSchema, error: SafeErrorSchema }),
  z.strictObject({ ...StreamFields, type: z.literal('turn-complete') }),
  z.strictObject({ ...StreamFields, type: z.literal('turn-cancelled') }),
  z.strictObject({ ...StreamFields, type: z.literal('turn-error'), error: SafeErrorSchema }),
]);

export const ProposalSchema = z.strictObject({
  proposalId: IdSchema,
  publisherId: IdSchema,
  createdAt: TimestampSchema,
  proposedByUserId: IdSchema,
  expectedVersion: z.number().int().positive(),
  before: ConfigurationSettingsSchema,
  after: ConfigurationSettingsSchema,
  rationale: z.string().min(1).max(4000),
  evidence: z.array(EvidenceReferenceSchema).min(1).max(100),
  status: z.enum(['pending', 'approved', 'rejected', 'stale', 'applied']),
}).refine(({ publisherId, evidence }) => evidence.every((entry) => entry.publisherId === publisherId), {
  message: 'Proposal evidence must belong to its publisher',
});

export const AuditRecordSchema = z.strictObject({
  auditId: IdSchema,
  publisherId: IdSchema,
  actorUserId: IdSchema,
  timestamp: TimestampSchema,
  action: z.enum(['configuration-saved', 'proposal-approved', 'proposal-rejected', 'proposal-applied']),
  proposalId: IdSchema.optional(),
  configurationVersion: z.number().int().positive().optional(),
});

export type EvidenceReference = z.infer<typeof EvidenceReferenceSchema>;
export type Finding = z.infer<typeof FindingSchema>;
export type SafeError = z.infer<typeof SafeErrorSchema>;
export type ToolResult = z.infer<typeof ToolResultSchema>;
export type StreamEvent = z.infer<typeof StreamEventSchema>;
export type Proposal = z.infer<typeof ProposalSchema>;
export type AuditRecord = z.infer<typeof AuditRecordSchema>;
