import { z } from 'zod';
import { IdSchema, PeriodInputSchema } from './common.js';
import { DailyMetricsSchema, BidderMetricsSchema } from './auction.js';
import { PerformanceSummarySchema, BidderSummarySchema } from './analytics.js';

export const PublisherMetricSchema = z.enum([
  'estimatedRevenue',
  'auctions',
  'opportunities',
  'fillRate',
  'averageWinningCpm',
  'averageAuctionWaitMs',
]);

export const BidderMetricSchema = z.enum([
  'estimatedRevenue',
  'requests',
  'responses',
  'responseRate',
  'winRate',
  'averageLatencyMs',
  'wins',
]);

export const DashboardViewSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('publisher-performance'),
    metric: PublisherMetricSchema,
    period: PeriodInputSchema,
    comparisonPeriod: PeriodInputSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('bidder-performance'),
    metric: BidderMetricSchema,
    period: PeriodInputSchema,
    comparisonPeriod: PeriodInputSchema.optional(),
    bidderIds: z
      .array(IdSchema)
      .max(5)
      .refine((ids) => new Set(ids).size === ids.length),
  }),
]);

export const DashboardQuerySchema = z.strictObject({
  view: DashboardViewSchema,
  page: z.number().int().min(1).max(900).default(1),
  pageSize: z.number().int().min(1).max(50).default(20),
});

const CoverageSchema = z.strictObject({
  period: PeriodInputSchema,
  observedDates: z.array(z.iso.date()).max(90),
  missingDates: z.array(z.iso.date()).max(90),
  partialDates: z.array(z.iso.date()).max(90),
});

export const AnalyticsEvidenceSchema = z.strictObject({
  title: z.string().min(1).max(160),
  summary: z.string().min(1).max(2000),
  view: DashboardViewSchema,
  // Existing typed results carry the exact deterministic values; no source rows are duplicated.
  coverage: z.array(CoverageSchema).max(2),
});

export const DashboardResponseSchema = z.strictObject({
  view: DashboardViewSchema,
  currency: z.string().length(3),
  current: PerformanceSummarySchema.nullable(),
  previous: PerformanceSummarySchema.nullable(),
  availableBidderIds: z.array(IdSchema).max(5),
  bidders: z.array(BidderSummarySchema).max(5),
  previousBidders: z.array(BidderSummarySchema).max(5),
  coverage: z.array(CoverageSchema).max(2),
  series: z
    .array(
      z.strictObject({
        date: z.iso.date(),
        period: z.enum(['current', 'previous']),
        bidderId: IdSchema.optional(),
        value: z.number().finite().nullable(),
      }),
    )
    .max(900),
  records: z.array(z.union([DailyMetricsSchema, BidderMetricsSchema])).max(50),
  totalRecords: z.number().int().nonnegative().max(900),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive().max(50),
});

export type DashboardView = z.infer<typeof DashboardViewSchema>;
export type DashboardQuery = z.infer<typeof DashboardQuerySchema>;
export type DashboardResponse = z.infer<typeof DashboardResponseSchema>;
export type AnalyticsEvidence = z.infer<typeof AnalyticsEvidenceSchema>;
