import { createHash } from 'node:crypto';
import {
  BidderMetricsSchema,
  CanonicalAuctionEventSchema,
  CanonicalConfigurationHistorySchema,
  DailyMetricsSchema,
  DateSchema,
  TimestampSchema,
} from '@bid/shared';
import type {
  BidderMetrics,
  BidTargeting,
  CanonicalConfigurationHistory,
  DailyMetrics,
  NormalizedAuctionEvent,
  PrebidConfiguration,
} from '@bid/shared';
import { ratio } from './analytics.js';

const MICRO_CPM = 1_000_000;
type Offer = Extract<NormalizedAuctionEvent, { type: 'bidResponse' | 'bidRejected' }>;
type AcceptedOffer = Extract<NormalizedAuctionEvent, { type: 'bidResponse' }>;
type Granularity = PrebidConfiguration['setConfig']['priceGranularity'];

function check(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(`DATA_INVALID: ${reason}`);
}

export function toMicroCpm(cpm: number): number {
  const value = Math.round(cpm * MICRO_CPM);
  check(Number.isFinite(cpm) && cpm >= 0 && Number.isSafeInteger(value), 'invalid CPM');
  check(Math.abs(value - cpm * MICRO_CPM) < 0.000001, 'CPM exceeds six decimal places');
  return value;
}

/** Canonical map ordering makes generator hashes independent of SDK attribute ordering. */
export function canonicalJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number') {
      check(Number.isFinite(item), 'non-finite canonical number');
      return item;
    }
    if (Array.isArray(item)) return item.map(normalize);
    check(typeof item === 'object' && item !== null, 'non-JSON canonical value');
    return Object.fromEntries(
      Object.entries(item)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right, 'en'))
        .map(([key, child]) => [key, normalize(child)]),
    );
  };
  return JSON.stringify(normalize(value));
}

export function hashCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** Callers supply events in timestamp#eventId order, date partitions in UTC order. */
export function createEventHasher() {
  const hash = createHash('sha256');
  return {
    add(event: unknown) {
      hash.update(canonicalJson(event)).update('\n');
    },
    digest() {
      return hash.digest('hex');
    },
  };
}

const BUCKETS: Record<Granularity, readonly (readonly [number, number])[]> = {
  low: [[5, 0.5]],
  medium: [[20, 0.1]],
  high: [[20, 0.01]],
  auto: [
    [5, 0.05],
    [10, 0.1],
    [20, 0.5],
  ],
  dense: [
    [3, 0.01],
    [8, 0.05],
    [20, 0.5],
  ],
};

export function targetingBucket(cpm: number, granularity: Granularity): string {
  const price = toMicroCpm(cpm);
  let minimum = 0;
  for (const [maximumCpm, incrementCpm] of BUCKETS[granularity]) {
    const maximum = toMicroCpm(maximumCpm);
    if (price <= maximum) {
      const increment = toMicroCpm(incrementCpm);
      return (
        (minimum + Math.floor((price - minimum) / increment) * increment) /
        MICRO_CPM
      ).toFixed(2);
    }
    minimum = maximum;
  }
  return (minimum / MICRO_CPM).toFixed(2);
}

function offerRank(left: AcceptedOffer, right: AcceptedOffer): number {
  return (
    toMicroCpm(right.offer.comparisonCpm) - toMicroCpm(left.offer.comparisonCpm) ||
    left.bidderId.localeCompare(right.bidderId, 'en') ||
    left.bidRequestId.localeCompare(right.bidRequestId, 'en')
  );
}

/** Synthetic hb_adid is the stable request identity, not a random native Prebid ad ID. */
export function buildTargeting(
  eligible: readonly AcceptedOffer[],
  winner: AcceptedOffer,
  profile: PrebidConfiguration,
): BidTargeting {
  const keys = (offer: AcceptedOffer): Record<string, string> => ({
    hb_bidder: offer.bidderId,
    hb_adid: offer.bidRequestId,
    hb_pb: targetingBucket(offer.offer.comparisonCpm, profile.setConfig.priceGranularity),
    hb_size: offer.offer.size.join('x'),
    hb_source: 'client',
    hb_format: 'banner',
  });
  const targeting = keys(winner);
  if (profile.setConfig.enableSendAllBids) {
    for (const offer of [...eligible].sort(offerRank)) {
      for (const [key, value] of Object.entries(keys(offer))) {
        targeting[`${key}_${offer.bidderId}`] = value;
      }
    }
  }
  return targeting;
}

