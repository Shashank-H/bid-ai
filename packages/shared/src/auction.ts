import { z } from 'zod';
import {
  AmountSchema,
  CounterSchema,
  CurrencySchema,
  DateSchema,
  IdSchema,
  RatioSchema,
  TimestampSchema,
} from './common.js';
import { BannerSizeSchema } from './prebid.js';

const CoreFields = {
  eventId: IdSchema,
  publisherId: IdSchema,
  auctionId: IdSchema,
  adUnitId: IdSchema,
  timestamp: TimestampSchema,
  currency: CurrencySchema,
  // Absent only in the original three-event fixtures.
  configurationVersion: z.number().int().positive().optional(),
};
const BidFields = { ...CoreFields, bidRequestId: IdSchema, bidderId: IdSchema };
const CanonicalCoreFields = {
  ...CoreFields,
  configurationVersion: z.number().int().positive(),
};

export const BidTargetingSchema = z
  .record(z.string().min(1).max(100), z.string().max(200))
  .refine((targeting) => Object.keys(targeting).length <= 50, {
    message: 'Targeting must remain bounded',
  });

export const OfferDetailsSchema = z
  .strictObject({
    originalCpm: AmountSchema.positive(),
    originalCurrency: CurrencySchema,
    normalizedCpm: AmountSchema.positive(),
    comparisonCpm: AmountSchema.positive(),
    size: BannerSizeSchema,
    creativeId: IdSchema,
    netRevenue: z.boolean(),
    ttlSeconds: z.number().positive().max(3600),
    ttlBufferSeconds: z.number().min(0).max(60),
    expiresAt: TimestampSchema,
    floorRule: z.string().min(1).max(150),
    floorCpm: AmountSchema,
    floorCurrency: CurrencySchema,
    signaledFloorCpm: AmountSchema,
    floorEnforced: z.boolean(),
    floorsSkipped: z.boolean(),
    auctionCutoffAt: TimestampSchema,
    targetingBucket: z.string().regex(/^\d+\.\d{2}$/),
  })
  .refine((offer) => offer.ttlSeconds > offer.ttlBufferSeconds, {
    message: 'Offer lifetime must exceed the effective TTL buffer',
  });

const OfferFields = {
  ...BidFields,
  cpm: AmountSchema,
  latencyMs: AmountSchema,
  late: z.boolean(),
  eligible: z.boolean(),
  offer: OfferDetailsSchema.optional(),
};

// Normalized publisher records, not untouched native Prebid hook payloads.
// An accepted native bidResponse can arrive after auctionEnd; late !== rejected.
export const AuctionEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...BidFields,
    type: z.literal('bidRequested'),
    auctionTimeoutMs: z.number().int().min(1).max(60_000),
    placementId: IdSchema.optional(),
    size: BannerSizeSchema.optional(),
  }),
  z
    .strictObject({ ...OfferFields, type: z.literal('bidResponse') })
    .refine(({ late, eligible }) => !late || !eligible, {
      message: 'Late responses cannot be eligible for the frozen candidate selection',
    }),
  z.strictObject({
    ...OfferFields,
    type: z.literal('bidRejected'),
    eligible: z.literal(false),
    reason: z.enum(['floor', 'size-policy', 'currency', 'expired', 'invalid']),
  }),
  z.strictObject({
    ...BidFields,
    type: z.literal('bidWon'),
    cpm: AmountSchema,
    targeting: BidTargetingSchema.optional(),
  }),
  z.strictObject({
    ...CanonicalCoreFields,
    type: z.literal('auctionInit'),
    configuredTimeoutMs: z.number().int().min(1).max(60_000),
    effectiveTimeoutMs: z.number().int().min(1).max(60_000),
    deadlineAt: TimestampSchema,
    size: BannerSizeSchema,
  }),
  z.strictObject({
    ...CanonicalCoreFields,
    type: z.literal('auctionEnd'),
    cutoffAt: TimestampSchema,
    waitMs: AmountSchema,
    timedOut: z.boolean(),
  }),
  z.strictObject({
    ...BidFields,
    configurationVersion: z.number().int().positive(),
    type: z.literal('bidTimeout'),
  }),
  z.strictObject({
    ...BidFields,
    configurationVersion: z.number().int().positive(),
    type: z.literal('bidderDone'),
    noBid: z.boolean(),
  }),
  z.strictObject({
    ...BidFields,
    configurationVersion: z.number().int().positive(),
    type: z.literal('bidCandidate'),
    cpm: AmountSchema.positive(),
    targeting: BidTargetingSchema,
  }),
  z.strictObject({
    ...BidFields,
    configurationVersion: z.number().int().positive(),
    type: z.literal('adRenderSucceeded'),
    creativeId: IdSchema,
  }),
  z.strictObject({
    ...BidFields,
    configurationVersion: z.number().int().positive(),
    type: z.literal('adRenderFailed'),
    reason: z.string().min(1).max(500),
  }),
]);

