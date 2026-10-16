import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterAll, expect, it } from 'vitest';
import {
  DatasetDescriptorSchema,
  PrebidConfigurationSchema,
  getBannerFloorRule,
  getEffectiveBannerFloor,
  getGlobalBannerFloor,
  getSlotFloorOverride,
  renameSlotFloorOverride,
  setGlobalBannerFloor,
  setSlotFloorOverride,
  compareAuctionEvents,
  expandAuctionRecord,
  groupAuctionRecords,
} from '../../packages/shared/src/index.js';
import type {
  AuctionRecord,
  DatasetDescriptor,
  NormalizedAuctionEvent,
} from '../../packages/shared/src/index.js';
import { createDatabaseClient } from '../../apps/api/src/db/client.js';
import { initializeDatabase } from '../../apps/api/src/db/initialize.js';
import { tableDefinitions } from '../../apps/api/src/db/tables.js';
import {
  PublisherDataRepository,
  auctionPartitionKey,
  eventItem,
  eventPartitionKey,
  queryPublisherPages,
} from '../../apps/api/src/db/publisher-data.js';
import { PublisherDataWriter } from '../../apps/api/src/db/publisher-data-writes.js';
import {
  aggregateDay,
  canonicalJson,
  createEventHasher,
} from '../../apps/api/src/domain/aggregation.js';
import { resolvePrebidAuction } from '../../apps/api/src/domain/prebid-configuration.js';
import type { ExecutionContext } from '../../apps/api/src/domain/interfaces.js';
import { reconcilePublisherData } from '../../apps/api/src/commands/data-reconcile.js';
import {
  PUBLISHER_IDS,
  createTimeline,
  createPrebidProfile,
  loadingDescriptor,
} from '../../scripts/phase-3-data/configuration.js';
import { generateDay, simulateAuction } from '../../scripts/phase-3-data/simulation.js';
import { Dashboard } from '../../apps/api/src/domain/dashboard.js';
import { Analytics } from '../../apps/api/src/domain/analytics.js';

const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const { DeleteTableCommand } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');
const suite = randomUUID().replaceAll('-', '');
const prefix = `bid-test-phase3-auctions-${suite}`;
const date = '2026-08-24';
const client = createDatabaseClient({
  endpoint: process.env.DYNAMODB_ENDPOINT ?? 'http://127.0.0.1:8000',
  tablePrefix: prefix,
  region: process.env.AWS_REGION ?? 'local',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'local',
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'local',
});
const document = DynamoDBDocumentClient.from(client);
const reader = new PublisherDataRepository(client, prefix);
const writer = new PublisherDataWriter(client, prefix);
let ownsTables = false;

function context(publisherId: string): ExecutionContext {
  // Storage tests exercise a trusted repository boundary, not the authorization resolver.
  return {
    identity: { userId: `test-${publisherId}`, publisherId },
    correlationId: suite,
    signal: new AbortController().signal,
  } as ExecutionContext;
}

function descriptor(publisherId: (typeof PUBLISHER_IDS)[number]): DatasetDescriptor {
  const { storageFormat: _format, ...legacy } = loadingDescriptor(publisherId);
  return DatasetDescriptorSchema.parse({
    ...legacy,
    ...(publisherId === 'publisher-a' ? { storageFormat: 'auctions' } : {}),
    observedThrough: `${date}T23:59:59.999Z`,
    availablePeriod: { startDate: date, endDate: date },
    partialDates: [date],
  });
}

