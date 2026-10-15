import type {
  DailyMetrics,
  BidderMetrics,
  EvidenceReference,
  PeriodInput,
  PerformanceSummary,
  ToolResult,
} from '@bid/shared';
import type { AnalyticsRepository, AnalyticsService, ExecutionContext } from './interfaces.js';
import { coverage } from './coverage.js';

export function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

export function summary(records: readonly DailyMetrics[], period: PeriodInput): PerformanceSummary {
  const totals = records.reduce(
    (acc, row) => ({
      auctions: acc.auctions + row.auctions,
      opportunities: acc.opportunities + row.opportunities,
      eligibleOpportunities: acc.eligibleOpportunities + row.eligibleOpportunities,
      filledOpportunities: acc.filledOpportunities + row.filledOpportunities,
      winningCpmTotal: acc.winningCpmTotal + row.winningCpmTotal,
    }),
    {
      auctions: 0,
      opportunities: 0,
      eligibleOpportunities: 0,
      filledOpportunities: 0,
      winningCpmTotal: 0,
    },
  );
  const { winningCpmTotal, ...counts } = totals;
  const hasWaitMetrics =
    records.length > 0 && records.every((row) => row.auctionWaitMsTotal !== undefined);
  const hasPartialDates = records.length > 0 && records.every((row) => row.partial !== undefined);

  return {
    ...counts,
    period,
    availableDays: records.length,
    currency: records[0]?.currency ?? 'USD',
    estimatedRevenue: winningCpmTotal / 1000,
    fillRate: ratio(counts.filledOpportunities, counts.eligibleOpportunities),
    averageWinningCpm: ratio(winningCpmTotal, counts.filledOpportunities),
    ...(hasWaitMetrics
      ? {
          averageAuctionWaitMs: ratio(
            records.reduce((sum, row) => sum + row.auctionWaitMsTotal!, 0),
            counts.auctions,
          ),
        }
      : {}),
    ...(hasPartialDates
      ? { partialDates: records.filter((row) => row.partial).map((row) => row.date) }
      : {}),
  };
}

function metricEvidence(
  context: ExecutionContext,
  records: readonly { date: string }[],
): EvidenceReference[] {
  return records.map((record) => {
    const recordId = `${context.identity.publisherId}-daily-metrics-${record.date}`;

    return {
      evidenceId: recordId,
      publisherId: context.identity.publisherId,
      source: 'daily-metrics',
      recordId,
      observedAt: `${record.date}T00:00:00.000Z`,
    };
  });
}

export class Analytics implements AnalyticsService {
  constructor(private readonly repository: AnalyticsRepository) {}

  async performanceSummary(context: ExecutionContext, period: PeriodInput): Promise<ToolResult> {
    const records = await this.repository.daily(context, period);
    const metrics = summary(records, period);

    return {
      summary: records.length
        ? 'Performance totals; all revenue is estimated.'
        : 'No observations in this period.',
      data: { kind: 'performance-summary', metrics },
      evidence: records.length
        ? [
            {
              ...metricEvidence(context, records)[0]!,
              analytics: {
                title: 'Publisher performance',
                summary: `Examined ${records.length} observed UTC days from ${period.startDate} to ${period.endDate}. Estimated revenue: ${metrics.currency} ${metrics.estimatedRevenue.toFixed(2)}.`,
                view: { kind: 'publisher-performance', metric: 'estimatedRevenue', period },
                coverage: [coverage(period, records)],
              },
            },
          ]
        : [],
      findings: [],
    };
  }

  async comparePeriods(
    context: ExecutionContext,
    periods: { current: PeriodInput; previous: PeriodInput },
  ): Promise<ToolResult> {
    const currentRecords = await this.repository.daily(context, periods.current);
    const previousRecords = await this.repository.daily(context, periods.previous);
    const current = summary(currentRecords, periods.current);
    const previous = summary(previousRecords, periods.previous);
    const hasBoth = currentRecords.length > 0 && previousRecords.length > 0;
    const evidence = metricEvidence(context, [...currentRecords, ...previousRecords]);

    return {
      summary: hasBoth
        ? 'Compare observed estimated revenue, fill and weighted winning CPM; correlation is not proof of cause.'
        : 'One or both periods have no observations.',
      data: {
        kind: 'period-comparison',
        current,
        previous,
        estimatedRevenueChange: hasBoth
          ? current.estimatedRevenue - previous.estimatedRevenue
          : null,
        estimatedRevenueChangePercent:
          hasBoth && previous.estimatedRevenue !== 0
            ? (current.estimatedRevenue / previous.estimatedRevenue - 1) * 100
            : null,
      },
      evidence: evidence.length
        ? [
            {
              ...evidence[0]!,
              analytics: {
                title: 'Estimated revenue comparison',
                summary: `Compared ${periods.current.startDate}–${periods.current.endDate} (${current.currency} ${current.estimatedRevenue.toFixed(2)}) with ${periods.previous.startDate}–${periods.previous.endDate} (${previous.currency} ${previous.estimatedRevenue.toFixed(2)}). ${!hasBoth ? 'One or both periods have no observations; a change cannot be established.' : previous.estimatedRevenue === 0 ? 'Percentage change is undefined because previous estimated revenue is zero.' : `Change: ${((current.estimatedRevenue / previous.estimatedRevenue - 1) * 100).toFixed(1)}%.`} Correlation does not establish cause.`,
                view: {
                  kind: 'publisher-performance',
                  metric: 'estimatedRevenue',
                  period: periods.current,
                  comparisonPeriod: periods.previous,
                },
                coverage: [
                  coverage(periods.current, currentRecords),
                  coverage(periods.previous, previousRecords),
                ],
              },
            },
          ]
        : [],
      findings: [],
    };
  }

