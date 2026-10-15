import type {
  BidderMetrics,
  CanonicalConfigurationHistory,
  DailyMetrics,
  DatasetDescriptor,
  MockBidderId,
  NormalizedAuctionEvent,
  PrebidConfiguration,
} from '@bid/shared';
import {
  aggregateDay,
  buildTargeting,
  targetingBucket,
  toMicroCpm,
} from '../../apps/api/src/domain/aggregation.js';
import { resolvePrebidAuction } from '../../apps/api/src/domain/prebid-configuration.js';
import {
  AUCTIONS_PER_DAY,
  BIDDER_IDS,
  DEFAULT_SEED,
  OBSERVED_FROM,
  OBSERVED_THROUGH,
} from './configuration.js';
import type { PublisherTimeline, SeedPublisherId } from './configuration.js';

const DAY_MS = 86_400_000;
const RENDER_DELAY_MS = 2;
const NORMAL_AUCTION_MARGIN_MS = 4000;
type AcceptedOffer = Extract<NormalizedAuctionEvent, { type: 'bidResponse' }>;

/** Independent, stable publisher/date/auction streams; never touches global randomness. */
export function seededRandom(key: string): () => number {
  let state = 2166136261;
  for (let index = 0; index < key.length; index++) {
    state = Math.imul(state ^ key.charCodeAt(index), 16777619) >>> 0;
  }
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export interface AdapterOutcome {
  bidderId: MockBidderId;
  // null means a completed no-bid, not an invented zero-price response.
  cpm: number | null;
  latencyMs: number;
  silent?: boolean;
}

export interface AuctionInput {
  publisherId: string;
  auctionId: string;
  startedAt: string;
  configurationVersion: number;
  profile: PrebidConfiguration;
  adUnitCode: string;
  outcomes: readonly AdapterOutcome[];
  floorDraw?: number;
}

/** Registered mock adapters produce outcomes; this pure clock models their callbacks. */
export function simulateAuction(input: AuctionInput): NormalizedAuctionEvent[] {
  const { profile } = input;
  const resolved = resolvePrebidAuction(profile, input.adUnitCode);
  const started = Date.parse(input.startedAt);
  const requestTime = started + 1;
  const deadline = started + resolved.effectiveTimeoutMs;
  const selected = resolved.unit.bids.map((bid) => {
    const outcome = input.outcomes.find((entry) => entry.bidderId === bid.bidder);
    if (!outcome || outcome.latencyMs < 1 || !Number.isSafeInteger(outcome.latencyMs)) {
      throw new Error('DATA_INVALID: mock adapter outcome missing or invalid');
    }
    if (outcome.silent && outcome.cpm !== null)
      throw new Error('DATA_INVALID: a silent adapter cannot return an offer');
    return { bid, outcome, arrival: requestTime + outcome.latencyMs };
  });
  const cutoff = selected.every((entry) => !entry.outcome.silent)
    ? Math.min(deadline, Math.max(...selected.map((entry) => entry.arrival)))
    : deadline;
  const deadlineClosed = cutoff === deadline;
  const isLate = (arrival: number) => arrival > cutoff || (deadlineClosed && arrival === cutoff);
  const iso = (time: number) => new Date(time).toISOString();
  const core = {
    publisherId: input.publisherId,
    auctionId: input.auctionId,
    adUnitId: input.adUnitCode,
    currency: 'USD',
    configurationVersion: input.configurationVersion,
  };
  let sequence = 0;
  const identity = (time: number, afterDeadline = false) => ({
    ...core,
    // Timer/end records precede same-clock callbacks: the auction timer was queued first.
    eventId: `${input.auctionId}:${afterDeadline ? 'late:' : ''}${String(sequence++).padStart(3, '0')}`,
    timestamp: iso(time),
  });
  const events: NormalizedAuctionEvent[] = [
    {
      ...identity(started),
      type: 'auctionInit',
      configuredTimeoutMs: resolved.configuredTimeoutMs,
      effectiveTimeoutMs: resolved.effectiveTimeoutMs,
      deadlineAt: iso(deadline),
      size: resolved.size,
    },
  ];
  const floors = profile.setConfig.floors;
  const floorsSkipped = !floors.enabled || (input.floorDraw ?? 0.5) * 100 < floors.skipRate;
  const activeFloor = floors.enabled && !floorsSkipped;
  const accepted: AcceptedOffer[] = [];
  const timedOut: Array<{ bidderId: MockBidderId; bidRequestId: string }> = [];

  for (const { bid, outcome, arrival } of selected) {
    const bidCore = { bidderId: bid.bidder, bidRequestId: `${input.auctionId}:${bid.bidder}` };
    events.push({
      ...identity(requestTime),
      ...bidCore,
      type: 'bidRequested',
      auctionTimeoutMs: resolved.effectiveTimeoutMs,
      placementId: bid.params.placementId,
      size: resolved.size,
    });
    if (outcome.silent || isLate(arrival)) timedOut.push(bidCore);
    if (outcome.cpm !== null) {
      const floorEnforced =
        activeFloor &&
        floors.enforcement.enforceJS &&
        (floors.enforcement.enforceBidders.includes('*') ||
          floors.enforcement.enforceBidders.includes(bid.bidder));
      const late = isLate(arrival);
      const belowFloor = floorEnforced && toMicroCpm(outcome.cpm) < toMicroCpm(resolved.floorCpm);
      const fields = {
        ...identity(arrival, deadlineClosed && arrival === cutoff),
        ...bidCore,
        cpm: outcome.cpm,
        latencyMs: outcome.latencyMs,
        late,
        eligible:
          !late && !belowFloor && arrival + (60 - resolved.ttlBufferSeconds) * 1000 > cutoff,
        offer: {
          originalCpm: outcome.cpm,
          originalCurrency: 'USD',
          normalizedCpm: outcome.cpm,
          comparisonCpm: outcome.cpm,
          size: resolved.size,
          creativeId: `creative-${bidCore.bidRequestId}`,
          netRevenue: true,
          ttlSeconds: 60,
          ttlBufferSeconds: resolved.ttlBufferSeconds,
          expiresAt: iso(arrival + (60 - resolved.ttlBufferSeconds) * 1000),
          floorRule: 'banner',
          floorCpm: resolved.floorCpm,
          floorCurrency: 'USD',
          signaledFloorCpm: activeFloor ? resolved.floorCpm : 0,
          floorEnforced,
          floorsSkipped,
          auctionCutoffAt: iso(cutoff),
          targetingBucket: targetingBucket(outcome.cpm, profile.setConfig.priceGranularity),
        },
      };
      if (belowFloor) {
        events.push({ ...fields, type: 'bidRejected', eligible: false, reason: 'floor' });
      } else {
        const offer: AcceptedOffer = { ...fields, type: 'bidResponse' };
        events.push(offer);
        if (offer.eligible) accepted.push(offer);
      }
    }
    if (!outcome.silent) {
      events.push({
        ...identity(arrival, deadlineClosed && arrival === cutoff),
        ...bidCore,
        type: 'bidderDone',
        noBid: outcome.cpm === null,
      });
    }
  }
  for (const bidCore of timedOut) {
    events.push({ ...identity(cutoff), ...bidCore, type: 'bidTimeout' });
  }
  events.push({
    ...identity(cutoff),
    type: 'auctionEnd',
    cutoffAt: iso(cutoff),
    waitMs: cutoff - started,
    timedOut: deadlineClosed,
  });
  const winner = accepted.sort(
    (left, right) =>
      toMicroCpm(right.cpm) - toMicroCpm(left.cpm) ||
      left.bidderId.localeCompare(right.bidderId, 'en') ||
      left.bidRequestId.localeCompare(right.bidRequestId, 'en'),
  )[0];
  if (winner) {
    if (Date.parse(winner.offer.expiresAt) <= cutoff + RENDER_DELAY_MS) {
      throw new Error(
        'DATA_INVALID: candidate lifetime cannot support the controlled successful render',
      );
    }
    const bidCore = { bidderId: winner.bidderId, bidRequestId: winner.bidRequestId };
    const targeting = buildTargeting(accepted, winner, profile);
    events.push({
      ...identity(cutoff),
      ...bidCore,
      type: 'bidCandidate',
      cpm: winner.cpm,
      targeting,
    });
    events.push({
      ...identity(cutoff + 1),
      ...bidCore,
      type: 'bidWon',
      cpm: winner.cpm,
      targeting,
    });
    events.push({
      ...identity(cutoff + RENDER_DELAY_MS),
      ...bidCore,
      type: 'adRenderSucceeded',
      creativeId: winner.offer.creativeId,
    });
  }
  return events.sort(eventOrder);
}

export function eventOrder(left: NormalizedAuctionEvent, right: NormalizedAuctionEvent): number {
  return (
    left.timestamp.localeCompare(right.timestamp, 'en') ||
    left.eventId.localeCompare(right.eventId, 'en')
  );
}

function trafficWeight(hour: number): number {
  return 0.25 + 0.75 * Math.max(0, Math.sin(((hour - 5) * Math.PI) / 18));
}

function weightedIntervals(from: number, through: number) {
  const result: Array<{ start: number; end: number; weight: number }> = [];
  const midnight = Date.parse(new Date(from).toISOString().slice(0, 10));
  for (let hour = 0; hour < 24; hour++) {
    const start = Math.max(from, midnight + hour * 3_600_000);
    const end = Math.min(through, midnight + (hour + 1) * 3_600_000);
    if (start < end) result.push({ start, end, weight: (end - start) * trafficWeight(hour + 0.5) });
  }
  return result;
}

function chooseStart(intervals: ReturnType<typeof weightedIntervals>, draw: number): number {
  const total = intervals.reduce((sum, item) => sum + item.weight, 0);
  let target = draw * total;
  for (const item of intervals) {
    if (target <= item.weight)
      return Math.floor(item.start + ((item.end - item.start) * target) / item.weight);
    target -= item.weight;
  }
  return Math.floor(intervals.at(-1)!.end - 1);
}

function adapterOutcomes(
  publisherId: SeedPublisherId,
  date: string,
  random: () => number,
): AdapterOutcome[] {
  const growth = publisherId === 'publisher-b' && date >= '2026-10-05' && date <= '2026-10-18';
  const demand = random() >= (publisherId === 'publisher-a' ? 0.1 : growth ? 0.02 : 0.17);
  const weakOpportunity = publisherId === 'publisher-a' && random() < 0.236;
  const market =
    publisherId === 'publisher-a'
      ? (weakOpportunity ? 1.2 : 1.68) + (random() - 0.5) * 0.08
      : (1.7 + (random() - 0.5) * 0.3) * (growth ? 1.1 : 1);
  const factors =
    publisherId === 'publisher-a' ? [1, 0.97, 0.92, 0.89, 0.7] : [1.02, 1.17, 0.97, 0.91, 0.68];
  const participation =
    publisherId === 'publisher-a' ? [0.83, 0.78, 0.72, 0.66, 0.22] : [0.76, 0.82, 0.7, 0.63, 0.18];
  return BIDDER_IDS.map((bidderId, index) => {
    const offers = demand && random() < participation[index]!;
    const cpm = offers
      ? Math.round(market * factors[index]! * (0.97 + random() * 0.06) * 10_000) / 10_000
      : null;
    let latencyMs = Math.round(100 + index * 35 + random() * (220 + index * 55));
    if (random() < 0.035) latencyMs += 900;
    if (
      publisherId === 'publisher-b' &&
      bidderId === 'beacon' &&
      date >= '2026-09-14' &&
      date <= '2026-09-27' &&
      random() < 0.7
    ) {
      latencyMs = Math.round(1250 + random() * 650);
    }
    return { bidderId, cpm, latencyMs, silent: cpm === null && random() < 0.015 };
  });
}

export interface GeneratedDay {
  events: NormalizedAuctionEvent[];
  daily: DailyMetrics;
  bidders: BidderMetrics[];
  eventCount: number;
}

/** One UTC date in memory; configuration and demand streams remain independent. */
export function generateDay(
  publisherId: SeedPublisherId,
  date: string,
  history: readonly CanonicalConfigurationHistory[],
  seed = DEFAULT_SEED,
): GeneratedDay {
  const midnight = Date.parse(date);
  const from = Math.max(midnight, Date.parse(OBSERVED_FROM));
  const through = Math.min(midnight + DAY_MS - 1, Date.parse(OBSERVED_THROUGH));
  if (from >= through) throw new Error('DATA_INVALID: date falls outside the historical window');
  const traffic = seededRandom(`${seed}/${publisherId}/${date}/traffic`);
  const weekday = new Date(midnight).getUTCDay();
  const weekdayWeight = [0.84, 1.1, 1.08, 1.06, 1.04, 1, 0.88][weekday]!;
  const fullWeight = weightedIntervals(midnight, midnight + DAY_MS).reduce(
    (sum, interval) => sum + interval.weight,
    0,
  );
  const availableWeight = weightedIntervals(from, through).reduce(
    (sum, interval) => sum + interval.weight,
    0,
  );
  const growth = publisherId === 'publisher-b' && date >= '2026-10-05' && date <= '2026-10-18';
  const count = Math.max(
    1,
    Math.round(
      (AUCTIONS_PER_DAY *
        weekdayWeight *
        (0.98 + traffic() * 0.04) *
        (growth ? 0.875 : 1) *
        availableWeight) /
        fullWeight,
    ),
  );
  const intervals = weightedIntervals(from, through - NORMAL_AUCTION_MARGIN_MS);
  const events: NormalizedAuctionEvent[] = [];
  for (let index = 0; index < count; index++) {
    const random = seededRandom(`${seed}/${publisherId}/${date}/auction/${index}`);
    const finalAuction = date === OBSERVED_THROUGH.slice(0, 10) && index === count - 1;
    let start =
      index === 0 && date === OBSERVED_FROM.slice(0, 10) ? from : chooseStart(intervals, traffic());
    let outcomes = adapterOutcomes(publisherId, date, random);
    if (finalAuction) {
      // A reserved valid final auction, not a patched aggregate or fabricated winning event.
      outcomes = BIDDER_IDS.map((bidderId, bidderIndex) => ({
        bidderId,
        cpm: 1.68 + bidderIndex * 0.01,
        latencyMs: 100 + bidderIndex * 20,
      }));
      start = Date.parse(OBSERVED_THROUGH) - (1 + 180 + RENDER_DELAY_MS);
    }
    const change = [...history].reverse().find((entry) => Date.parse(entry.timestamp) <= start);
    if (!change)
      throw new Error('DATA_INVALID: no stored configuration effective at generated auction');
    const profile = change.afterPrebid;
    events.push(
      ...simulateAuction({
        publisherId,
        auctionId: `${publisherId}:${date}:${String(index).padStart(6, '0')}`,
        startedAt: new Date(start).toISOString(),
        configurationVersion: change.version,
        profile,
        adUnitCode: profile.adUnits[index % profile.adUnits.length]!.code,
        outcomes,
        floorDraw: random(),
      }),
    );
  }
  events.sort(eventOrder);
  const result = aggregateDay(events, {
    publisherId,
    date,
    history,
    startAt: OBSERVED_FROM,
    endAt: OBSERVED_THROUGH,
    partial: date === OBSERVED_FROM.slice(0, 10) || date === OBSERVED_THROUGH.slice(0, 10),
  });
  return { events, ...result };
}

export interface SimulatedPublisher {
  timeline: PublisherTimeline;
  descriptor: DatasetDescriptor;
  daily: DailyMetrics[];
  bidders: BidderMetrics[];
}