function selectedAuctions(events: readonly NormalizedAuctionEvent[]): AuctionRecord[] {
  const records = groupAuctionRecords(events);
  const selected = new Set(records.slice(0, 26));
  const overlapping = records.findIndex((record, index) => {
    const next = records[index + 1];
    return next && expandAuctionRecord(record).at(-1)!.timestamp > next.startedAt;
  });
  expect(overlapping).toBeGreaterThanOrEqual(0);
  selected.add(records[overlapping]!);
  selected.add(records[overlapping + 1]!);

  for (const condition of [
    (record: AuctionRecord) =>
      record.bidders.some((bidder) => bidder.response?.type === 'bidRejected'),
    (record: AuctionRecord) => record.bidders.some((bidder) => bidder.response?.late),
    (record: AuctionRecord) => record.bidders.some((bidder) => !bidder.response && bidder.done),
    (record: AuctionRecord) => record.bidders.some((bidder) => bidder.timeout),
    (record: AuctionRecord) => record.bidders.every((bidder) => !bidder.candidate),
  ]) {
    const record = records.find(condition);
    expect(record).toBeDefined();
    selected.add(record!);
  }
  return [...selected];
}

async function partitionPages(partition: string) {
  const pages: Record<string, unknown>[][] = [];
  for await (const page of queryPublisherPages(document, `${prefix}-publisher-data`, {
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': partition },
    Limit: 3,
  }))
    pages.push(page);
  return pages;
}

afterAll(async () => {
  try {
    // Exact UUID-owned names only: never enumerate, reset or delete foreign/demo tables.
    if (ownsTables) {
      if (prefix !== `bid-test-phase3-auctions-${suite}`)
        throw new Error('Test cleanup ownership invariant failed');
      for (const table of tableDefinitions(prefix)) {
        try {
          await client.send(new DeleteTableCommand({ TableName: table.name }));
        } catch (error) {
          if (!(error instanceof Error && error.name === 'ResourceNotFoundException')) throw error;
        }
      }
    }
  } finally {
    client.destroy();
  }
});

it('optional per-slot floors preserve legacy snapshots and use native package rule precedence', () => {
  const profile = createPrebidProfile('publisher-a', 0.8, 1000);
  const original = canonicalJson(profile);
  const first = profile.adUnits[0]!.code;
  const second = profile.adUnits[1]!.code;
  const third = profile.adUnits[2]!.code;

  expect(canonicalJson(PrebidConfigurationSchema.parse(profile))).toBe(original);
  expect(getGlobalBannerFloor(profile)).toBe(0.8);
  expect(getSlotFloorOverride(profile, first)).toBeUndefined();
  expect(getEffectiveBannerFloor(profile, first)).toBe(0.8);
  expect(getBannerFloorRule(profile, first)).toBe('banner');

  const roundTrip = structuredClone(profile);
  setSlotFloorOverride(roundTrip, first, 0);
  setSlotFloorOverride(roundTrip, first, undefined);
  expect(canonicalJson(roundTrip)).toBe(original);

  setSlotFloorOverride(profile, first, 0);
  setSlotFloorOverride(profile, second, 2);
  expect(PrebidConfigurationSchema.parse(profile)).toEqual(profile);
  expect(profile.setConfig.floors.data.schema.fields).toEqual(['adUnitCode', 'mediaType']);
  expect(getGlobalBannerFloor(profile)).toBe(0.8);
  expect(getEffectiveBannerFloor(profile, first)).toBe(0);
  expect(getBannerFloorRule(profile, first)).toBe(`${first}|banner`);
  expect(getEffectiveBannerFloor(profile, second)).toBe(2);
  expect(getEffectiveBannerFloor(profile, third)).toBe(0.8);
  expect(getBannerFloorRule(profile, third)).toBe('*|banner');
  expect(resolvePrebidAuction(profile, first).floorCpm).toBe(0);

  setGlobalBannerFloor(profile, 0.9);
  expect(getEffectiveBannerFloor(profile, third)).toBe(0.9);
  expect(getEffectiveBannerFloor(profile, first)).toBe(0);
  renameSlotFloorOverride(profile, first, 'renamed-slot');
  profile.adUnits[0]!.code = 'renamed-slot';
  expect(getSlotFloorOverride(profile, first)).toBeUndefined();
  expect(getSlotFloorOverride(profile, 'renamed-slot')).toBe(0);
  expect(PrebidConfigurationSchema.safeParse(profile).success).toBe(true);

  const defaultFloor = profile.setConfig.floors.data.default;
  setSlotFloorOverride(profile, second, undefined);
  setSlotFloorOverride(profile, 'renamed-slot', undefined);
  expect(profile.setConfig.floors.data).toEqual({
    currency: 'USD',
    schema: { fields: ['mediaType'], delimiter: '|' },
    values: { banner: 0.9 },
    default: defaultFloor,
  });
  expect(PrebidConfigurationSchema.safeParse(profile).success).toBe(true);
});