export interface AggregationOptions {
  publisherId: string;
  date: string;
  history: readonly CanonicalConfigurationHistory[];
  startAt?: string;
  endAt?: string;
  partial?: boolean;
}

export interface DayAggregation {
  daily: DailyMetrics;
  bidders: BidderMetrics[];
  eventCount: number;
}

interface BidderTotals {
  requests: number;
  responses: number;
  acceptedResponses: number;
  rejectedResponses: number;
  eligibleResponses: number;
  lateResponses: number;
  timeouts: number;
  noBids: number;
  wins: number;
  winningMicroCpm: number;
  latencyMsTotal: number;
}

function emptyBidder(): BidderTotals {
  return {
    requests: 0,
    responses: 0,
    acceptedResponses: 0,
    rejectedResponses: 0,
    eligibleResponses: 0,
    lateResponses: 0,
    timeouts: 0,
    noBids: 0,
    wins: 0,
    winningMicroCpm: 0,
    latencyMsTotal: 0,
  };
}

function validatedHistory(options: AggregationOptions): CanonicalConfigurationHistory[] {
  DateSchema.parse(options.date);
  if (options.startAt) TimestampSchema.parse(options.startAt);
  if (options.endAt) TimestampSchema.parse(options.endAt);
  check(
    !options.startAt || !options.endAt || Date.parse(options.startAt) <= Date.parse(options.endAt),
    'reversed bounds',
  );
  const history = options.history.map((entry) => CanonicalConfigurationHistorySchema.parse(entry));
  check(history.length > 0, 'configuration timeline is empty');
  const ids = new Set<string>();
  for (const [index, entry] of history.entries()) {
    check(entry.publisherId === options.publisherId, 'configuration belongs to another publisher');
    check(!ids.has(entry.historyId), 'duplicate history identity');
    ids.add(entry.historyId);
    check(entry.version === index + 1, 'configuration versions must be contiguous');
    const previous = history[index - 1];
    if (previous) {
      check(
        Date.parse(previous.timestamp) < Date.parse(entry.timestamp),
        'configuration history is unordered',
      );
      check(
        canonicalJson(entry.beforePrebid) === canonicalJson(previous.afterPrebid),
        'configuration snapshot chain mismatch',
      );
      check(
        canonicalJson(entry.before) === canonicalJson(previous.after),
        'configuration summary chain mismatch',
      );
    } else {
      check(
        entry.before === null && entry.beforePrebid === null,
        'initial configuration has a prior state',
      );
    }
  }
  return history;
}

function one<T extends NormalizedAuctionEvent['type']>(
  events: readonly NormalizedAuctionEvent[],
  type: T,
  required = true,
): Extract<NormalizedAuctionEvent, { type: T }> | undefined {
  const matches = events.filter((event) => event.type === type);
  check(
    matches.length <= 1 && (!required || matches.length === 1),
    `expected ${required ? 'one' : 'at most one'} ${type}`,
  );
  return matches[0] as Extract<NormalizedAuctionEvent, { type: T }> | undefined;
}

