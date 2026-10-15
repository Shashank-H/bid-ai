import assert from 'node:assert/strict';
import {
  CanonicalConfigurationHistorySchema,
  PrebidConfigurationSchema,
  summarizePrebidConfiguration,
} from '@bid/shared';
import type {
  CanonicalConfigurationHistory,
  NormalizedAuctionEvent,
  PrebidConfiguration,
} from '@bid/shared';
import { canonicalJson, validateAuctionEvents } from '../../apps/api/src/domain/aggregation.js';
import {
  BIDDER_IDS,
  OBSERVED_FROM,
  OBSERVED_THROUGH,
  createTimeline,
  datasetDates,
} from './configuration.js';
import { generateDay, simulateAuction } from './simulation.js';
import type { AdapterOutcome, SimulatedPublisher } from './simulation.js';

function probe(
  profile: PrebidConfiguration,
  outcomes: readonly AdapterOutcome[],
  adUnitCode = profile.adUnits[0]!.code,
  floorDraw = 0.5,
) {
  const history: CanonicalConfigurationHistory[] = [
    CanonicalConfigurationHistorySchema.parse({
      publisherId: 'publisher-a',
      historyId: 'publisher-a-probe-v1',
      version: 1,
      timestamp: OBSERVED_FROM,
      updatedByUserId: 'demo-user-a',
      before: null,
      after: summarizePrebidConfiguration(profile),
      beforePrebid: null,
      afterPrebid: profile,
      syntheticAttribution: true,
    }),
  ];
  const events = simulateAuction({
    publisherId: 'publisher-a',
    auctionId: 'publisher-a:probe:000001',
    startedAt: '2026-09-07T12:00:00.000Z',
    configurationVersion: 1,
    profile,
    adUnitCode,
    outcomes,
    floorDraw,
  });
  const totals = validateAuctionEvents(events, {
    publisherId: 'publisher-a',
    date: '2026-09-07',
    history,
  });
  const candidate = events.find((event) => event.type === 'bidCandidate');
  return { events, totals, candidate };
}

function offers(events: readonly NormalizedAuctionEvent[]) {
  return events
    .filter((event) => event.type === 'bidResponse' || event.type === 'bidRejected')
    .map((event) => ({
      bidderId: event.bidderId,
      cpm: event.offer.originalCpm,
      latencyMs: event.latencyMs,
    }));
}