it('optional per-slot floors reject invalid ranges, orphan rules and ambiguous slot identities', () => {
  const legacy = createPrebidProfile('publisher-a', 0.8, 1000);
  const first = legacy.adUnits[0]!.code;

  for (const value of [-0.01, 100.01, Number.NaN]) {
    const profile = structuredClone(legacy);
    setSlotFloorOverride(profile, first, value);
    expect(PrebidConfigurationSchema.safeParse(profile).success).toBe(false);
  }

  for (const code of ['*', 'with|separator', 'with*wildcard']) {
    const profile = structuredClone(legacy);
    profile.adUnits[0]!.code = code;
    expect(PrebidConfigurationSchema.safeParse(profile).success).toBe(true);
    setSlotFloorOverride(profile, code, 1);
    expect(PrebidConfigurationSchema.safeParse(profile).success).toBe(false);
  }

  const orphan = structuredClone(legacy);
  setSlotFloorOverride(orphan, 'unknown-slot', 1);
  expect(PrebidConfigurationSchema.safeParse(orphan).success).toBe(false);

  const missingBase = structuredClone(legacy);
  setSlotFloorOverride(missingBase, first, 1);
  delete (missingBase.setConfig.floors.data.values as Record<string, number>)['*|banner'];
  expect(PrebidConfigurationSchema.safeParse(missingBase).success).toBe(false);

  const wrongMediaType = structuredClone(legacy);
  setSlotFloorOverride(wrongMediaType, first, 1);
  (wrongMediaType.setConfig.floors.data.values as Record<string, number>)[`${first}|video`] = 1;
  expect(PrebidConfigurationSchema.safeParse(wrongMediaType).success).toBe(false);
});