// The generator/repository must use this stricter contract, never the legacy-compatible one.
export const CanonicalAuctionEventSchema = z.discriminatedUnion('type', [
  AuctionEventSchema.options[0].safeExtend({
    configurationVersion: z.number().int().positive(),
    placementId: IdSchema,
    size: BannerSizeSchema,
  }),
  AuctionEventSchema.options[1].safeExtend({
    configurationVersion: z.number().int().positive(),
    cpm: AmountSchema.positive(),
    offer: OfferDetailsSchema,
  }),
  AuctionEventSchema.options[2].safeExtend({
    configurationVersion: z.number().int().positive(),
    cpm: AmountSchema.positive(),
    offer: OfferDetailsSchema,
  }),
  AuctionEventSchema.options[3].safeExtend({
    configurationVersion: z.number().int().positive(),
    cpm: AmountSchema.positive(),
    targeting: BidTargetingSchema,
  }),
  AuctionEventSchema.options[4],
  AuctionEventSchema.options[5],
  AuctionEventSchema.options[6],
  AuctionEventSchema.options[7],
  AuctionEventSchema.options[8],
  AuctionEventSchema.options[9],
  AuctionEventSchema.options[10],
]);

const MetricFields = {
  publisherId: IdSchema,
  date: DateSchema,
  currency: CurrencySchema,
  estimatedRevenue: AmountSchema,
};

export const DailyMetricsSchema = z
  .strictObject({
    ...MetricFields,
    auctions: CounterSchema,
    opportunities: CounterSchema,
    eligibleOpportunities: CounterSchema,
    filledOpportunities: CounterSchema,
    winningCpmTotal: AmountSchema,
    fillRate: RatioSchema,
    averageWinningCpm: AmountSchema.nullable(),
    auctionWaitMsTotal: AmountSchema.optional(),
    averageAuctionWaitMs: AmountSchema.nullable().optional(),
    partial: z.boolean().optional(),
  })
  .refine(
    (m) =>
      m.filledOpportunities <= m.eligibleOpportunities &&
      m.eligibleOpportunities <= m.opportunities,
    {
      message: 'Filled, eligible and total opportunities must reconcile',
    },
  );

export const BidderMetricsSchema = z
  .strictObject({
    ...MetricFields,
    bidderId: IdSchema,
    requests: CounterSchema,
    // Observed offers, counted once across acceptance/rejection/late observations.
    responses: CounterSchema,
    acceptedResponses: CounterSchema.optional(),
    rejectedResponses: CounterSchema.optional(),
    timeouts: CounterSchema.optional(),
    noBids: CounterSchema.optional(),
    eligibleResponses: CounterSchema,
    lateResponses: CounterSchema,
    wins: CounterSchema,
    responseRate: RatioSchema,
    winRate: RatioSchema,
    averageLatencyMs: AmountSchema.nullable(),
  })
  .refine(
    (m) =>
      m.responses <= m.requests &&
      m.eligibleResponses + m.lateResponses <= m.responses &&
      m.wins <= m.eligibleResponses &&
      (m.acceptedResponses === undefined || m.acceptedResponses <= m.responses) &&
      (m.rejectedResponses === undefined || m.rejectedResponses <= m.responses) &&
      (m.acceptedResponses === undefined ||
        m.rejectedResponses === undefined ||
        m.acceptedResponses + m.rejectedResponses === m.responses) &&
      (m.timeouts === undefined || m.timeouts <= m.requests) &&
      (m.noBids === undefined || m.noBids <= m.requests),
    {
      message: 'Bidder counts must reconcile; timeout can coexist with a late offer',
    },
  );

export type AuctionEvent = z.infer<typeof AuctionEventSchema>;
export type NormalizedAuctionEvent = z.infer<typeof CanonicalAuctionEventSchema>;
export type OfferDetails = z.infer<typeof OfferDetailsSchema>;
export type BidTargeting = z.infer<typeof BidTargetingSchema>;
export type DailyMetrics = z.infer<typeof DailyMetricsSchema>;
export type BidderMetrics = z.infer<typeof BidderMetricsSchema>;