/** Fixed demand/arrival streams, one configuration knob changed; nothing is persisted. */
export function verifySensitivity() {
  const base = createTimeline('publisher-a').history[0]!.afterPrebid;
  const fixed: AdapterOutcome[] = BIDDER_IDS.map((bidderId, index) => ({
    bidderId,
    cpm: index === 0 ? 1.2 : index === 1 ? 1.05 : null,
    latencyMs: 100 + index * 25,
  }));
  const low = probe(base, fixed);
  const higher = structuredClone(base);
  higher.setConfig.floors.data.values.banner = higher.setConfig.floors.data.default = 1.4;
  const high = probe(higher, fixed);
  assert(
    low.totals.filled && !high.totals.filled,
    'higher floor must remove genuinely below-floor demand',
  );
  assert.equal(
    low.totals.bidders.get('atlas')!.responses,
    high.totals.bidders.get('atlas')!.responses,
  );
  assert.equal(
    canonicalJson(offers(low.events)),
    canonicalJson(offers(high.events)),
    'floor probe must keep offers/arrival streams fixed',
  );
  const equality = probe(
    higher,
    fixed.map((offer) => (offer.bidderId === 'atlas' ? { ...offer, cpm: 1.4 } : offer)),
  );
  assert(
    equality.totals.filled && equality.candidate?.cpm === 1.4,
    'floor equality must be accepted',
  );
  const unenforced = structuredClone(higher);
  unenforced.setConfig.floors.enforcement.enforceJS = false;
  assert(
    probe(unenforced, fixed).totals.filled,
    'disabled enforcement must accept below-floor offers',
  );
  const bypassed = structuredClone(higher);
  bypassed.setConfig.floors.skipRate = 100;
  assert(probe(bypassed, fixed).totals.filled, 'full floor bypass must accept below-floor offers');
  const experiment = structuredClone(higher);
  experiment.setConfig.floors.skipRate = 50;
  assert(probe(experiment, fixed, experiment.adUnits[0]!.code, 0.1).totals.filled);
  assert(!probe(experiment, fixed, experiment.adUnits[0]!.code, 0.9).totals.filled);

  const slow: AdapterOutcome[] = fixed.map((offer) =>
    offer.bidderId === 'beacon' ? { ...offer, cpm: 2, latencyMs: 1200 } : offer,
  );
  const normal = probe(base, slow);
  const longer = structuredClone(base);
  longer.setConfig.bidderTimeout = 1500;
  const admitted = probe(longer, slow);
  assert.equal(normal.candidate?.bidderId, 'atlas');
  assert.equal(admitted.candidate?.bidderId, 'beacon');
  assert(
    admitted.totals.waitMs > normal.totals.waitMs,
    'admitting a slow bidder must require an open auction',
  );
  const late = normal.events.find(
    (event) => event.type === 'bidResponse' && event.bidderId === 'beacon',
  );
  assert(
    late?.type === 'bidResponse' && late.late && !late.eligible,
    'late acceptance is distinct from native rejection',
  );
  const override = structuredClone(base);
  override.requestBids.timeout = 1500;
  assert.equal(
    probe(override, slow).candidate?.bidderId,
    'beacon',
    'per-auction timeout must override global timeout',
  );
  const deadline = probe(
    base,
    fixed.map((offer) =>
      offer.bidderId === 'atlas' ? { ...offer, latencyMs: 999 } : { ...offer, latencyMs: 1200 },
    ),
  );
  const exact = deadline.events.find(
    (event) => event.type === 'bidResponse' && event.bidderId === 'atlas',
  );
  assert(
    exact?.type === 'bidResponse' &&
      exact.timestamp === '2026-09-07T12:00:01.000Z' &&
      exact.late &&
      !exact.eligible,
    'the earlier queued deadline timer excludes an equal-deadline callback',
  );
  assert(
    deadline.events.findIndex((event) => event.type === 'auctionEnd') <
      deadline.events.indexOf(exact),
    'timer/end records must precede equal-deadline callbacks',
  );
  const early = probe(
    base,
    fixed.map((offer) => (offer.bidderId === 'atlas' ? { ...offer, latencyMs: 300 } : offer)),
  );
  const earlyEnd = early.events.find((event) => event.type === 'auctionEnd')!;
  assert(earlyEnd.type === 'auctionEnd' && !earlyEnd.timedOut);
  assert(
    early.events.some(
      (event) =>
        event.type === 'bidResponse' && event.timestamp === earlyEnd.timestamp && event.eligible,
    ),
    'the last early offer remains part of the completed auction',
  );

  const competing = fixed.map((offer) =>
    offer.bidderId === 'beacon' ? { ...offer, cpm: 2 } : offer,
  );
  const all = probe(base, competing);
  const removed = structuredClone(base);
  for (const unit of removed.adUnits)
    unit.bids = unit.bids.filter((bid) => bid.bidder !== 'beacon');
  const fewer = probe(removed, competing);
  assert.equal(all.candidate?.bidderId, 'beacon');
  assert.equal(fewer.candidate?.bidderId, 'atlas');
  assert.equal(fewer.events.filter((event) => event.type === 'bidRequested').length, 4);
  assert(!fewer.events.some((event) => 'bidderId' in event && event.bidderId === 'beacon'));
  const selected = probe(base, fixed, base.adUnits[2]!.code);
  assert(
    selected.events.every((event) => event.adUnitId === base.adUnits[2]!.code),
    'ad-unit selection changes actual request/slot identity',
  );

  const priced = fixed.map((offer) =>
    offer.bidderId === 'atlas' ? { ...offer, cpm: 1.53 } : offer,
  );
  const medium = probe(base, priced);
  const fine = structuredClone(base);
  fine.setConfig.priceGranularity = 'high';
  const highPrecision = probe(fine, priced);
  assert.equal(medium.candidate?.targeting.hb_pb, '1.50');
  assert.equal(highPrecision.candidate?.targeting.hb_pb, '1.53');
  assert.equal(
    medium.totals.winningMicroCpm,
    highPrecision.totals.winningMicroCpm,
    'targeting buckets must not rewrite offered winning CPM',
  );
  const topOnly = structuredClone(base);
  topOnly.setConfig.enableSendAllBids = false;
  const singleTarget = probe(topOnly, priced);
  assert.equal(singleTarget.totals.winningMicroCpm, medium.totals.winningMicroCpm);
  assert.equal(singleTarget.events.filter((event) => event.type === 'bidRequested').length, 5);
  assert(
    Object.keys(singleTarget.candidate!.targeting).length <
      Object.keys(medium.candidate!.targeting).length,
    'send-all changes targeting payload only',
  );

  const diagnostic = structuredClone(base);
  diagnostic.setConfig.debug = true;
  diagnostic.setConfig.maxRequestsPerOrigin = 1;
  assert.equal(
    probe(diagnostic, priced).totals.winningMicroCpm,
    medium.totals.winningMicroCpm,
    'inactive diagnostics/concurrency must not fabricate yield changes',
  );
  const incompatible = structuredClone(base) as unknown as {
    setConfig: { currency: { rates: { USD: { USD: number } } } };
  };
  incompatible.setConfig.currency.rates.USD.USD = 2;
  assert(
    !PrebidConfigurationSchema.safeParse(incompatible).success,
    'unsupported currency rates must be rejected',
  );
  const response = medium.events.find((event) => event.type === 'bidResponse')!;
  assert(response.type === 'bidResponse');
  assert.equal(
    Date.parse(response.offer.expiresAt) - Date.parse(response.timestamp),
    59_000,
    'expiry is TTL minus buffer',
  );
  return {
    floorEquality: true,
    floorBypass: true,
    lateAcceptance: true,
    timerFirstDeadline: true,
    timeoutOverride: true,
    bidderSelection: true,
    targetingNotRevenue: true,
    explicitRender: true,
  };
}

