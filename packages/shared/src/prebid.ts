import { z } from 'zod';
import { AmountSchema, IdSchema } from './common.js';

export const PREBID_VERSION = '11.41.0' as const;
export const MockBidderIdSchema = z.enum(['atlas', 'beacon', 'cedar', 'delta', 'ember']);
export const BannerSizeSchema = z.tuple([
  z.number().int().positive().max(10_000),
  z.number().int().positive().max(10_000),
]);
const TimeoutSchema = z.number().int().min(100).max(10_000);
const uniqueIds = (ids: readonly string[]) => new Set(ids).size === ids.length;

// A bounded, declarative banner profile, not an arbitrary pbjs.setConfig parser.
// Functions, live SSP credentials, optional modules and mixed currencies are excluded.
export const PrebidConfigurationSchema = z
  .strictObject({
    version: z.literal(PREBID_VERSION),
    modules: z
      .array(z.enum(['priceFloors', 'currency']))
      .length(2)
      .refine(uniqueIds, { message: 'Profile modules must be unique' }),
    setConfig: z.strictObject({
      debug: z.boolean(),
      bidderTimeout: TimeoutSchema,
      bidderSequence: z.literal('fixed'),
      maxRequestsPerOrigin: z.number().int().min(1).max(16),
      useBidCache: z.literal(false),
      ttlBuffer: z.number().min(0).max(60),
      priceGranularity: z.enum(['low', 'medium', 'high', 'auto', 'dense']),
      enableSendAllBids: z.boolean(),
      deviceAccess: z.literal(false),
      userSync: z.strictObject({ syncEnabled: z.literal(false) }),
      currency: z.strictObject({
        adServerCurrency: z.literal('USD'),
        granularityMultiplier: z.literal(1),
        rates: z.strictObject({ USD: z.strictObject({ USD: z.literal(1) }) }),
      }),
      floors: z.strictObject({
        enabled: z.boolean(),
        skipRate: z.number().int().min(0).max(100),
        enforcement: z.strictObject({
          enforceJS: z.boolean(),
          enforceBidders: z
            .array(z.union([MockBidderIdSchema, z.literal('*')]))
            .min(1)
            .max(6)
            .refine(uniqueIds, { message: 'Enforced bidder IDs must be unique' }),
          enforcePBS: z.literal(false),
          floorDeals: z.literal(false),
          bidAdjustment: z.boolean(),
        }),
        data: z.strictObject({
          currency: z.literal('USD'),
          schema: z.strictObject({
            fields: z.tuple([z.literal('mediaType')]),
            delimiter: z.literal('|'),
          }),
          values: z.strictObject({ banner: AmountSchema.max(100) }),
          default: AmountSchema.max(100),
        }),
      }),
    }),
    adUnits: z
      .array(
        z.strictObject({
          code: IdSchema,
          mediaTypes: z.strictObject({
            banner: z.strictObject({ sizes: z.array(BannerSizeSchema).min(1).max(10) }),
          }),
          bids: z
            .array(
              z.strictObject({
                bidder: MockBidderIdSchema,
                // placementId is this mock adapter contract, not a universal SSP field.
                params: z.strictObject({ placementId: IdSchema }),
              }),
            )
            .min(1)
            .max(5)
            .refine((bids) => uniqueIds(bids.map((bid) => bid.bidder)), {
              message: 'Ad-unit bidder IDs must be unique',
            }),
        }),
      )
      .min(1)
      .max(10)
      .refine((units) => uniqueIds(units.map((unit) => unit.code)), {
        message: 'Ad-unit codes must be unique',
      }),
    bidderSettings: z.strictObject({}),
    // Concrete auction ID/selection is recorded at runtime, not baked into this template.
    requestBids: z.strictObject({ timeout: TimeoutSchema.optional() }),
    mockAdapters: z
      .array(
        z.strictObject({
          bidder: MockBidderIdSchema,
          origin: z.url().max(500),
          parameterContract: z.literal('synthetic-placement-v1'),
        }),
      )
      .min(1)
      .max(5)
      .refine((adapters) => uniqueIds(adapters.map((adapter) => adapter.bidder)), {
        message: 'Mock adapter IDs must be unique',
      }),
  })
  .refine(
    (profile) =>
      profile.adUnits.every((unit) =>
        unit.bids.every((bid) =>
          profile.mockAdapters.some((adapter) => adapter.bidder === bid.bidder),
        ),
      ),
    { message: 'Every configured bidder must have a registered mock adapter specification' },
  );

export const ConfigurationParameterImpactSchema = z.strictObject({
  path: z.string().min(1).max(150),
  support: z.enum(['modeled', 'validated-inactive', 'excluded']),
  description: z.string().min(1).max(500),
  publisherImpact: z.string().min(1).max(500),
  visitorImpact: z.string().min(1).max(500),
  source: z.url().max(500),
});

export type BannerSize = z.infer<typeof BannerSizeSchema>;
export type MockBidderId = z.infer<typeof MockBidderIdSchema>;
export type PrebidConfiguration = z.infer<typeof PrebidConfigurationSchema>;
export type ConfigurationParameterImpact = z.infer<typeof ConfigurationParameterImpactSchema>;
