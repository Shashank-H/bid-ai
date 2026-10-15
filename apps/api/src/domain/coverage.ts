import type { PeriodInput } from '@bid/shared';

export function datesInPeriod(period: PeriodInput): string[] {
  const dates: string[] = [];

  for (
    let time = Date.parse(period.startDate);
    time <= Date.parse(period.endDate);
    time += 86_400_000
  ) {
    dates.push(new Date(time).toISOString().slice(0, 10));
  }

  return dates;
}

export function coverage(
  period: PeriodInput,
  rows: readonly { date: string; partial?: boolean | undefined }[],
) {
  const observedDates = [...new Set(rows.map((row) => row.date))].sort();

  return {
    period,
    observedDates,
    missingDates: datesInPeriod(period).filter((date) => !observedDates.includes(date)),
    partialDates: [...new Set(rows.filter((row) => row.partial).map((row) => row.date))].sort(),
  };
}
