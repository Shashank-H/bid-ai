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

const LegacyFloorDataSchema = z.strictObject({
  currency: z.literal('USD'),
  schema: z.strictObject({
    fields: z.tuple([z.literal('mediaType')]),
    delimiter: z.literal('|'),
  }),
  values: z.strictObject({ banner: AmountSchema.max(100) }),
  default: AmountSchema.max(100),
});
const SlotFloorDataSchema = z.strictObject({
  currency: z.literal('USD'),
  schema: z.strictObject({
    fields: z.tuple([z.literal('adUnitCode'), z.literal('mediaType')]),
    delimiter: z.literal('|'),
  }),
  values: z
    .record(z.string().min(1).max(135), AmountSchema.max(100))
    .refine((values) => Object.hasOwn(values, '*|banner') && Object.keys(values).length <= 11, {
      message: 'Slot floor rules require one global banner rule and at most ten overrides',
    }),
  default: AmountSchema.max(100),
});
export const PrebidFloorDataSchema = z.union([LegacyFloorDataSchema, SlotFloorDataSchema]);

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
        data: PrebidFloorDataSchema,
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
  )
  .refine(
    (profile) => {
      const data = profile.setConfig.floors.data;

      if (!hasSlotFloorRules(data)) return true;

      const codes = new Set(profile.adUnits.map((unit) => unit.code));

      return (
        [...codes].every((code) => !code.includes('*') && !code.includes('|')) &&
        Object.keys(data.values).every(
          (rule) =>
            rule === '*|banner' ||
            (rule.endsWith('|banner') && codes.has(rule.slice(0, -'|banner'.length))),
        )
      );
    },
    {
      message:
        'Slot floor rules must reference configured ad units; slot codes cannot contain * or |',
      path: ['setConfig', 'floors', 'data', 'values'],
    },
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
type FloorData = z.infer<typeof PrebidFloorDataSchema>;
type SlotFloorData = z.infer<typeof SlotFloorDataSchema>;

function hasSlotFloorRules(data: FloorData): data is SlotFloorData {
  return data.schema.fields[0] === 'adUnitCode';
}

export function getGlobalBannerFloor(profile: PrebidConfiguration): number {
  const data = profile.setConfig.floors.data;

  return hasSlotFloorRules(data) ? data.values['*|banner']! : data.values.banner;
}

export function getSlotFloorOverride(
  profile: PrebidConfiguration,
  code: string,
): number | undefined {
  const data = profile.setConfig.floors.data;

  return hasSlotFloorRules(data) ? data.values[`${code}|banner`] : undefined;
}

export function getEffectiveBannerFloor(profile: PrebidConfiguration, code: string): number {
  return getSlotFloorOverride(profile, code) ?? getGlobalBannerFloor(profile);
}

export function getBannerFloorRule(profile: PrebidConfiguration, code: string): string {
  const data = profile.setConfig.floors.data;

  if (!hasSlotFloorRules(data)) return 'banner';

  return Object.hasOwn(data.values, `${code}|banner`) ? `${code}|banner` : '*|banner';
}

export function setGlobalBannerFloor(profile: PrebidConfiguration, value: number): void {
  const data = profile.setConfig.floors.data;

  if (hasSlotFloorRules(data)) data.values['*|banner'] = value;
  else data.values.banner = value;
}

export function setSlotFloorOverride(
  profile: PrebidConfiguration,
  code: string,
  value: number | undefined,
): void {
  const data = profile.setConfig.floors.data;
  const rule = `${code}|banner`;

  if (value !== undefined) {
    if (hasSlotFloorRules(data)) data.values[rule] = value;
    else
      profile.setConfig.floors.data = {
        currency: data.currency,
        schema: { fields: ['adUnitCode', 'mediaType'], delimiter: '|' },
        values: { '*|banner': data.values.banner, [rule]: value },
        default: data.default,
      };

    return;
  }

  if (!hasSlotFloorRules(data)) return;

  delete data.values[rule];

  if (Object.keys(data.values).length === 1 && Object.hasOwn(data.values, '*|banner'))
    profile.setConfig.floors.data = {
      currency: data.currency,
      schema: { fields: ['mediaType'], delimiter: '|' },
      values: { banner: data.values['*|banner']! },
      default: data.default,
    };
}

export function renameSlotFloorOverride(
  profile: PrebidConfiguration,
  oldCode: string,
  newCode: string,
): void {
  const data = profile.setConfig.floors.data;
  const oldRule = `${oldCode}|banner`;
  const newRule = `${newCode}|banner`;

  if (oldCode === newCode || !hasSlotFloorRules(data) || !Object.hasOwn(data.values, oldRule))
    return;

  data.values[newRule] = data.values[oldRule]!;
  delete data.values[oldRule];
}
