import type {
  DailyMetrics,
  EvidenceReference,
  PeriodInput,
  PerformanceSummary,
  ToolResult,
} from '@bid/shared';
import type { AnalyticsRepository, AnalyticsService, ExecutionContext } from './interfaces.js';

export function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function summary(records: readonly DailyMetrics[], period: PeriodInput): PerformanceSummary {
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

  return {
    ...counts,
    period,
    availableDays: records.length,
    currency: records[0]?.currency ?? 'USD',
    estimatedRevenue: winningCpmTotal / 1000,
    fillRate: ratio(counts.filledOpportunities, counts.eligibleOpportunities),
    averageWinningCpm: ratio(winningCpmTotal, counts.filledOpportunities),
  };
}

export function metricEvidence(
  context: ExecutionContext,
  records: readonly { date: string; bidderId?: string }[],
  source: 'daily-metrics' | 'bidder-metrics',
): EvidenceReference[] {
  return records.map((record) => {
    const recordId = `${context.identity.publisherId}-${source}-${record.date}${record.bidderId ? `-${record.bidderId}` : ''}`;

    return {
      evidenceId: recordId,
      publisherId: context.identity.publisherId,
      source,
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
      evidence: metricEvidence(context, records, 'daily-metrics'),
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
    const evidence = metricEvidence(
      context,
      [...currentRecords, ...previousRecords],
      'daily-metrics',
    );

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
      evidence: [...new Map(evidence.map((entry) => [entry.evidenceId, entry])).values()],
      findings: [],
    };
  }

  async bidderPerformance(context: ExecutionContext, period: PeriodInput): Promise<ToolResult> {
    const records = await this.repository.bidders(context, period);
    const ids = [...new Set(records.map((record) => record.bidderId))];
    const bidders = ids.map((bidderId) => {
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

      return {
        bidderId,
        ...counts,
        responseRate: ratio(counts.responses, counts.requests),
        winRate: ratio(counts.wins, counts.requests),
        averageLatencyMs: ratio(latencyTotal, latencyWeight),
      };
    });

    return {
      summary: records.length
        ? 'Bidder comparisons from observed metrics; revenue is estimated.'
        : 'No bidder observations in this period.',
      data: {
        kind: 'bidder-performance',
        period,
        currency: records[0]?.currency ?? 'USD',
        bidders,
      },
      evidence: metricEvidence(context, records, 'bidder-metrics'),
      findings: [],
    };
  }
}
