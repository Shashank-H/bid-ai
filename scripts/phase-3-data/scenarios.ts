import assert from 'node:assert/strict';
import type { BidderMetrics, DailyMetrics, DatasetDescriptor } from '@bid/shared';
import type { PublisherTimeline } from './configuration.js';

// Private test/demo expectations. This module must never be packaged with serving images.
export const SCENARIO_MANIFEST = {
  publisherA: {
    before: { startDate: '2026-09-07', endDate: '2026-09-13' },
    after: { startDate: '2026-09-14', endDate: '2026-09-20' },
    changeAt: '2026-09-14T00:00:00.000Z',
    floorBefore: 0.8,
    floorAfter: 1.4,
    revenueDecline: { min: 0.16, max: 0.2 },
  },
  publisherB: {
    healthy: { startDate: '2026-08-31', endDate: '2026-09-13' },
    degraded: { startDate: '2026-09-14', endDate: '2026-09-27' },
    cleanWeek: { startDate: '2026-09-28', endDate: '2026-10-04' },
    growthWeeks: [
      { startDate: '2026-10-05', endDate: '2026-10-11' },
      { startDate: '2026-10-12', endDate: '2026-10-18' },
    ],
    slowBidder: 'beacon',
    weakBidder: 'ember',
  },
} as const;

export interface ScenarioDataset {
  descriptor: DatasetDescriptor;
  daily: readonly DailyMetrics[];
  bidders: readonly BidderMetrics[];
  timeline?: PublisherTimeline;
}

type Period = { startDate: string; endDate: string };
export function periodMetrics(rows: readonly DailyMetrics[], period: Period) {
  const days = rows.filter((row) => row.date >= period.startDate && row.date <= period.endDate);
  assert(
    days.length > 0 && days.every((day) => !day.partial),
    'scenario comparisons require complete UTC days',
  );
  const sums = days.reduce(
    (total, day) => ({
      auctions: total.auctions + day.auctions,
      opportunities: total.opportunities + day.eligibleOpportunities,
      filled: total.filled + day.filledOpportunities,
      winningCpm: total.winningCpm + day.winningCpmTotal,
      revenue: total.revenue + day.estimatedRevenue,
    }),
    { auctions: 0, opportunities: 0, filled: 0, winningCpm: 0, revenue: 0 },
  );
  return {
    ...sums,
    fillRate: sums.filled / sums.opportunities,
    averageWinningCpm: sums.winningCpm / sums.filled,
  };
}

function bidderMetrics(rows: readonly BidderMetrics[], bidderId: string, period?: Period) {
  const selected = rows.filter(
    (row) =>
      row.bidderId === bidderId &&
      (!period || (row.date >= period.startDate && row.date <= period.endDate)),
  );
  const totals = selected.reduce(
    (total, row) => ({
      requests: total.requests + row.requests,
      responses: total.responses + row.responses,
      late: total.late + row.lateResponses,
      eligible: total.eligible + row.eligibleResponses,
      wins: total.wins + row.wins,
      revenue: total.revenue + row.estimatedRevenue,
      latencyTotal: total.latencyTotal + (row.averageLatencyMs ?? 0) * row.responses,
    }),
    { requests: 0, responses: 0, late: 0, eligible: 0, wins: 0, revenue: 0, latencyTotal: 0 },
  );
  assert(totals.requests > 0 && totals.responses > 0, 'scenario bidder must have observations');
  return {
    ...totals,
    responseRate: totals.responses / totals.requests,
    winRate: totals.wins / totals.requests,
    lateShare: totals.late / totals.responses,
    onTimeParticipation: totals.eligible / totals.requests,
    averageLatencyMs: totals.latencyTotal / totals.responses,
  };
}

