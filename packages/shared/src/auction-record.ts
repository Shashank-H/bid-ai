import { z } from 'zod';
import { CanonicalAuctionEventSchema } from './auction.js';
import type { NormalizedAuctionEvent } from './auction.js';
import { CurrencySchema, IdSchema, TimestampSchema } from './common.js';

const BidderAuctionRecordSchema = z.strictObject({
  bidderId: IdSchema,
  request: CanonicalAuctionEventSchema.options[0],
  response: z
    .discriminatedUnion('type', [
      CanonicalAuctionEventSchema.options[1],
      CanonicalAuctionEventSchema.options[2],
    ])
    .optional(),
  done: CanonicalAuctionEventSchema.options[7].optional(),
  timeout: CanonicalAuctionEventSchema.options[6].optional(),
  candidate: CanonicalAuctionEventSchema.options[8].optional(),
  win: CanonicalAuctionEventSchema.options[3].optional(),
  render: z
    .discriminatedUnion('type', [
      CanonicalAuctionEventSchema.options[9],
      CanonicalAuctionEventSchema.options[10],
    ])
    .optional(),
});

const AuctionRecordShape = z.strictObject({
  format: z.literal('auction-v1'),
  publisherId: IdSchema,
  auctionId: IdSchema,
  adUnitId: IdSchema,
  configurationVersion: z.number().int().positive(),
  currency: CurrencySchema,
  startedAt: TimestampSchema,
  endedAt: TimestampSchema,
  init: CanonicalAuctionEventSchema.options[4],
  end: CanonicalAuctionEventSchema.options[5],
  bidders: z.array(BidderAuctionRecordSchema).min(1).max(5),
});

type RecordShape = z.infer<typeof AuctionRecordShape>;
type BidderRecord = z.infer<typeof BidderAuctionRecordSchema>;

function recordEvents(record: RecordShape): NormalizedAuctionEvent[] {
  const events: NormalizedAuctionEvent[] = [record.init, record.end];
  for (const bidder of record.bidders) {
    events.push(bidder.request);
    for (const event of [
      bidder.response,
      bidder.done,
      bidder.timeout,
      bidder.candidate,
      bidder.win,
      bidder.render,
    ])
      if (event) events.push(event);
  }
  return events;
}

/** Same ordering as the original timestamp#eventId DynamoDB event sort key. */
export function compareAuctionEvents(
  left: NormalizedAuctionEvent,
  right: NormalizedAuctionEvent,
): number {
  const a = `${left.timestamp}#${left.eventId}`;
  const b = `${right.timestamp}#${right.eventId}`;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** One uncompressed auction, retaining each bidder's complete original observations. */
export const AuctionRecordSchema = AuctionRecordShape.refine(
  (record) => {
    const events = recordEvents(record);
    return (
      record.startedAt === record.init.timestamp &&
      record.endedAt === record.end.timestamp &&
      record.startedAt <= record.endedAt &&
      new Set(record.bidders.map((bidder) => bidder.bidderId)).size === record.bidders.length &&
      new Set(events.map((event) => event.eventId)).size === events.length &&
      events.every(
        (event) =>
          event.publisherId === record.publisherId &&
          event.auctionId === record.auctionId &&
          event.adUnitId === record.adUnitId &&
          event.configurationVersion === record.configurationVersion &&
          event.currency === record.currency &&
          event.timestamp >= record.startedAt &&
          event.timestamp.slice(0, 10) === record.startedAt.slice(0, 10),
      ) &&
      record.bidders.every((bidder) =>
        [
          bidder.request,
          bidder.response,
          bidder.done,
          bidder.timeout,
          bidder.candidate,
          bidder.win,
          bidder.render,
        ].every(
          (event) =>
            !event ||
            (event.bidderId === bidder.bidderId &&
              event.bidRequestId === bidder.request.bidRequestId),
        ),
      ) &&
      record.bidders.filter((bidder) => bidder.candidate).length <= 1 &&
      record.bidders.filter((bidder) => bidder.win).length <= 1 &&
      record.bidders.filter((bidder) => bidder.render).length <= 1
    );
  },
  { message: 'Auction header, bidder ownership, unique observations and UTC date must agree' },
);

export type AuctionRecord = z.infer<typeof AuctionRecordSchema>;

export function expandAuctionRecord(record: AuctionRecord): NormalizedAuctionEvent[] {
  return recordEvents(AuctionRecordSchema.parse(record)).sort(compareAuctionEvents);
}

export function auctionRecordFromEvents(events: readonly NormalizedAuctionEvent[]): AuctionRecord {
  const parsed = events.map((event) => CanonicalAuctionEventSchema.parse(event));
  const init = parsed.filter((event) => event.type === 'auctionInit');
  const end = parsed.filter((event) => event.type === 'auctionEnd');
  if (init.length !== 1 || end.length !== 1)
    throw new Error('INVALID_DATA: an auction record requires one init and one end');
  const first = init[0]!;
  const last = end[0]!;
  const bidders = new Map<string, BidderRecord>();
  for (const event of parsed) {
    if (event.type !== 'bidRequested') continue;
    if (bidders.has(event.bidderId))
      throw new Error('INVALID_DATA: an auction record has duplicate bidder requests');
    bidders.set(event.bidderId, { bidderId: event.bidderId, request: event });
  }
  for (const event of parsed) {
    if (
      event.type === 'auctionInit' ||
      event.type === 'auctionEnd' ||
      event.type === 'bidRequested'
    )
      continue;
    const bidder = bidders.get(event.bidderId);
    if (!bidder) throw new Error('INVALID_DATA: auction observation has no bidder request');
    const field =
      event.type === 'bidResponse' || event.type === 'bidRejected'
        ? 'response'
        : event.type === 'bidderDone'
          ? 'done'
          : event.type === 'bidTimeout'
            ? 'timeout'
            : event.type === 'bidCandidate'
              ? 'candidate'
              : event.type === 'bidWon'
                ? 'win'
                : 'render';
    if (bidder[field]) throw new Error('INVALID_DATA: duplicate bidder lifecycle observation');
    Object.assign(bidder, { [field]: event });
  }
  return AuctionRecordSchema.parse({
    format: 'auction-v1',
    publisherId: first.publisherId,
    auctionId: first.auctionId,
    adUnitId: first.adUnitId,
    configurationVersion: first.configurationVersion,
    currency: first.currency,
    startedAt: first.timestamp,
    endedAt: last.timestamp,
    init: first,
    end: last,
    bidders: [...bidders.values()].sort((a, b) =>
      a.bidderId < b.bidderId ? -1 : a.bidderId > b.bidderId ? 1 : 0,
    ),
  });
}

export function groupAuctionRecords(events: readonly NormalizedAuctionEvent[]): AuctionRecord[] {
  const grouped = new Map<string, NormalizedAuctionEvent[]>();
  for (const event of events) {
    const key = JSON.stringify([event.publisherId, event.auctionId]);
    const group = grouped.get(key) ?? [];
    group.push(event);
    grouped.set(key, group);
  }
  return [...grouped.values()].map(auctionRecordFromEvents).sort((a, b) => {
    const left = `${a.startedAt}#${a.auctionId}`;
    const right = `${b.startedAt}#${b.auctionId}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}
