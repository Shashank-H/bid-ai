import { z } from 'zod';
import {
  AmountSchema,
  CounterSchema,
  CurrencySchema,
  IdSchema,
  PeriodInputSchema,
  RatioSchema,
} from './common.js';
import { ConfigurationHistorySchema, ConfigurationSchema } from './configuration.js';
import { ConfigurationParameterImpactSchema } from './prebid.js';

export const PerformanceSummarySchema = z.strictObject({
  period: PeriodInputSchema,
  availableDays: CounterSchema,
  currency: CurrencySchema,
  auctions: CounterSchema,
  opportunities: CounterSchema,
  eligibleOpportunities: CounterSchema,
  filledOpportunities: CounterSchema,
  estimatedRevenue: AmountSchema,
  fillRate: RatioSchema,
  averageWinningCpm: AmountSchema.nullable(),
  averageAuctionWaitMs: AmountSchema.nullable().optional(),
  partialDates: z.array(z.iso.date()).max(2).optional(),
});

export const BidderSummarySchema = z.strictObject({
  bidderId: IdSchema,
  requests: CounterSchema,
  responses: CounterSchema,
  acceptedResponses: CounterSchema.optional(),
  rejectedResponses: CounterSchema.optional(),
  timeouts: CounterSchema.optional(),
  noBids: CounterSchema.optional(),
  eligibleResponses: CounterSchema,
  lateResponses: CounterSchema,
  wins: CounterSchema,
  estimatedRevenue: AmountSchema,
  responseRate: RatioSchema,
  winRate: RatioSchema,
  averageLatencyMs: AmountSchema.nullable(),
});

export const ToolDataSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('performance-summary'), metrics: PerformanceSummarySchema }),
  z.strictObject({
    kind: z.literal('period-comparison'),
    current: PerformanceSummarySchema,
    previous: PerformanceSummarySchema,
    estimatedRevenueChange: z.number().finite().nullable(),
    estimatedRevenueChangePercent: z.number().finite().nullable(),
  }),
  z.strictObject({
    kind: z.literal('bidder-performance'),
    period: PeriodInputSchema,
    currency: CurrencySchema,
    bidders: z.array(BidderSummarySchema).max(50),
  }),
  z.strictObject({
    kind: z.literal('configuration'),
    configuration: ConfigurationSchema.nullable(),
    parameterImpacts: z.array(ConfigurationParameterImpactSchema).max(50).optional(),
  }),
  z.strictObject({
    kind: z.literal('configuration-history'),
    period: PeriodInputSchema,
    history: z.array(ConfigurationHistorySchema).max(50),
    parameterImpacts: z.array(ConfigurationParameterImpactSchema).max(50).optional(),
  }),
]);

export type PerformanceSummary = z.infer<typeof PerformanceSummarySchema>;
export type ToolData = z.infer<typeof ToolDataSchema>;
