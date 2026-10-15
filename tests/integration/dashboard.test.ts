import { afterAll, expect, it } from 'vitest';
import { DashboardResponseSchema } from '@bid/shared';
import { buildApp } from '../../apps/api/src/app.js';
import { Authorization } from '../../apps/api/src/auth/authorization.js';
import { issueToken } from '../../apps/api/src/auth/token.js';
import { readAuthSettings } from '../../apps/api/src/env.js';
import { Dashboard } from '../../apps/api/src/domain/dashboard.js';
import { fixtureAnalytics } from '../../apps/api/src/fixtures/publishers.js';
import { Analytics } from '../../apps/api/src/domain/analytics.js';

const settings = readAuthSettings({
  AUTH_SIGNING_SECRET: 'dashboard-integration-signing-secret-at-least-32',
  APP_ORIGIN: 'http://localhost:8080',
});
const authorization = new Authorization(
  {
    async findById(userId) {
      return {
        userId,
        login: userId,
        disabled: false,
        credentialHash: 'x'.repeat(32),
        createdAt: '2025-01-01T00:00:00.000Z',
      };
    },
    async findByLogin() {
      return null;
    },
    async memberships(userId) {
      return [
        { userId, publisherId: userId === 'a' ? 'publisher-a' : 'publisher-b', role: 'viewer' },
      ];
    },
  },
  () => settings,
);
const app = buildApp({ checkReady: async () => true }, false, {
  authorization,
  dashboard: new Dashboard(fixtureAnalytics),
});
const period = { startDate: '2026-01-01', endDate: '2026-01-14' };
const view = { kind: 'publisher-performance', metric: 'estimatedRevenue', period };
const headers = (userId = 'a') => ({
  origin: settings.origin,
  cookie: `${settings.cookieName}=${issueToken(userId, settings)}`,
});

async function query(payload: unknown, userId = 'a') {
  return app.inject({
    method: 'POST',
    url: '/api/analytics/query',
    headers: headers(userId),
    payload,
  });
}

afterAll(() => app.close());

it('replays bidder views with weighted aggregates and complete paginated source rows', async () => {
  const bidderView = {
    kind: 'bidder-performance',
    metric: 'averageLatencyMs',
    period,
    bidderIds: ['atlas'],
  };
  const first = DashboardResponseSchema.parse(
    (await query({ view: bidderView, pageSize: 5 })).json(),
  );
  const all = [];

  for (let page = 1; page <= Math.ceil(first.totalRecords / 5); page++) {
    const result = DashboardResponseSchema.parse(
      (await query({ view: bidderView, pageSize: 5, page })).json(),
    );
    all.push(...result.records);
    expect(result.bidders).toEqual(first.bidders);
  }

  expect(first.availableBidderIds).toEqual(['atlas', 'beacon']);
  expect(first.bidders.map((bidder) => bidder.bidderId)).toEqual(['atlas']);
  expect(all).toHaveLength(14);
  expect(new Set(all.map((row) => row.date)).size).toBe(14);
  expect(all.every((row) => 'bidderId' in row && row.bidderId === 'atlas')).toBe(true);
  const auth = await authorization.resolveUser('a', Math.floor(Date.now() / 1000) + 60);
  const tool = await new Analytics(fixtureAnalytics).bidderPerformance(
    { identity: auth.identity, correlationId: 'test', signal: new AbortController().signal },
    period,
  );
  expect(first.bidders[0]).toEqual(
    tool.data?.kind === 'bidder-performance'
      ? tool.data.bidders.find((row) => row.bidderId === 'atlas')
      : null,
  );
  expect(tool.evidence[0]?.analytics?.view).toMatchObject({
    kind: 'bidder-performance',
    bidderIds: ['atlas'],
    period,
  });
});

it('preserves absent dates as null and deduplicates overlapping comparison records', async () => {
  const response = DashboardResponseSchema.parse(
    (
      await query({
        view: {
          ...view,
          period: { startDate: '2025-12-31', endDate: '2026-01-02' },
          comparisonPeriod: { startDate: '2026-01-01', endDate: '2026-01-02' },
        },
      })
    ).json(),
  );

  expect(response.coverage[0]?.missingDates).toEqual(['2025-12-31']);
  expect(response.series.find((point) => point.date === '2025-12-31')?.value).toBeNull();
  expect(response.totalRecords).toBe(2);
  expect(response.previous?.availableDays).toBe(2);
});

it('authenticates queries and rejects publisher overrides and unbounded filters', async () => {
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/analytics/query',
        headers: { origin: settings.origin },
        payload: { view },
      })
    ).statusCode,
  ).toBe(401);
  expect((await query({ view: { ...view, publisherId: 'publisher-b' } })).statusCode).toBe(400);
  expect((await query({ view: { ...view, metric: 'arbitrary-expression' } })).statusCode).toBe(400);
  expect(
    (await query({ view: { ...view, period: { startDate: '2025-01-01', endDate: '2026-01-01' } } }))
      .statusCode,
  ).toBe(400);
  expect((await query({ view, pageSize: 1000 })).statusCode).toBe(400);
});

it('uses publisher-scoped records and tool-equivalent totals independently of pagination', async () => {
  const response = await query({ view, pageSize: 2 });
  expect(response.statusCode).toBe(200);
  const first = DashboardResponseSchema.parse(response.json());
  const second = DashboardResponseSchema.parse(
    (await query({ view, pageSize: 2, page: 2 })).json(),
  );
  const other = DashboardResponseSchema.parse((await query({ view }, 'b')).json());
  const auth = await authorization.resolveUser('a', Math.floor(Date.now() / 1000) + 60);
  const result = await new Analytics(fixtureAnalytics).performanceSummary(
    { identity: auth.identity, correlationId: 'test', signal: new AbortController().signal },
    period,
  );

  expect(first.current).toEqual(
    result.data?.kind === 'performance-summary' ? result.data.metrics : null,
  );
  expect(second.current).toEqual(first.current);
  expect(first.records.every((record) => record.publisherId === 'publisher-a')).toBe(true);
  expect(other.records).toHaveLength(0);
  expect(first.records).toHaveLength(2);
  expect(first.records.map((record) => record.date)).not.toEqual(
    second.records.map((record) => record.date),
  );
});