function validateParsedAuction(
  events: readonly NormalizedAuctionEvent[],
  history: readonly CanonicalConfigurationHistory[],
): {
  winningMicroCpm: number;
  waitMs: number;
  filled: boolean;
  bidders: Map<string, BidderTotals>;
} {
  const init = one(events, 'auctionInit')!;
  const end = one(events, 'auctionEnd')!;
  const startMs = Date.parse(init.timestamp);
  const cutoffMs = Date.parse(end.cutoffAt);
  const configuration = [...history]
    .reverse()
    .find((entry) => Date.parse(entry.timestamp) <= startMs);
  check(configuration, 'no configuration effective at auction initiation');
  const profile = configuration.afterPrebid;
  const unit = profile.adUnits.find((entry) => entry.code === init.adUnitId);
  check(unit, 'auction selects an unknown ad unit');
  check(
    unit.mediaTypes.banner.sizes.some((size) => canonicalJson(size) === canonicalJson(init.size)),
    'auction size not configured',
  );
  const effectiveTimeout = profile.requestBids.timeout ?? profile.setConfig.bidderTimeout;
  check(init.configurationVersion === configuration.version, 'auction uses a stale configuration');
  check(
    init.configuredTimeoutMs === profile.setConfig.bidderTimeout &&
      init.effectiveTimeoutMs === effectiveTimeout,
    'auction timeout not derived from configuration',
  );
  check(Date.parse(init.deadlineAt) === startMs + effectiveTimeout, 'auction deadline mismatch');
  check(
    Date.parse(end.timestamp) === cutoffMs &&
      cutoffMs >= startMs &&
      cutoffMs <= Date.parse(init.deadlineAt),
    'invalid zero-jitter auction cutoff',
  );
  check(end.waitMs === cutoffMs - startMs, 'auction wait mismatch');
  check(
    end.timedOut === (cutoffMs === Date.parse(init.deadlineAt)),
    'deadline timer wins equal-time callbacks in the zero-jitter profile',
  );
  for (const event of events) {
    check(
      event.publisherId === init.publisherId &&
        event.auctionId === init.auctionId &&
        event.adUnitId === init.adUnitId,
      'auction identity mismatch',
    );
    check(
      event.configurationVersion === configuration.version,
      'event configuration snapshot mismatch',
    );
    check(
      event.currency === 'USD' && Date.parse(event.timestamp) >= startMs,
      'event currency/order mismatch',
    );
  }

  const requests = events.filter((event) => event.type === 'bidRequested');
  check(requests.length === unit.bids.length, 'configured requests are missing or duplicated');
  const byRequest = new Map<string, (typeof requests)[number]>();
  const bidders = new Map<string, BidderTotals>();
  for (const request of requests) {
    const bid = unit.bids.find((entry) => entry.bidder === request.bidderId);
    check(
      bid && !bidders.has(request.bidderId) && !byRequest.has(request.bidRequestId),
      'duplicate/unconfigured bidder request',
    );
    check(
      request.placementId === bid.params.placementId &&
        canonicalJson(request.size) === canonicalJson(init.size),
      'request placement/size mismatch',
    );
    check(
      request.auctionTimeoutMs === effectiveTimeout && Date.parse(request.timestamp) <= cutoffMs,
      'request timeout/order mismatch',
    );
    byRequest.set(request.bidRequestId, request);
    const totals = emptyBidder();
    totals.requests = 1;
    bidders.set(request.bidderId, totals);
  }
  for (const event of events) {
    if (!('bidRequestId' in event)) continue;
    const request = byRequest.get(event.bidRequestId);
    check(
      request &&
        request.bidderId === event.bidderId &&
        Date.parse(request.timestamp) <= Date.parse(event.timestamp),
      'event has no causal request',
    );
  }

  const offers = events.filter(
    (event): event is Offer => event.type === 'bidResponse' || event.type === 'bidRejected',
  );
  const offeredRequests = new Set<string>();
  check(
    new Set(offers.map((offer) => offer.offer.floorsSkipped)).size <= 1,
    'floor skip is an auction-level decision',
  );
  for (const offer of offers) {
    check(!offeredRequests.has(offer.bidRequestId), 'a request has more than one observed offer');
    offeredRequests.add(offer.bidRequestId);
    const request = byRequest.get(offer.bidRequestId)!;
    const arrival = Date.parse(offer.timestamp);
    check(offer.latencyMs === arrival - Date.parse(request.timestamp), 'offer latency mismatch');
    check(
      offer.late === (arrival > cutoffMs || (end.timedOut && arrival === cutoffMs)),
      'late flag does not match actual cutoff/order',
    );
    const details = offer.offer;
    check(Date.parse(details.auctionCutoffAt) === cutoffMs, 'offer cutoff mismatch');
    check(
      details.originalCurrency === 'USD' && details.floorCurrency === 'USD',
      'unsupported currency conversion',
    );
    const original = toMicroCpm(details.originalCpm);
    check(
      toMicroCpm(details.normalizedCpm) === original &&
        toMicroCpm(details.comparisonCpm) === original &&
        toMicroCpm(offer.cpm) === original,
      'unsupported CPM adjustment',
    );
    check(details.ttlBufferSeconds === profile.setConfig.ttlBuffer, 'offer TTL buffer mismatch');
    check(
      Date.parse(details.expiresAt) ===
        arrival + (details.ttlSeconds - details.ttlBufferSeconds) * 1000,
      'offer expiry mismatch',
    );
    const floors = profile.setConfig.floors;
    const matchedFloor = floors.data.values.banner;
    check(
      details.floorRule === 'banner' && toMicroCpm(details.floorCpm) === toMicroCpm(matchedFloor),
      'matched floor mismatch',
    );
    check(
      !floors.enabled || floors.skipRate !== 0 || !details.floorsSkipped,
      'floor skip impossible at zero skip rate',
    );
    check(
      !floors.enabled || floors.skipRate !== 100 || details.floorsSkipped,
      'floor bypass required at full skip rate',
    );
    const activeFloor = floors.enabled && !details.floorsSkipped;
    const enforce =
      activeFloor &&
      floors.enforcement.enforceJS &&
      (floors.enforcement.enforceBidders.includes('*') ||
        floors.enforcement.enforceBidders.some((bidder) => bidder === offer.bidderId));
    check(details.floorEnforced === enforce, 'floor enforcement mismatch');
    check(
      toMicroCpm(details.signaledFloorCpm) === (activeFloor ? toMicroCpm(matchedFloor) : 0),
      'signaled floor mismatch',
    );
    check(
      details.targetingBucket ===
        targetingBucket(details.comparisonCpm, profile.setConfig.priceGranularity),
      'targeting bucket mismatch',
    );
    const validSize = unit.mediaTypes.banner.sizes.some(
      (size) => canonicalJson(size) === canonicalJson(details.size),
    );
    const belowFloor = enforce && original < toMicroCpm(matchedFloor);
    if (offer.type === 'bidRejected') {
      check(
        (offer.reason === 'floor' && belowFloor) ||
          (offer.reason === 'size-policy' && !validSize) ||
          (offer.reason === 'expired' && Date.parse(details.expiresAt) <= cutoffMs),
        'rejection has no supported reason',
      );
    } else {
      // Requested-size membership is the documented extra publisher policy, not native core validation.
      check(validSize && !belowFloor, 'accepted offer violates floor/size policy');
    }
    const eligible =
      offer.type === 'bidResponse' && !offer.late && Date.parse(details.expiresAt) > cutoffMs;
    check(offer.eligible === eligible, 'offer eligibility mismatch');
    const totals = bidders.get(offer.bidderId)!;
    totals.responses++;
    if (offer.type === 'bidResponse') totals.acceptedResponses++;
    else totals.rejectedResponses++;
    if (offer.eligible) totals.eligibleResponses++;
    if (offer.late) totals.lateResponses++;
    totals.latencyMsTotal += offer.latencyMs;
  }

  const done = events.filter((event) => event.type === 'bidderDone');
  const completed = new Map<string, (typeof done)[number]>();
  for (const event of done) {
    check(!completed.has(event.bidRequestId), 'adapter completed more than once');
    completed.set(event.bidRequestId, event);
    const offer = offers.find((entry) => entry.bidRequestId === event.bidRequestId);
    check(event.noBid === !offer, 'adapter no-bid outcome mismatch');
    check(
      !offer || Date.parse(event.timestamp) >= Date.parse(offer.timestamp),
      'adapter completed before its offer',
    );
    if (event.noBid) bidders.get(event.bidderId)!.noBids++;
  }
  // An outstanding request may never produce an offer or completion callback.
  const expectedCutoff =
    done.length === requests.length
      ? Math.min(
          Date.parse(init.deadlineAt),
          Math.max(...done.map((event) => Date.parse(event.timestamp))),
        )
      : Date.parse(init.deadlineAt);
  check(cutoffMs === expectedCutoff, 'auction did not close at deadline or all-adapter completion');
  const timedOutRequests = requests.filter((request) => {
    const completion = completed.get(request.bidRequestId);
    return (
      !completion ||
      Date.parse(completion.timestamp) > cutoffMs ||
      (end.timedOut && Date.parse(completion.timestamp) === cutoffMs)
    );
  });
  const timeouts = events.filter((event) => event.type === 'bidTimeout');
  check(
    end.timedOut === timedOutRequests.length > 0 && timeouts.length === timedOutRequests.length,
    'auction timeout counts mismatch',
  );
  const timedOutIds = new Set<string>();
  for (const timeout of timeouts) {
    check(
      !timedOutIds.has(timeout.bidRequestId) &&
        timedOutRequests.some((request) => request.bidRequestId === timeout.bidRequestId),
      'unexpected/duplicate timeout',
    );
    check(Date.parse(timeout.timestamp) === cutoffMs, 'timeout not recorded at cutoff');
    timedOutIds.add(timeout.bidRequestId);
    bidders.get(timeout.bidderId)!.timeouts++;
  }

  const eligible = offers
    .filter((offer): offer is AcceptedOffer => offer.type === 'bidResponse' && offer.eligible)
    .sort(offerRank);
  const winner = eligible[0];
  const candidate = one(events, 'bidCandidate', Boolean(winner));
  const win = one(events, 'bidWon', Boolean(winner));
  const success = one(events, 'adRenderSucceeded', Boolean(winner));
  const failure = one(events, 'adRenderFailed', false);
  check(!failure, 'seed profile requires an explicit successful render, not a render failure');
  let winningMicroCpm = 0;
  if (winner) {
    check(candidate && win && success, 'winning render chain incomplete');
    for (const event of [candidate, win, success]) {
      check(
        event.bidRequestId === winner.bidRequestId && event.bidderId === winner.bidderId,
        'candidate/render chose the wrong offer',
      );
    }
    check(
      Date.parse(candidate.timestamp) === cutoffMs &&
        Date.parse(win.timestamp) > cutoffMs &&
        Date.parse(success.timestamp) >= Date.parse(win.timestamp),
      'candidate/render ordering mismatch',
    );
    check(
      Date.parse(success.timestamp) < Date.parse(winner.offer.expiresAt),
      'rendered offer expired',
    );
    const targeting = buildTargeting(eligible, winner, profile);
    check(
      canonicalJson(candidate.targeting) === canonicalJson(targeting) &&
        canonicalJson(win.targeting) === canonicalJson(targeting),
      'targeting does not match frozen eligible bids',
    );
    winningMicroCpm = toMicroCpm(winner.offer.comparisonCpm);
    check(
      toMicroCpm(candidate.cpm) === winningMicroCpm && toMicroCpm(win.cpm) === winningMicroCpm,
      'winning CPM mismatch',
    );
    check(success.creativeId === winner.offer.creativeId, 'rendered creative mismatch');
    const totals = bidders.get(winner.bidderId)!;
    totals.wins = 1;
    totals.winningMicroCpm = winningMicroCpm;
  } else {
    check(!candidate && !win && !success, 'unfilled auction contains a winning render');
  }
  return { winningMicroCpm, waitMs: end.waitMs, filled: Boolean(winner), bidders };
}

