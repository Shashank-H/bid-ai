import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterAll, expect, it } from 'vitest';
import {
  DatasetDescriptorSchema,
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
import { aggregateDay, createEventHasher } from '../../apps/api/src/domain/aggregation.js';
import type { ExecutionContext } from '../../apps/api/src/domain/interfaces.js';
import { reconcilePublisherData } from '../../apps/api/src/commands/data-reconcile.js';
import {
  PUBLISHER_IDS,
  createTimeline,
  loadingDescriptor,
} from '../../scripts/phase-3-data/configuration.js';
import { generateDay } from '../../scripts/phase-3-data/simulation.js';

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
  }
  await expect(writer.preflightEmpty(loading)).rejects.toThrow('DATA_CONFLICT');
});
