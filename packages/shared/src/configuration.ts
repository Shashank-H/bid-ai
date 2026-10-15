import { z } from 'zod';
import { CurrencySchema, IdSchema, TimestampSchema } from './common.js';
import { PrebidConfigurationSchema } from './prebid.js';
import type { PrebidConfiguration } from './prebid.js';

export const ConfigurationSettingsSchema = z.strictObject({
  floorCpm: z.number().min(0).max(100),
  auctionTimeoutMs: z.number().int().min(100).max(10_000),
  enabledBidders: z
    .array(IdSchema)
    .min(1)
    .max(50)
    .refine((ids) => new Set(ids).size === ids.length, { message: 'Bidder IDs must be unique' }),
  currency: CurrencySchema,
});

export const ConfigurationSchema = z.strictObject({
  publisherId: IdSchema,
  version: z.number().int().positive(),
  updatedAt: TimestampSchema,
  updatedByUserId: IdSchema,
  settings: ConfigurationSettingsSchema,
  // Optional only for legacy fixture compatibility. Persisted seed records require it.
  prebid: PrebidConfigurationSchema.optional(),
  syntheticAttribution: z.literal(true).optional(),
});

export const ConfigurationHistorySchema = z
  .strictObject({
    historyId: IdSchema,
    publisherId: IdSchema,
    version: z.number().int().positive(),
    timestamp: TimestampSchema,
    updatedByUserId: IdSchema,
    before: ConfigurationSettingsSchema.nullable(),
    after: ConfigurationSettingsSchema,
    beforePrebid: PrebidConfigurationSchema.nullable().optional(),
    afterPrebid: PrebidConfigurationSchema.optional(),
    syntheticAttribution: z.literal(true).optional(),
    proposalId: IdSchema.optional(),
    approvingUserId: IdSchema.optional(),
  })
  .refine(({ proposalId, approvingUserId }) => Boolean(proposalId) === Boolean(approvingUserId), {
    message: 'Agent-approved changes require both proposal and approver attribution',
  });

export function summarizePrebidConfiguration(prebid: PrebidConfiguration) {
  return ConfigurationSettingsSchema.parse({
    floorCpm: prebid.setConfig.floors.data.values.banner,
    auctionTimeoutMs: prebid.requestBids.timeout ?? prebid.setConfig.bidderTimeout,
    enabledBidders: [
      ...new Set(prebid.adUnits.flatMap((unit) => unit.bids.map((bid) => bid.bidder))),
    ],
    currency: prebid.setConfig.currency.adServerCurrency,
  });
}

function matchesSummary(settings: ConfigurationSettings, prebid: PrebidConfiguration): boolean {
  const summary = summarizePrebidConfiguration(prebid);
  return (
    settings.floorCpm === summary.floorCpm &&
    settings.auctionTimeoutMs === summary.auctionTimeoutMs &&
    settings.currency === summary.currency &&
    settings.enabledBidders.length === summary.enabledBidders.length &&
    settings.enabledBidders.every((bidder) => summary.enabledBidders.includes(bidder))
  );
}

export const CanonicalConfigurationSchema = ConfigurationSchema.extend({
  prebid: PrebidConfigurationSchema,
  syntheticAttribution: z.literal(true),
}).refine((record) => matchesSummary(record.settings, record.prebid), {
  message: 'Configuration summaries must be derived from the native snapshot',
});

export const CanonicalConfigurationHistorySchema = ConfigurationHistorySchema.safeExtend({
  beforePrebid: PrebidConfigurationSchema.nullable(),
  afterPrebid: PrebidConfigurationSchema,
  syntheticAttribution: z.literal(true),
}).refine(
  (record) =>
    matchesSummary(record.after, record.afterPrebid) &&
    (record.before === null
      ? record.beforePrebid === null
      : record.beforePrebid !== null && matchesSummary(record.before, record.beforePrebid)),
  { message: 'Canonical history requires native snapshots and consistent derived summaries' },
);

export type ConfigurationSettings = z.infer<typeof ConfigurationSettingsSchema>;
export type Configuration = z.infer<typeof ConfigurationSchema>;
export type ConfigurationHistory = z.infer<typeof ConfigurationHistorySchema>;
export type CanonicalConfiguration = z.infer<typeof CanonicalConfigurationSchema>;
export type CanonicalConfigurationHistory = z.infer<typeof CanonicalConfigurationHistorySchema>;
