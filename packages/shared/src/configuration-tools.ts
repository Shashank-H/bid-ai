import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common.js';

export const ConfigurationTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('list') }),
  z.strictObject({ kind: z.literal('draft') }),
  z.strictObject({ kind: z.literal('version'), versionId: TimestampSchema }),
]);

export function configurationTargetPath(target: ConfigurationTarget): string {
  return target.kind === 'version'
    ? `/configurations/versions/${encodeURIComponent(target.versionId)}`
    : target.kind === 'draft'
      ? '/configurations/draft'
      : '/configurations';
}

export const ConfigurationPublicationSummarySchema = z.strictObject({
  versionId: TimestampSchema,
  publishedAt: TimestampSchema,
  authorUserId: IdSchema,
  coauthor: z.literal('agent').optional(),
  source: z.enum(['seed', 'published']),
});

export type ConfigurationTarget = z.infer<typeof ConfigurationTargetSchema>;
