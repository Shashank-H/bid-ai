import { afterEach, describe, expect, it, vi } from 'vitest';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  AuctionRecordSchema,
  CanonicalAuctionEventSchema,
  PREBID_VERSION,
  auctionRecordFromEvents,
  compareAuctionEvents,
  expandAuctionRecord,
  groupAuctionRecords,
} from '@bid/shared';
import type { DatasetDescriptor, NormalizedAuctionEvent } from '@bid/shared';
import { hashCanonical } from '../domain/aggregation.js';
import { PublisherDataWriter } from './publisher-data-writes.js';
import {
  auctionPartitionKey,
  auctionRecordItem,
  datasetKey,
  eventItem,
  PublisherDataRepository,
} from './publisher-data.js';

const BIDDER_IDS = ['atlas', 'beacon', 'cedar', 'delta', 'ember'];

// A bounded canonical fixture; unit tests do not depend on command-only generator code.
function auction(
  auctionId = 'auction-1',
  startedAt = '2026-08-25T12:00:00.000Z',
  mode: 'normal' | 'no-fill' | 'late' | 'silent' = 'normal',
): NormalizedAuctionEvent[] {
  const started = Date.parse(startedAt);
  const iso = (offset: number) => new Date(started + offset).toISOString();
  const cutoff = mode === 'late' || mode === 'silent' ? 1000 : 180;
  const core = {
    publisherId: 'publisher-a',
    auctionId,
    adUnitId: 'slot-1',
    configurationVersion: 1,
    currency: 'USD',
  };
  let sequence = 0;
  const events: NormalizedAuctionEvent[] = [];
  const add = (offset: number, details: Record<string, unknown>) => {
    const event = CanonicalAuctionEventSchema.parse({
      ...core,
      eventId: `${auctionId}:${String(sequence++).padStart(3, '0')}`,
      timestamp: iso(offset),
      ...details,
    });
    events.push(event);
    return event;
  };
  add(0, {
    type: 'auctionInit',
    configuredTimeoutMs: 1000,
    effectiveTimeoutMs: 1000,
    deadlineAt: iso(1000),
    size: [300, 250],
  });
  const offers: Extract<NormalizedAuctionEvent, { type: 'bidResponse' }>[] = [];
  for (const [index, bidderId] of BIDDER_IDS.entries()) {
    const bid = { bidderId, bidRequestId: `${auctionId}:${bidderId}` };
    add(1, {
      ...bid,
      type: 'bidRequested',
      auctionTimeoutMs: 1000,
      placementId: `placement-${bidderId}`,
      size: [300, 250],
    });
    const silent = mode === 'silent' && index === 0;
    const arrival = mode === 'late' && index === 0 ? 1300 : 100 + index * 20;
    const noBid = mode === 'no-fill' || silent;
    if (silent || arrival > cutoff) add(cutoff, { ...bid, type: 'bidTimeout' });
    if (!noBid) {
      const cpm = index === 4 ? 0.5 : 2 - index * 0.1;
      const late = arrival > cutoff;
      const rejected = cpm < 0.8;
      const response = add(arrival, {
        ...bid,
        type: rejected ? 'bidRejected' : 'bidResponse',
        cpm,
        latencyMs: arrival - 1,
        late,
        eligible: !late && !rejected,
        ...(rejected ? { reason: 'floor' } : {}),
        offer: {
          originalCpm: cpm,
          originalCurrency: 'USD',
          normalizedCpm: cpm,
          comparisonCpm: cpm,
          size: [300, 250],
          creativeId: `creative-${bid.bidRequestId}`,
          netRevenue: true,
          ttlSeconds: 60,
          ttlBufferSeconds: 1,
          expiresAt: iso(arrival + 59000),
          floorRule: 'banner',
          floorCpm: 0.8,
          floorCurrency: 'USD',
          signaledFloorCpm: 0.8,
          floorEnforced: true,
          floorsSkipped: false,
          auctionCutoffAt: iso(cutoff),
          targetingBucket: cpm.toFixed(2),
        },
      });
      if (response.type === 'bidResponse' && response.eligible) offers.push(response);
    }
    if (!silent) add(arrival, { ...bid, type: 'bidderDone', noBid });
  }
  add(cutoff, {
    type: 'auctionEnd',
    cutoffAt: iso(cutoff),
    waitMs: cutoff,
    timedOut: cutoff === 1000,
  });
  const winner = offers[0];
  if (winner) {
    const bid = { bidderId: winner.bidderId, bidRequestId: winner.bidRequestId };
    const targeting = { hb_adid: winner.bidRequestId };
    add(cutoff, { ...bid, type: 'bidCandidate', cpm: winner.cpm, targeting });
    add(cutoff + 1, { ...bid, type: 'bidWon', cpm: winner.cpm, targeting });
    add(cutoff + 2, { ...bid, type: 'adRenderSucceeded', creativeId: winner.offer.creativeId });
  }
  return events.sort(compareAuctionEvents);
}