export function verifyCoverage(datasets: readonly SimulatedPublisher[]) {
  assert.equal(Date.parse(OBSERVED_THROUGH) - Date.parse(OBSERVED_FROM), 56 * 86_400_000);
  assert.equal(datasetDates().length, 57);
  assert.equal(datasets.length, 2);
  for (const dataset of datasets) {
    assert.equal(dataset.daily.length, 57);
    assert.equal(dataset.bidders.length, 285);
    assert.equal(new Set(dataset.bidders.map((bidder) => bidder.bidderId)).size, 5);
    assert.equal(dataset.timeline.current.prebid.adUnits.length, 3);
    assert.deepEqual(
      dataset.daily.filter((day) => day.partial).map((day) => day.date),
      ['2026-08-24', '2026-10-19'],
    );
    assert(
      dataset.descriptor.counts!.auctions > 50_000 && dataset.descriptor.counts!.auctions < 60_000,
    );
    const publisherId = dataset.descriptor.publisherId as 'publisher-a' | 'publisher-b';
    const first = generateDay(
      publisherId,
      '2026-08-24',
      dataset.timeline.history,
      dataset.descriptor.seed,
    );
    const last = generateDay(
      publisherId,
      '2026-10-19',
      dataset.timeline.history,
      dataset.descriptor.seed,
    );
    assert.equal(first.events[0]!.timestamp, OBSERVED_FROM);
    assert.equal(last.events.at(-1)!.timestamp, OBSERVED_THROUGH);
    assert.equal(last.events.at(-1)!.type, 'adRenderSucceeded');
    assert(
      last.events.some(
        (event) => event.type === 'bidWon' && event.timestamp === '2026-10-19T03:29:59.999Z',
      ),
    );
  }
}