it('optional per-slot floors replay simulation and aggregation with exact matched-rule evidence', () => {
  const timeline = createTimeline('publisher-a');
  const initial = timeline.history[0]!;
  const profile = structuredClone(initial.afterPrebid);
  const first = profile.adUnits[0]!.code;
  const second = profile.adUnits[1]!.code;
  const third = profile.adUnits[2]!.code;
  setSlotFloorOverride(profile, first, 0);
  setSlotFloorOverride(profile, second, 2);
  const history = [{ ...initial, afterPrebid: profile }];
  const events = profile.adUnits.flatMap((unit, index) =>
    simulateAuction({
      publisherId: 'publisher-a',
      auctionId: `slot-floor-${index}`,
      startedAt: `2026-08-24T12:0${index}:00.000Z`,
      configurationVersion: initial.version,
      profile,
      adUnitCode: unit.code,
      outcomes: unit.bids.map((bid) => ({ bidderId: bid.bidder, cpm: 1, latencyMs: 100 })),
    }),
  );
  const offers = events.filter(
    (event) => event.type === 'bidResponse' || event.type === 'bidRejected',
  );
  expect(
    offers
      .filter((offer) => offer.adUnitId === first)
      .every((offer) => offer.offer.floorCpm === 0 && offer.offer.floorRule === `${first}|banner`),
  ).toBe(true);
  expect(
    offers
      .filter((offer) => offer.adUnitId === second)
      .every(
        (offer) =>
          offer.type === 'bidRejected' &&
          offer.offer.floorCpm === 2 &&
          offer.offer.floorRule === `${second}|banner`,
      ),
  ).toBe(true);
  expect(
    offers
      .filter((offer) => offer.adUnitId === third)
      .every((offer) => offer.offer.floorCpm === 0.8 && offer.offer.floorRule === '*|banner'),
  ).toBe(true);

  const result = aggregateDay(events, { publisherId: 'publisher-a', date, history });
  expect(result.daily.auctions).toBe(3);
  expect(result.daily.filledOpportunities).toBe(2);
  expect(result.daily.estimatedRevenue).toBe(0.002);

  const corrupted = structuredClone(events);
  const offer = corrupted.find(
    (event) => event.type === 'bidResponse' && event.adUnitId === first,
  )!;
  if (offer.type === 'bidResponse') offer.offer.floorRule = 'banner';
  expect(() => aggregateDay(corrupted, { publisherId: 'publisher-a', date, history })).toThrow(
    /matched floor mismatch/,
  );

  for (const controls of [
    { enabled: false },
    { skipRate: 100 },
    { enforcement: { ...profile.setConfig.floors.enforcement, enforceJS: false } },
  ]) {
    const bypassed = structuredClone(profile);
    Object.assign(bypassed.setConfig.floors, controls);
    const replay = simulateAuction({
      publisherId: 'publisher-a',
      auctionId: 'slot-floor-disabled',
      startedAt: '2026-08-24T13:00:00.000Z',
      configurationVersion: initial.version,
      profile: bypassed,
      adUnitCode: second,
      outcomes: bypassed.adUnits[1]!.bids.map((bid) => ({
        bidderId: bid.bidder,
        cpm: 1,
        latencyMs: 100,
      })),
    });
    expect(replay.some((event) => event.type === 'bidRejected')).toBe(false);
    expect(
      aggregateDay(replay, {
        publisherId: 'publisher-a',
        date,
        history: [{ ...initial, afterPrebid: bypassed }],
      }).daily.filledOpportunities,
    ).toBe(1);
  }
});

