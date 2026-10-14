import { BidderMetricsSchema, ConfigurationHistorySchema, ConfigurationSchema, DailyMetricsSchema } from '@bid/shared';
import type { BidderMetrics, Configuration, ConfigurationHistory, DailyMetrics, PeriodInput } from '@bid/shared';
import type { AnalyticsRepository, ConfigurationRepository, ExecutionContext } from '../domain/interfaces.js';
import { HttpError } from '../errors.js';

export interface PublisherFixture {
  period: PeriodInput;
  daily: readonly DailyMetrics[];
  bidders: readonly BidderMetrics[];
  configuration: Configuration;
  history: readonly ConfigurationHistory[];
}

// Tiny, fixed demo observations, not a raw-event or historical scenario generator.
function fixture(letter: 'a' | 'b'): PublisherFixture {
  const publisherId = `publisher-${letter}`;
  const updatedByUserId = `demo-user-${letter}`;
  const month = letter === 'a' ? '01' : '02';
  const date = (day: number) => `2026-${month}-${String(day).padStart(2, '0')}`;
  const before = { floorCpm: letter === 'a' ? 0.8 : 1, auctionTimeoutMs: 1000,
    enabledBidders: ['atlas', 'beacon'], currency: 'USD' };
  const after = { ...before, floorCpm: letter === 'a' ? 1.2 : 1 };
  const daily: DailyMetrics[] = [];
  const bidders: BidderMetrics[] = [];

  for (let day = 1; day <= 14; day++) {
    const changed = day > 7;
    const opportunities = letter === 'a' || !changed ? 10000 : 9000;
    const filledOpportunities = letter === 'a' ? changed ? 4500 : 6000 : changed ? 7500 : 7000;
    const cpm = letter === 'a' ? changed ? 1.6 : 1.5 : changed ? 1.9 : 1.8;
    const winningCpmTotal = filledOpportunities * cpm;

    daily.push(DailyMetricsSchema.parse({ publisherId, date: date(day), currency: 'USD',
      auctions: opportunities, opportunities, eligibleOpportunities: opportunities, filledOpportunities,
      winningCpmTotal, estimatedRevenue: winningCpmTotal / 1000,
      fillRate: filledOpportunities / opportunities, averageWinningCpm: cpm }));

    for (const [index, bidderId] of before.enabledBidders.entries()) {
      const wins = filledOpportunities * (index === 0 ? 0.8 : 0.2);
      const responses = index === 0 ? Math.floor(opportunities * 0.9) : Math.floor(opportunities * 0.5);
      const lateResponses = letter === 'b' && changed && index === 1 ? 1500 : 100;

      bidders.push(BidderMetricsSchema.parse({ publisherId, bidderId, date: date(day), currency: 'USD',
        requests: opportunities, responses, eligibleResponses: responses - lateResponses, lateResponses, wins,
        estimatedRevenue: wins * cpm / 1000, responseRate: responses / opportunities,
        winRate: wins / opportunities, averageLatencyMs: index === 0 ? 180 : letter === 'b' && changed ? 1400 : 350 }));
    }
  }

  const history = [
    ConfigurationHistorySchema.parse({ historyId: `${publisherId}-initial`, publisherId, version: 1,
      timestamp: `${date(1)}T00:00:00.000Z`, updatedByUserId, before: null, after: before }),
    ...(letter === 'a' ? [ConfigurationHistorySchema.parse({ historyId: `${publisherId}-floor-change`, publisherId,
      version: 2, timestamp: `${date(8)}T00:00:00.000Z`, updatedByUserId, before, after })] : []),
  ];
  const latest = history.at(-1)!;

  return { period: { startDate: date(1), endDate: date(14) }, daily, bidders, history,
    configuration: ConfigurationSchema.parse({ publisherId, version: latest.version,
      updatedAt: latest.timestamp, updatedByUserId, settings: latest.after }) };
}

const fixtures: Readonly<Record<string, PublisherFixture>> = Object.freeze({
  'publisher-a': fixture('a'), 'publisher-b': fixture('b'),
});

export function publisherFixture(publisherId: string): PublisherFixture {
  const data = fixtures[publisherId];

  if (!data) throw new HttpError(404, 'NOT_FOUND', 'No demo data is available for this publisher.');

  return data;
}

export function fixtureMetadata(publisherId: string) {
  return { availablePeriod: publisherFixture(publisherId).period };
}

function inPeriod(date: string, period: PeriodInput): boolean {
  return date >= period.startDate && date <= period.endDate;
}

export const fixtureAnalytics: AnalyticsRepository = {
  async daily(context, period) {
    context.signal.throwIfAborted();

    return publisherFixture(context.identity.publisherId).daily.filter((record) => inPeriod(record.date, period));
  },
  async bidders(context, period) {
    context.signal.throwIfAborted();

    return publisherFixture(context.identity.publisherId).bidders.filter((record) => inPeriod(record.date, period));
  },
};

export const fixtureConfiguration: ConfigurationRepository = {
  async current(context: ExecutionContext) {
    context.signal.throwIfAborted();

    return publisherFixture(context.identity.publisherId).configuration;
  },
  async history(context, period) {
    context.signal.throwIfAborted();

    return publisherFixture(context.identity.publisherId).history.filter((record) => inPeriod(record.timestamp.slice(0, 10), period));
  },
  async save() {
    throw new HttpError(405, 'NOT_IMPLEMENTED', 'Configuration changes are not enabled.');
  },
};
