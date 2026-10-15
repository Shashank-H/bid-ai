import {
  CanonicalConfigurationHistorySchema,
  CanonicalConfigurationSchema,
  DatasetDescriptorSchema,
  PREBID_VERSION,
  PrebidConfigurationSchema,
  summarizePrebidConfiguration,
} from '@bid/shared';
import type {
  BannerSize,
  CanonicalConfiguration,
  CanonicalConfigurationHistory,
  DatasetDescriptor,
  MockBidderId,
  PrebidConfiguration,
} from '@bid/shared';

export const DEFAULT_SEED = 'bid-intelligence-phase3-v1';
export const GENERATOR_VERSION = 'phase3-v1';
export const OBSERVED_FROM = '2026-08-24T03:30:00.000Z';
export const OBSERVED_THROUGH = '2026-10-19T03:30:00.000Z';
export const AUCTIONS_PER_DAY = 1000;
export const BIDDER_IDS: readonly MockBidderId[] = ['atlas', 'beacon', 'cedar', 'delta', 'ember'];
export const PUBLISHER_IDS = ['publisher-a', 'publisher-b'] as const;
export type SeedPublisherId = (typeof PUBLISHER_IDS)[number];

export interface PublisherTimeline {
  current: CanonicalConfiguration;
  history: CanonicalConfigurationHistory[];
}

export function createPrebidProfile(
  publisherId: SeedPublisherId,
  floorCpm: number,
  timeoutMs: number,
): PrebidConfiguration {
  const sizes: BannerSize[] = [
    [728, 90],
    [300, 250],
    [300, 600],
  ];
  return PrebidConfigurationSchema.parse({
    version: PREBID_VERSION,
    modules: ['priceFloors', 'currency'],
    setConfig: {
      debug: false,
      bidderTimeout: timeoutMs,
      bidderSequence: 'fixed',
      maxRequestsPerOrigin: 4,
      useBidCache: false,
      ttlBuffer: 1,
      priceGranularity: 'medium',
      enableSendAllBids: true,
      deviceAccess: false,
      userSync: { syncEnabled: false },
      currency: { adServerCurrency: 'USD', granularityMultiplier: 1, rates: { USD: { USD: 1 } } },
      floors: {
        enabled: true,
        skipRate: 0,
        enforcement: {
          enforceJS: true,
          enforceBidders: ['*'],
          enforcePBS: false,
          floorDeals: false,
          bidAdjustment: true,
        },
        data: {
          currency: 'USD',
          schema: { fields: ['mediaType'], delimiter: '|' },
          values: { banner: floorCpm },
          default: floorCpm,
        },
      },
    },
    adUnits: sizes.map((size, index) => ({
      code: `${publisherId}-slot-${index + 1}`,
      mediaTypes: { banner: { sizes: [size] } },
      bids: BIDDER_IDS.map((bidder) => ({
        bidder,
        params: { placementId: `${publisherId}-${bidder}-placement-${index + 1}` },
      })),
    })),
    bidderSettings: {},
    requestBids: {},
    mockAdapters: BIDDER_IDS.map((bidder) => ({
      bidder,
      origin: `https://${bidder}.mock.test`,
      parameterContract: 'synthetic-placement-v1',
    })),
  });
}

export function createTimeline(publisherId: SeedPublisherId): PublisherTimeline {
  const initial = createPrebidProfile(
    publisherId,
    publisherId === 'publisher-a' ? 0.8 : 0.6,
    publisherId === 'publisher-a' ? 1000 : 900,
  );
  const profiles = [{ timestamp: OBSERVED_FROM, prebid: initial }];
  if (publisherId === 'publisher-a') {
    profiles.push({
      timestamp: '2026-09-14T00:00:00.000Z',
      prebid: createPrebidProfile(publisherId, 1.4, 1000),
    });
  }
  const history = profiles.map((entry, index) =>
    CanonicalConfigurationHistorySchema.parse({
      publisherId,
      historyId: `${publisherId}-synthetic-v${index + 1}`,
      version: index + 1,
      timestamp: entry.timestamp,
      updatedByUserId: publisherId === 'publisher-a' ? 'demo-user-a' : 'demo-user-b',
      before: index ? summarizePrebidConfiguration(profiles[index - 1]!.prebid) : null,
      after: summarizePrebidConfiguration(entry.prebid),
      beforePrebid: index ? profiles[index - 1]!.prebid : null,
      afterPrebid: entry.prebid,
      syntheticAttribution: true,
    }),
  );
  const last = history.at(-1)!;
  return {
    history,
    current: CanonicalConfigurationSchema.parse({
      publisherId,
      version: last.version,
      updatedAt: last.timestamp,
      updatedByUserId: last.updatedByUserId,
      settings: last.after,
      prebid: last.afterPrebid,
      syntheticAttribution: true,
    }),
  };
}

export function loadingDescriptor(
  publisherId: SeedPublisherId,
  seed = DEFAULT_SEED,
): DatasetDescriptor {
  return DatasetDescriptorSchema.parse({
    publisherId,
    status: 'loading',
    storageFormat: 'auctions',
    synthetic: true,
    seed,
    generatorVersion: GENERATOR_VERSION,
    prebidVersion: PREBID_VERSION,
    observedFrom: OBSERVED_FROM,
    observedThrough: OBSERVED_THROUGH,
    availablePeriod: { startDate: '2026-08-24', endDate: '2026-10-19' },
    partialDates: ['2026-08-24', '2026-10-19'],
    auctionsPerDay: AUCTIONS_PER_DAY,
  });
}

export function datasetDates(): string[] {
  const dates: string[] = [];
  for (let time = Date.parse('2026-08-24'); time <= Date.parse('2026-10-19'); time += 86_400_000) {
    dates.push(new Date(time).toISOString().slice(0, 10));
  }
  return dates;
}