/** Validates one complete, date-confined synthetic auction, including late adapter outcomes. */
export function validateAuctionEvents(events: Iterable<unknown>, options: AggregationOptions) {
  const history = validatedHistory(options);
  const parsed = [...events].map((event) => CanonicalAuctionEventSchema.parse(event));
  const ids = new Set<string>();
  for (const event of parsed) {
    validateBoundary(event, options);
    check(!ids.has(event.eventId), 'duplicate event identity');
    ids.add(event.eventId);
  }
  return validateParsedAuction(parsed, history);
}

function validateBoundary(event: NormalizedAuctionEvent, options: AggregationOptions) {
  check(event.publisherId === options.publisherId, 'event belongs to another publisher');
  // shortcut: generated auctions stay in one UTC date; add carried auction state before supporting live ingestion.
  check(event.timestamp.slice(0, 10) === options.date, 'auction crosses its UTC date partition');
  check(
    !options.startAt || Date.parse(event.timestamp) >= Date.parse(options.startAt),
    'event precedes dataset start',
  );
  check(
    !options.endAt || Date.parse(event.timestamp) <= Date.parse(options.endAt),
    'event exceeds dataset end',
  );
}

function dayAccumulator(options: AggregationOptions) {
  const history = validatedHistory(options);
  const auctions = new Map<string, NormalizedAuctionEvent[]>();
  const eventIds = new Set<string>();
  const requestIds = new Set<string>();
  let eventCount = 0;
  return {
    add(raw: unknown) {
      const event = CanonicalAuctionEventSchema.parse(raw);
      validateBoundary(event, options);
      check(!eventIds.has(event.eventId), 'duplicate event identity');
      eventIds.add(event.eventId);
      if (event.type === 'bidRequested') {
        check(!requestIds.has(event.bidRequestId), 'duplicate request identity across auctions');
        requestIds.add(event.bidRequestId);
      }
      const group = auctions.get(event.auctionId) ?? [];
      group.push(event);
      auctions.set(event.auctionId, group);
      eventCount++;
    },
    finish(): DayAggregation {
      const totals = new Map<string, BidderTotals>();
      for (const entry of history) {
        for (const unit of entry.afterPrebid.adUnits) {
          for (const bid of unit.bids)
            if (!totals.has(bid.bidder)) totals.set(bid.bidder, emptyBidder());
        }
      }
      let winningMicroCpm = 0;
      let filled = 0;
      let waitMs = 0;
      for (const events of auctions.values()) {
        const result = validateParsedAuction(events, history);
        winningMicroCpm += result.winningMicroCpm;
        waitMs += result.waitMs;
        if (result.filled) filled++;
        for (const [bidderId, auctionTotals] of result.bidders) {
          const bidder = totals.get(bidderId)!;
          for (const key of Object.keys(auctionTotals) as (keyof BidderTotals)[])
            bidder[key] += auctionTotals[key];
        }
      }
      check(
        Number.isSafeInteger(winningMicroCpm),
        'winning micro-CPM sum exceeds safe integer range',
      );
      const bidders = [...totals]
        .sort(([left], [right]) => left.localeCompare(right, 'en'))
        .map(([bidderId, row]) => {
          const { winningMicroCpm: bidderMicroCpm, latencyMsTotal, ...counts } = row;
          return BidderMetricsSchema.parse({
            publisherId: options.publisherId,
            date: options.date,
            currency: 'USD',
            bidderId,
            ...counts,
            estimatedRevenue: bidderMicroCpm / (MICRO_CPM * 1000),
            responseRate: ratio(row.responses, row.requests),
            winRate: ratio(row.wins, row.requests),
            averageLatencyMs: ratio(latencyMsTotal, row.responses),
          });
        });
      check(
        [...totals.values()].reduce((sum, row) => sum + row.wins, 0) === filled,
        'bidder wins do not reconcile',
      );
      check(
        [...totals.values()].reduce((sum, row) => sum + row.winningMicroCpm, 0) === winningMicroCpm,
        'bidder revenue does not reconcile',
      );
      const daily = DailyMetricsSchema.parse({
        publisherId: options.publisherId,
        date: options.date,
        currency: 'USD',
        auctions: auctions.size,
        opportunities: auctions.size,
        eligibleOpportunities: auctions.size,
        filledOpportunities: filled,
        winningCpmTotal: winningMicroCpm / MICRO_CPM,
        estimatedRevenue: winningMicroCpm / (MICRO_CPM * 1000),
        fillRate: ratio(filled, auctions.size),
        averageWinningCpm: ratio(winningMicroCpm / MICRO_CPM, filled),
        auctionWaitMsTotal: waitMs,
        averageAuctionWaitMs: ratio(waitMs, auctions.size),
        partial: options.partial ?? false,
      });
      return { daily, bidders, eventCount };
    },
  };
}

export function aggregateDay(
  events: Iterable<unknown>,
  options: AggregationOptions,
): DayAggregation {
  const accumulator = dayAccumulator(options);
  for (const event of events) accumulator.add(event);
  return accumulator.finish();
}

export async function aggregateEventDay(
  publisherId: string,
  date: string,
  events: AsyncIterable<unknown> | Iterable<unknown>,
  timeline: readonly CanonicalConfigurationHistory[],
  options: Omit<AggregationOptions, 'publisherId' | 'date' | 'history'> = {},
): Promise<DayAggregation> {
  const accumulator = dayAccumulator({ ...options, publisherId, date, history: timeline });
  for await (const event of events) accumulator.add(event);
  return accumulator.finish();
}