  async bidderPerformance(context: ExecutionContext, period: PeriodInput): Promise<ToolResult> {
    const [records, dailyRecords] = await Promise.all([
      this.repository.bidders(context, period),
      this.repository.daily(context, period),
    ]);
    const ids = [...new Set(records.map((record) => record.bidderId))];
    const bidders = aggregateBidders(records);

    return {
      summary: records.length
        ? 'Bidder comparisons from observed metrics. Responses are observed offers counted once across accepted/rejected outcomes; timeout can coexist with a later offer. Revenue is estimated.'
        : 'No bidder observations in this period.',
      data: {
        kind: 'bidder-performance',
        period,
        currency: records[0]?.currency ?? 'USD',
        bidders,
      },
      evidence: ids.map((bidderId) => ({
        evidenceId: `${context.identity.publisherId}-bidder-${bidderId}`,
        publisherId: context.identity.publisherId,
        source: 'bidder-metrics' as const,
        recordId: `${bidderId}-${period.startDate}-${period.endDate}`,
        observedAt: `${records
          .filter((row) => row.bidderId === bidderId)
          .map((row) => row.date)
          .sort()
          .at(-1)!}T00:00:00.000Z`,
        referenceType: 'period-aggregate' as const,
        period,
        bidderId,
        analytics: {
          title: `${bidderId} performance`,
          summary: `Examined ${bidderId} from ${period.startDate} to ${period.endDate}: ${bidders.find((row) => row.bidderId === bidderId)!.requests} requests and ${bidders.find((row) => row.bidderId === bidderId)!.responses} observed offers. Revenue is estimated.`,
          view: {
            kind: 'bidder-performance' as const,
            metric: 'estimatedRevenue' as const,
            period,
            bidderIds: [bidderId],
          },
          coverage: [
            {
              ...coverage(
                period,
                records.filter((row) => row.bidderId === bidderId),
              ),
              partialDates: dailyRecords.filter((row) => row.partial).map((row) => row.date),
            },
          ],
        },
      })),
      findings: [],
    };
  }
}

export function aggregateBidders(records: readonly BidderMetrics[]) {
  return [...new Set(records.map((record) => record.bidderId))].sort().map((bidderId) => {
    const rows = records.filter((row) => row.bidderId === bidderId);
    const totals = rows.reduce(
      (acc, row) => ({
        requests: acc.requests + row.requests,
        responses: acc.responses + row.responses,
        eligibleResponses: acc.eligibleResponses + row.eligibleResponses,
        lateResponses: acc.lateResponses + row.lateResponses,
        wins: acc.wins + row.wins,
        estimatedRevenue: acc.estimatedRevenue + row.estimatedRevenue,
        latencyWeight: acc.latencyWeight + (row.averageLatencyMs === null ? 0 : row.responses),
        latencyTotal: acc.latencyTotal + (row.averageLatencyMs ?? 0) * row.responses,
      }),
      {
        requests: 0,
        responses: 0,
        eligibleResponses: 0,
        lateResponses: 0,
        wins: 0,
        estimatedRevenue: 0,
        latencyWeight: 0,
        latencyTotal: 0,
      },
    );
    const { latencyWeight, latencyTotal, ...counts } = totals;
    const optionalCounters = [
      'acceptedResponses',
      'rejectedResponses',
      'timeouts',
      'noBids',
    ] as const;
    const observedCounters = Object.fromEntries(
      optionalCounters
        .filter((key) => rows.every((row) => row[key] !== undefined))
        .map((key) => [key, rows.reduce((sum, row) => sum + row[key]!, 0)]),
    );

    return {
      bidderId,
      ...counts,
      ...observedCounters,
      responseRate: ratio(counts.responses, counts.requests),
      winRate: ratio(counts.wins, counts.requests),
      averageLatencyMs: ratio(latencyTotal, latencyWeight),
    };
  });
}