/** Assertions use only ordinary records, never expected answers supplied to agent tools. */
export function verifyScenarios(datasets: readonly ScenarioDataset[]) {
  const a = datasets.find((dataset) => dataset.descriptor.publisherId === 'publisher-a');
  const b = datasets.find((dataset) => dataset.descriptor.publisherId === 'publisher-b');
  assert(a && b, 'both publishers are required');
  const before = periodMetrics(a.daily, SCENARIO_MANIFEST.publisherA.before);
  const after = periodMetrics(a.daily, SCENARIO_MANIFEST.publisherA.after);
  const decline = 1 - after.revenue / before.revenue;
  assert(
    decline >= 0.16 && decline <= 0.2,
    `Publisher A revenue decline ${decline} outside 16–20%`,
  );
  assert(
    Math.abs(after.auctions / before.auctions - 1) <= 0.05,
    'Publisher A traffic changed materially',
  );
  assert(after.fillRate < before.fillRate, 'Publisher A fill must decrease');
  assert(
    after.averageWinningCpm > before.averageWinningCpm &&
      after.averageWinningCpm / before.averageWinningCpm < 1.2,
    'Publisher A winning CPM must rise modestly',
  );
  if (a.timeline) {
    assert.equal(a.timeline.history.length, 2);
    assert.equal(a.timeline.history[1]!.timestamp, SCENARIO_MANIFEST.publisherA.changeAt);
    assert.equal(a.timeline.history[0]!.after.floorCpm, 0.8);
    assert.equal(a.timeline.history[1]!.after.floorCpm, 1.4);
  }
  const healthy = bidderMetrics(b.bidders, 'beacon', SCENARIO_MANIFEST.publisherB.healthy);
  const degraded = bidderMetrics(b.bidders, 'beacon', SCENARIO_MANIFEST.publisherB.degraded);
  assert(
    degraded.lateShare - healthy.lateShare >= 0.2,
    'Beacon late-response share must increase by at least 20 points',
  );
  assert(
    degraded.averageLatencyMs > healthy.averageLatencyMs &&
      degraded.onTimeParticipation < healthy.onTimeParticipation,
    'Beacon latency must reduce on-time participation',
  );
  assert(degraded.revenue < healthy.revenue, 'Beacon estimated revenue contribution must decrease');
  const healthyPublisher = periodMetrics(b.daily, SCENARIO_MANIFEST.publisherB.healthy);
  const degradedPublisher = periodMetrics(b.daily, SCENARIO_MANIFEST.publisherB.degraded);
  assert(
    Math.abs(degradedPublisher.auctions / healthyPublisher.auctions - 1) <= 0.05,
    'B latency window traffic must remain stable',
  );
  assert(
    degradedPublisher.revenue < healthyPublisher.revenue,
    'B latency window estimated revenue must decrease',
  );
  const weak = bidderMetrics(b.bidders, 'ember');
  assert(weak.responseRate <= 0.25 && weak.winRate <= 0.03, 'Ember must be consistently weak');
  for (const bidder of ['atlas', 'beacon', 'cedar', 'delta']) {
    const peer = bidderMetrics(b.bidders, bidder);
    assert(
      peer.responseRate > weak.responseRate * 2,
      'Healthy bidders must have materially better response rates',
    );
  }
  const clean = periodMetrics(b.daily, SCENARIO_MANIFEST.publisherB.cleanWeek);
  const growth = SCENARIO_MANIFEST.publisherB.growthWeeks.map((period) => {
    const current = periodMetrics(b.daily, period);
    const trafficDecline = 1 - current.auctions / clean.auctions;
    const revenueGrowth = current.revenue / clean.revenue - 1;
    assert(
      trafficDecline >= 0.1 && trafficDecline <= 0.15,
      `B growth traffic decline ${trafficDecline} outside 10–15%`,
    );
    assert(revenueGrowth >= 0.05, 'B revenue must grow at least 5% despite lower traffic');
    assert(
      current.fillRate > clean.fillRate && current.averageWinningCpm > clean.averageWinningCpm,
      'B growth must improve fill and winning CPM',
    );
    return {
      period,
      trafficDecline,
      revenueGrowth,
      fillRate: current.fillRate,
      averageWinningCpm: current.averageWinningCpm,
    };
  });
  if (b.timeline)
    assert.equal(
      b.timeline.history.length,
      1,
      'B incidents must not be confounded by invented config saves',
    );
  return {
    publisherA: { decline, trafficChange: after.auctions / before.auctions - 1, before, after },
    publisherB: { beacon: { healthy, degraded }, ember: weak, growth },
  };
}