function loadingDescriptor(publisherId: string): DatasetDescriptor {
  return {
    publisherId,
    status: 'loading',
    synthetic: true,
    seed: 'unit-test',
    generatorVersion: 'unit-test',
    prebidVersion: PREBID_VERSION,
    observedFrom: '2026-08-25T00:00:00.000Z',
    observedThrough: '2026-08-25T23:59:59.999Z',
    availablePeriod: { startDate: '2026-08-25', endDate: '2026-08-25' },
    partialDates: [],
    auctionsPerDay: 1000,
  };
}

function client() {
  return new DynamoDBClient({
    region: 'local',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
}

function descriptor(): DatasetDescriptor {
  return { ...loadingDescriptor('publisher-a'), storageFormat: 'auctions' };
}

afterEach(() => vi.restoreAllMocks());

describe('one uncompressed record per auction', () => {
  it.each(['normal', 'no-fill', 'late', 'silent'] as const)(
    'round-trips all original observations and hash: %s',
    (mode) => {
      const events = auction('auction-1', undefined, mode);
      const record = auctionRecordFromEvents(events);
      const expanded = expandAuctionRecord(record);
      expect(expanded).toEqual([...events].sort(compareAuctionEvents));
      expect(hashCanonical(expanded)).toBe(hashCanonical(events));
      expect(record.bidders).toHaveLength(5);
      expect(auctionRecordItem(record).PK).toBe(auctionPartitionKey('publisher-a', '2026-08-25'));
      expect(auctionRecordItem(record).data).toMatchObject({
        format: 'auction-v1',
        auctionId: 'auction-1',
      });
    },
  );

  it('retains failed render outcomes without pretending they succeeded', () => {
    const events = auction().map((event): NormalizedAuctionEvent => {
      if (event.type !== 'adRenderSucceeded') return event;
      const { creativeId: _creativeId, ...core } = event;
      return { ...core, type: 'adRenderFailed', reason: 'synthetic render failure' };
    });
    expect(expandAuctionRecord(auctionRecordFromEvents(events))).toEqual(events);
  });

  it('rejects duplicate observations, orphan bidders, and ownership/version/date corruption', () => {
    const original = auction();
    expect(() => auctionRecordFromEvents([...original, original[0]!])).toThrow(/one init/);
    expect(() =>
      auctionRecordFromEvents([
        ...original,
        original.find((event) => event.type === 'bidderDone')!,
      ]),
    ).toThrow(/duplicate/);
    expect(() =>
      auctionRecordFromEvents(
        original.filter((event) => !(event.type === 'bidRequested' && event.bidderId === 'atlas')),
      ),
    ).toThrow(/no bidder request/);
    for (const corrupt of [
      { publisherId: 'publisher-b' },
      { configurationVersion: 2 },
      { adUnitId: 'other-unit' },
      { timestamp: '2026-08-26T12:00:00.000Z' },
    ]) {
      const record = structuredClone(auctionRecordFromEvents(original));
      Object.assign(record.bidders[0]!.request, corrupt);
      expect(AuctionRecordSchema.safeParse(record).success).toBe(false);
    }
    const record = auctionRecordFromEvents(original);
    record.bidders[0]!.request.eventId = record.init.eventId;
    expect(AuctionRecordSchema.safeParse(record).success).toBe(false);
  });

  it('groups overlapped auctions and restores original global ordering across SDK pages', async () => {
    const events = [
      ...auction('auction-2', '2026-08-25T12:00:00.050Z', 'late'),
      ...auction('auction-1'),
    ].sort(compareAuctionEvents);
    const records = groupAuctionRecords(events);
    const items = records.map(auctionRecordItem);
    const send = vi
      .spyOn(DynamoDBDocumentClient.prototype, 'send')
      .mockImplementation(async (command) => {
        const input = command.input as Record<string, unknown>;
        if ('Key' in input) return { Item: { ...datasetKey('publisher-a'), data: descriptor() } };
        return input['ExclusiveStartKey']
          ? { Items: [items[1]] }
          : { Items: [items[0]], LastEvaluatedKey: { PK: items[0]!.PK, SK: items[0]!.SK } };
      });
    const db = client();
    try {
      const read: NormalizedAuctionEvent[] = [];
      for await (const event of new PublisherDataRepository(
        db,
        'bid-test-auction-record',
      ).readEvents('publisher-a', '2026-08-25'))
        read.push(event);
      expect(read).toEqual(events);
      expect(hashCanonical(read)).toBe(hashCanonical(events));
      expect(send).toHaveBeenCalledTimes(3);
    } finally {
      db.destroy();
    }
  });

  it('keeps legacy event-row datasets readable', async () => {
    const events = auction();
    vi.spyOn(DynamoDBDocumentClient.prototype, 'send').mockImplementation(async (command) =>
      'Key' in command.input
        ? { Item: { ...datasetKey('publisher-a'), data: loadingDescriptor('publisher-a') } }
        : { Items: events.map(eventItem) },
    );
    const db = client();
    try {
      const read: NormalizedAuctionEvent[] = [];
      for await (const event of new PublisherDataRepository(
        db,
        'bid-test-auction-record',
      ).readEvents('publisher-a', '2026-08-25'))
        read.push(event);
      expect(read).toEqual(events);
    } finally {
      db.destroy();
    }
  });

  it('checks aborts before sending any read request', async () => {
    const send = vi.spyOn(DynamoDBDocumentClient.prototype, 'send');
    const db = client();
    try {
      const read = new PublisherDataRepository(db, 'bid-test-auction-record').readEvents(
        'publisher-a',
        '2026-08-25',
        AbortSignal.abort(),
      );
      await expect(read.next()).rejects.toMatchObject({ name: 'AbortError' });
      expect(send).not.toHaveBeenCalled();
    } finally {
      db.destroy();
    }
  });

  it('writes 26 auctions as 25 + 1 physical items, never individual event rows', async () => {
    const records = Array.from({ length: 26 }, (_, index) =>
      auctionRecordFromEvents(auction(`auction-${index}`)),
    );
    const send = vi.spyOn(DynamoDBDocumentClient.prototype, 'send').mockResolvedValue({});
    const db = client();
    try {
      await new PublisherDataWriter(db, 'bid-test-auction-record').writeAuctions(records);
      expect(send).toHaveBeenCalledTimes(2);
      const batches = send.mock.calls.map(
        ([command]) =>
          (command.input as { RequestItems: Record<string, unknown[]> }).RequestItems[
            'bid-test-auction-record-publisher-data'
          ]!,
      );
      expect(batches.map((batch) => batch.length)).toEqual([25, 1]);
      expect(JSON.stringify(batches)).not.toContain('#EVENTS#');
      expect(JSON.stringify(batches)).toContain('#AUCTIONS#');
    } finally {
      db.destroy();
    }
  });

  it('validates all auctions and duplicates before beginning a write', async () => {
    const record = auctionRecordFromEvents(auction());
    const invalid = structuredClone(record);
    invalid.publisherId = 'publisher-b';
    const send = vi.spyOn(DynamoDBDocumentClient.prototype, 'send').mockResolvedValue({});
    const db = client();
    const writer = new PublisherDataWriter(db, 'bid-test-auction-record');
    try {
      await expect(writer.writeAuctions([record, invalid])).rejects.toThrow();
      await expect(writer.writeAuctions([record, record])).rejects.toThrow(/duplicate/);
      expect(send).not.toHaveBeenCalled();
    } finally {
      db.destroy();
    }
  });

  it('retries only the unprocessed auction items', async () => {
    const records = [
      auctionRecordFromEvents(auction('auction-1')),
      auctionRecordFromEvents(auction('auction-2')),
    ];
    const pending = { PutRequest: { Item: auctionRecordItem(records[1]!) } };
    const table = 'bid-test-auction-record-publisher-data';
    const send = vi
      .spyOn(DynamoDBDocumentClient.prototype, 'send')
      .mockResolvedValueOnce({ UnprocessedItems: { [table]: [pending] } })
      .mockResolvedValueOnce({});
    const db = client();
    try {
      await new PublisherDataWriter(db, 'bid-test-auction-record').writeAuctions(records);
      expect(send).toHaveBeenCalledTimes(2);
      expect((send.mock.calls[1]![0].input as { RequestItems: unknown }).RequestItems).toEqual({
        [table]: [pending],
      });
    } finally {
      db.destroy();
    }
  });

  it('checks cancellation before sending any auction writes', async () => {
    const send = vi.spyOn(DynamoDBDocumentClient.prototype, 'send').mockResolvedValue({});
    const db = client();
    try {
      await expect(
        new PublisherDataWriter(db, 'bid-test-auction-record').writeAuctions(
          [auctionRecordFromEvents(auction())],
          AbortSignal.abort(),
        ),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(send).not.toHaveBeenCalled();
    } finally {
      db.destroy();
    }
  });

  it('enforces the conservative byte-size guard before any auction write', async () => {
    const record = auctionRecordFromEvents(auction());
    const byteLength = vi.spyOn(Buffer, 'byteLength').mockReturnValue(400 * 1024);
    const send = vi.spyOn(DynamoDBDocumentClient.prototype, 'send').mockResolvedValue({});
    const db = client();
    try {
      await expect(
        new PublisherDataWriter(db, 'bid-test-auction-record').writeAuctions([record]),
      ).rejects.toThrow(/item size/);
      expect(send).not.toHaveBeenCalled();
    } finally {
      byteLength.mockRestore();
      db.destroy();
    }
  });

  it('rejects wrong publisher keys from stored auction records', async () => {
    const item = auctionRecordItem(auctionRecordFromEvents(auction()));
    item.PK = auctionPartitionKey('publisher-b', '2026-08-25');
    vi.spyOn(DynamoDBDocumentClient.prototype, 'send').mockImplementation(async (command) =>
      'Key' in command.input
        ? { Item: { ...datasetKey('publisher-a'), data: descriptor() } }
        : { Items: [item] },
    );
    const db = client();
    try {
      const read = new PublisherDataRepository(db, 'bid-test-auction-record').readEvents(
        'publisher-a',
        '2026-08-25',
      );
      await expect(read.next()).rejects.toThrow(/ownership/);
    } finally {
      db.destroy();
    }
  });

  it('refuses an orphan auction partition during preflight even for legacy descriptors', async () => {
    const send = vi
      .spyOn(DynamoDBDocumentClient.prototype, 'send')
      .mockImplementation(async (command) => {
        const input = command.input as {
          Select?: string;
          ExpressionAttributeValues?: Record<string, string>;
        };
        if (!input.Select) return { Items: [] };
        return { Count: input.ExpressionAttributeValues?.[':pk']?.includes('#AUCTIONS#') ? 1 : 0 };
      });
    const db = client();
    try {
      await expect(
        new PublisherDataWriter(db, 'bid-test-auction-record').preflightEmpty([
          loadingDescriptor('publisher-a'),
          loadingDescriptor('publisher-b'),
        ]),
      ).rejects.toThrow(/DATA_CONFLICT/);
      expect(send).toHaveBeenCalledTimes(3);
    } finally {
      db.destroy();
    }
  });
});
