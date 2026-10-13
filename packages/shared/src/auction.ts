import { z } from 'zod';
import { AmountSchema, CounterSchema, CurrencySchema, DateSchema, IdSchema, RatioSchema, TimestampSchema } from './common.js';

const EventFields = {
  eventId: IdSchema,
  publisherId: IdSchema,
  auctionId: IdSchema,
  adUnitId: IdSchema,
  bidRequestId: IdSchema,
  bidderId: IdSchema,
  timestamp: TimestampSchema,
  currency: CurrencySchema,
};

export const AuctionEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...EventFields, type: z.literal('bidRequested'), auctionTimeoutMs: z.number().int().min(1).max(60_000) }),
  z.strictObject({ ...EventFields, type: z.literal('bidResponse'), cpm: AmountSchema, latencyMs: AmountSchema, late: z.boolean(), eligible: z.boolean() })
    .refine(({ late, eligible }) => !late || !eligible, { message: 'Late responses cannot be eligible' }),
  z.strictObject({ ...EventFields, type: z.literal('bidWon'), cpm: AmountSchema }),
]);

const MetricFields = {
  publisherId: IdSchema,
  date: DateSchema,
  currency: CurrencySchema,
  synthetic: z.boolean(),
  estimatedRevenue: AmountSchema,
};

export const DailyMetricsSchema = z.strictObject({
  ...MetricFields,
  auctions: CounterSchema,
  opportunities: CounterSchema,
  eligibleOpportunities: CounterSchema,
  filledOpportunities: CounterSchema,
  winningCpmTotal: AmountSchema,
  fillRate: RatioSchema,
  averageWinningCpm: AmountSchema.nullable(),
}).refine((m) => m.filledOpportunities <= m.eligibleOpportunities && m.eligibleOpportunities <= m.opportunities, {
  message: 'Filled, eligible and total opportunities must reconcile',
});

export const BidderMetricsSchema = z.strictObject({
  ...MetricFields,
  bidderId: IdSchema,
  requests: CounterSchema,
  responses: CounterSchema,
  eligibleResponses: CounterSchema,
  lateResponses: CounterSchema,
  wins: CounterSchema,
  responseRate: RatioSchema,
  winRate: RatioSchema,
  averageLatencyMs: AmountSchema.nullable(),
}).refine((m) => m.responses <= m.requests && m.eligibleResponses + m.lateResponses <= m.responses && m.wins <= m.eligibleResponses, {
  message: 'Bidder counts must reconcile',
});

export type AuctionEvent = z.infer<typeof AuctionEventSchema>;
export type DailyMetrics = z.infer<typeof DailyMetricsSchema>;
export type BidderMetrics = z.infer<typeof BidderMetricsSchema>;
