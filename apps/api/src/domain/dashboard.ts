import { DashboardQuerySchema, DashboardResponseSchema } from '@bid/shared';
import type { DashboardQuery, DashboardResponse } from '@bid/shared';
import type { AnalyticsRepository, ExecutionContext } from './interfaces.js';
import { aggregateBidders, summary } from './analytics.js';

import { coverage, datesInPeriod } from './coverage.js';

export class Dashboard {
  constructor(private readonly repository: AnalyticsRepository) {}

  async query(context: ExecutionContext, input: DashboardQuery): Promise<DashboardResponse> {
    const { view, page, pageSize } = DashboardQuerySchema.parse(input);
    const periods = [view.period, ...(view.comparisonPeriod ? [view.comparisonPeriod] : [])];
    const daily = await Promise.all(
      periods.map((period) => this.repository.daily(context, period)),
    );
    const bidderRows =
      view.kind === 'bidder-performance'
        ? await Promise.all(periods.map((period) => this.repository.bidders(context, period)))
        : [];
    const rows =
      view.kind === 'publisher-performance'
        ? daily
        : bidderRows.map((records) =>
            records.filter(
              (row) => !view.bidderIds.length || view.bidderIds.includes(row.bidderId),
            ),
          );
    const allRecords = [
      ...new Map(
        rows.flat().map((row) => [`${row.date}:${'bidderId' in row ? row.bidderId : ''}`, row]),
      ).values(),
    ].sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        ('bidderId' in a ? a.bidderId : '').localeCompare('bidderId' in b ? b.bidderId : ''),
    );
    const series: DashboardResponse['series'] = [];

    for (const [index, period] of periods.entries()) {
      const records = rows[index]!;
      const ids =
        view.kind === 'bidder-performance'
          ? view.bidderIds.length
            ? view.bidderIds
            : [...new Set(bidderRows.flat().map((row) => row.bidderId))].sort()
          : [undefined];

      for (const bidderId of ids) {
        for (const date of datesInPeriod(period)) {
          const row = records.find(
            (record) =>
              record.date === date &&
              (bidderId === undefined || ('bidderId' in record && record.bidderId === bidderId)),
          );
          const value =
            row && view.metric in row
              ? (row as unknown as Record<string, unknown>)[view.metric]
              : null;

          series.push({
            date,
            period: index === 0 ? 'current' : 'previous',
            ...(bidderId ? { bidderId } : {}),
            value: typeof value === 'number' ? value : null,
          });
        }
      }
    }

    context.signal.throwIfAborted();

    return DashboardResponseSchema.parse({
      view,
      currency: daily.flat()[0]?.currency ?? bidderRows.flat()[0]?.currency ?? 'USD',
      current: view.kind === 'publisher-performance' ? summary(daily[0]!, view.period) : null,
      previous:
        view.kind === 'publisher-performance' && view.comparisonPeriod
          ? summary(daily[1]!, view.comparisonPeriod)
          : null,
      availableBidderIds: [...new Set(bidderRows.flat().map((row) => row.bidderId))].sort(),
      bidders:
        view.kind === 'bidder-performance'
          ? aggregateBidders(rows[0] as (typeof bidderRows)[number])
          : [],
      previousBidders:
        view.kind === 'bidder-performance' && view.comparisonPeriod
          ? aggregateBidders(rows[1] as (typeof bidderRows)[number])
          : [],
      coverage: periods.map((period, index) => ({
        ...coverage(period, rows[index]!),
        partialDates: daily[index]!.filter((row) => row.partial).map((row) => row.date),
      })),
      series,
      records: allRecords.slice((page - 1) * pageSize, page * pageSize),
      totalRecords: allRecords.length,
      page,
      pageSize,
    });
  }
}