it('persists one row per auction with lossless ordered reconciliation and legacy event compatibility', async () => {
  ownsTables = true;
  await initializeDatabase(client, prefix);
  const loading = PUBLISHER_IDS.map(descriptor);
  await writer.preflightEmpty(loading);
  await writer.claimDatasets(loading);
  const timelines = PUBLISHER_IDS.map(createTimeline);
  await writer.writeConfigurations(
    timelines.map((timeline) => timeline.current),
    timelines.flatMap((timeline) => timeline.history),
  );

  const ready: DatasetDescriptor[] = [];
  for (const [index, publisherId] of PUBLISHER_IDS.entries()) {
    const timeline = timelines[index]!;
    const generated = generateDay(publisherId, date, timeline.history);
    const records =
      publisherId === 'publisher-a'
        ? selectedAuctions(generated.events)
        : groupAuctionRecords(generated.events).slice(0, 3);
    const ids = new Set(records.map((record) => record.auctionId));
    const expectedEvents = generated.events.filter((event) => ids.has(event.auctionId));

    if (publisherId === 'publisher-a') {
      // Reverse input order so neither insertion order nor per-auction expansion can
      // accidentally stand in for the global chronological event order.
      await writer.writeAuctions([...records].reverse());
      const pages = await partitionPages(auctionPartitionKey(publisherId, date));
      expect(pages.length).toBeGreaterThan(1);
      expect(pages.flat()).toHaveLength(records.length);
      expect((await partitionPages(eventPartitionKey(publisherId, date))).flat()).toEqual([]);
      expect(records.flatMap(expandAuctionRecord).sort(compareAuctionEvents)).toEqual(
        expectedEvents,
      );
    } else {
      for (const event of expectedEvents)
        await document.send(
          new PutCommand({ TableName: `${prefix}-publisher-data`, Item: eventItem(event) }),
        );
      expect((await partitionPages(eventPartitionKey(publisherId, date))).flat()).toHaveLength(
        expectedEvents.length,
      );
      expect((await partitionPages(auctionPartitionKey(publisherId, date))).flat()).toEqual([]);
    }

    expect((await reader.readDataset(publisherId))?.status).toBe('loading');
    await expect(
      reader.daily(context(publisherId), loading[index]!.availablePeriod),
    ).rejects.toMatchObject({
      status: 503,
    });
    await expect(
      new Dashboard(reader).query(context(publisherId), {
        view: {
          kind: 'publisher-performance',
          metric: 'estimatedRevenue',
          period: loading[index]!.availablePeriod,
        },
        page: 1,
        pageSize: 20,
      }),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      reconcilePublisherData(client, prefix, publisherId, { write: false }),
    ).rejects.toThrow('DATASET_NOT_READY');

    const observedEvents: NormalizedAuctionEvent[] = [];
    for await (const event of reader.readEvents(publisherId, date)) observedEvents.push(event);
    expect(observedEvents).toEqual(expectedEvents);
    const original = aggregateDay(expectedEvents, {
      publisherId,
      date,
      history: timeline.history,
      startAt: loading[index]!.observedFrom,
      endAt: loading[index]!.observedThrough,
      partial: true,
    });
    const expectedHash = createEventHasher();
    expectedHash.add(timeline);
    for (const event of expectedEvents) expectedHash.add(event);
    expectedHash.add({ daily: original.daily, bidders: original.bidders });
    const observed = await reconcilePublisherData(client, prefix, publisherId, {
      allowLoading: true,
      write: false,
    });
    expect(observed.daily).toEqual([original.daily]);
    expect(observed.bidders).toEqual(original.bidders);
    expect(observed.descriptor.contentHash).toBe(expectedHash.digest());
    expect(observed.descriptor.counts).toEqual({
      events: expectedEvents.length,
      auctions: records.length,
      dailyMetrics: 1,
      bidderMetrics: 5,
    });
    await writer.writeMetrics(observed.daily, observed.bidders);
    ready.push(observed.descriptor);
  }

  await writer.activateDatasets(ready);
  for (const [index, publisherId] of PUBLISHER_IDS.entries()) {
    expect(await reader.readDataset(publisherId)).toEqual(ready[index]);
    const persisted = await reconcilePublisherData(client, prefix, publisherId, { write: false });
    expect(persisted.descriptor).toEqual(ready[index]);
    expect(await reader.daily(context(publisherId), ready[index]!.availablePeriod)).toHaveLength(1);
    expect(await reader.bidders(context(publisherId), ready[index]!.availablePeriod)).toHaveLength(
      5,
    );
    const period = ready[index]!.availablePeriod;
    const dashboard = await new Dashboard(reader).query(context(publisherId), {
      view: {
        kind: 'bidder-performance',
        metric: 'averageLatencyMs',
        period,
        bidderIds: ['beacon'],
      },
      page: 1,
      pageSize: 20,
    });
    const tool = await new Analytics(reader).bidderPerformance(context(publisherId), period);
    expect(dashboard.bidders).toEqual(
      tool.data?.kind === 'bidder-performance'
        ? tool.data.bidders.filter((row) => row.bidderId === 'beacon')
        : [],
    );
    expect(dashboard.coverage[0]?.partialDates).toEqual([date]);
    expect(
      tool.evidence.find((entry) => entry.bidderId === 'beacon')?.analytics?.coverage[0]
        ?.partialDates,
    ).toEqual([date]);
    expect(dashboard.records).toHaveLength(1);
    expect(dashboard.records[0]?.publisherId).toBe(publisherId);
    expect(dashboard.availableBidderIds).toHaveLength(5);
  }
  await expect(writer.preflightEmpty(loading)).rejects.toThrow('DATA_CONFLICT');
});
