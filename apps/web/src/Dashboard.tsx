import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import {
  BidderMetricSchema,
  DashboardResponseSchema,
  DashboardViewSchema,
  PublisherMetricSchema,
} from '@bid/shared';
import type { AuthResponse, DashboardResponse, DashboardView } from '@bid/shared';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api, ApiError } from './api.js';
import './dashboard.css';

const labels: Record<string, string> = {
  estimatedRevenue: 'Estimated revenue',
  auctions: 'Auctions',
  opportunities: 'Opportunities',
  fillRate: 'Fill rate',
  averageWinningCpm: 'Average winning CPM',
  averageAuctionWaitMs: 'Average auction wait',
  requests: 'Requests',
  responses: 'Observed offers',
  responseRate: 'Response rate',
  winRate: 'Win rate',
  averageLatencyMs: 'Average offer latency',
  wins: 'Wins',
};
const colors = [
  'var(--accent)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
];
const dayMs = 86_400_000;

function format(
  value: number | null | undefined,
  metric: string,
  currency: string,
  compact = false,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (metric.endsWith('Rate')) return `${(value * 100).toFixed(1)}%`;
  if (metric.endsWith('Ms')) return `${value.toFixed(1)} ms`;
  if (metric === 'estimatedRevenue' || metric === 'averageWinningCpm') {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
      ...(compact ? { notation: 'compact' as const } : {}),
    }).format(value);
  }
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 0,
    ...(compact ? { notation: 'compact' as const } : {}),
  }).format(value);
}

function trendData(data: DashboardResponse) {
  const days = (period: { startDate: string; endDate: string }) =>
    Math.round((Date.parse(period.endDate) - Date.parse(period.startDate)) / dayMs) + 1;
  const length = Math.max(
    days(data.view.period),
    data.view.comparisonPeriod ? days(data.view.comparisonPeriod) : 0,
  );
  const rows: Record<string, string | number | null>[] = Array.from({ length }, (_, index) => ({
    day: index + 1,
  }));
  const descriptors = new Map<
    string,
    { key: string; name: string; color: string; previous: boolean }
  >();
  const bidders = [
    ...new Set(data.series.flatMap((point) => (point.bidderId ? [point.bidderId] : []))),
  ];

  for (const point of data.series) {
    const period = point.period === 'current' ? data.view.period : data.view.comparisonPeriod!;
    const index = Math.round((Date.parse(point.date) - Date.parse(period.startDate)) / dayMs);
    const key = `${point.bidderId ?? 'publisher'}-${point.period}`;
    const row = rows[index];
    if (!row) continue;
    row[key] = point.value;
    row[`${point.period}Date`] = point.date;
    descriptors.set(key, {
      key,
      name: `${point.bidderId ? `${point.bidderId} · ` : ''}${point.period === 'current' ? 'Current period' : 'Previous period'}`,
      color: colors[Math.max(0, bidders.indexOf(point.bidderId ?? '')) % colors.length]!,
      previous: point.period === 'previous',
    });
  }
  return { rows, lines: [...descriptors.values()] };
}

export function Dashboard({
  auth,
  view,
  onViewChange,
  onUnauthorized,
}: {
  auth: AuthResponse;
  view: DashboardView | null;
  onViewChange: (view: DashboardView) => void;
  onUnauthorized: () => void;
}) {
  const [draft, setDraft] = useState<DashboardView | null>(view);
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [availableBidders, setAvailableBidders] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [filterError, setFilterError] = useState('');
  const [inspected, setInspected] = useState(0);
  const viewKey = JSON.stringify(view);

  useEffect(() => {
    setDraft(view);
    setPage(1);
    setInspected(0);
    setFilterError('');
  }, [viewKey]);

  useEffect(() => {
    if (!view) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setData(null);
    void api(
      '/api/analytics/query',
      DashboardResponseSchema,
      { view, page, pageSize: 20 },
      controller.signal,
    )
      .then((result) => {
        if (controller.signal.aborted) return;
        setData(result);
        setAvailableBidders(result.availableBidderIds);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiError && cause.status === 401) onUnauthorized();
        else setError(cause instanceof Error ? cause.message : 'Analytics could not be loaded.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [viewKey, page, retry]);

  function apply(event: FormEvent) {
    event.preventDefault();
    const parsed = DashboardViewSchema.safeParse(draft);
    if (!parsed.success) {
      setFilterError(
        'Choose a supported metric, valid ordered UTC dates, and at most 90 days per period.',
      );
      return;
    }
    setFilterError('');
    setPage(1);
    onViewChange(parsed.data);
  }

  if (!view || !draft) {
    return (
      <div className="dashboard-empty" role="status">
        <h2>
          {auth.status === 'loading' ? 'Your dataset is loading' : 'No complete observations yet'}
        </h2>
        <p>
          Charts and matching records will appear when publisher analytics are available. No fixture
          data is substituted.
        </p>
      </div>
    );
  }

  const chart = data ? trendData(data) : null;
  const inspectedRow = chart?.rows[Math.min(inspected, Math.max(0, chart.rows.length - 1))];
  const publisher = data?.current;
  const revenue =
    publisher?.estimatedRevenue ??
    data?.bidders.reduce((total, bidder) => total + bidder.estimatedRevenue, 0);
  const previousRevenue =
    data?.previous?.estimatedRevenue ??
    data?.previousBidders.reduce((total, bidder) => total + bidder.estimatedRevenue, 0);
  const observedBoth =
    !!data?.coverage[0]?.observedDates.length && !!data?.coverage[1]?.observedDates.length;
  const delta =
    observedBoth && revenue !== undefined && previousRevenue !== undefined
      ? revenue - previousRevenue
      : null;
  const percent = delta !== null && previousRevenue ? (delta / previousRevenue) * 100 : null;
  const totalPages = data ? Math.max(1, Math.ceil(data.totalRecords / data.pageSize)) : 1;
  const metricOptions =
    draft.kind === 'publisher-performance'
      ? PublisherMetricSchema.options
      : BidderMetricSchema.options;
  const bidderOptions = [
    ...new Set([
      ...availableBidders,
      ...(draft.kind === 'bidder-performance' ? draft.bidderIds : []),
    ]),
  ].sort();

  return (
    <div className="analytics-dashboard">
      <form className="dashboard-filters" onSubmit={apply} aria-label="Dashboard filters">
        <div className="filter-fields">
          <label>
            Metric
            <select
              value={draft.metric}
              onChange={(event) =>
                setDraft({ ...draft, metric: event.target.value } as DashboardView)
              }
            >
              {metricOptions.map((metric) => (
                <option key={metric} value={metric}>
                  {labels[metric]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Start date (UTC)
            <input
              type="date"
              required
              value={draft.period.startDate}
              onChange={(event) =>
                setDraft({ ...draft, period: { ...draft.period, startDate: event.target.value } })
              }
            />
          </label>
          <label>
            End date (UTC)
            <input
              type="date"
              required
              value={draft.period.endDate}
              onChange={(event) =>
                setDraft({ ...draft, period: { ...draft.period, endDate: event.target.value } })
              }
            />
          </label>
          <button type="submit" className="apply-filters">
            Apply filters
          </button>
        </div>
        <label className="comparison-toggle">
          <input
            type="checkbox"
            checked={!!draft.comparisonPeriod}
            onChange={(event) => {
              if (event.target.checked) {
                const end = Date.parse(draft.period.startDate) - dayMs;
                const length = Math.max(
                  0,
                  Date.parse(draft.period.endDate) - Date.parse(draft.period.startDate),
                );
                if (!Number.isFinite(end) || !Number.isFinite(length)) return;
                setDraft({
                  ...draft,
                  comparisonPeriod: {
                    startDate: new Date(end - length).toISOString().slice(0, 10),
                    endDate: new Date(end).toISOString().slice(0, 10),
                  },
                });
              } else {
                const { comparisonPeriod: _, ...withoutComparison } = draft;
                setDraft(withoutComparison);
              }
            }}
          />
          Compare with another period
        </label>
        {draft.comparisonPeriod && (
          <div className="comparison-fields">
            <label>
              Comparison start (UTC)
              <input
                type="date"
                required
                value={draft.comparisonPeriod.startDate}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    comparisonPeriod: { ...draft.comparisonPeriod!, startDate: event.target.value },
                  })
                }
              />
            </label>
            <label>
              Comparison end (UTC)
              <input
                type="date"
                required
                value={draft.comparisonPeriod.endDate}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    comparisonPeriod: { ...draft.comparisonPeriod!, endDate: event.target.value },
                  })
                }
              />
            </label>
          </div>
        )}
        {draft.kind === 'bidder-performance' && (
          <fieldset className="bidder-filters">
            <legend>
              Bidders <span>(none selected means all)</span>
            </legend>
            {bidderOptions.map((id) => (
              <label key={id}>
                <input
                  type="checkbox"
                  checked={draft.bidderIds.includes(id)}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      bidderIds: event.target.checked
                        ? [...draft.bidderIds, id]
                        : draft.bidderIds.filter((bidder) => bidder !== id),
                    })
                  }
                />
                {id}
              </label>
            ))}
            {!bidderOptions.length && (
              <span className="hint">Bidder choices appear when observations are loaded.</span>
            )}
          </fieldset>
        )}
        {filterError && (
          <p className="error" role="alert">
            {filterError}
          </p>
        )}
      </form>

      <div className="applied-view" aria-label="Applied dashboard filters">
        <span>
          {view.period.startDate} – {view.period.endDate} UTC
        </span>
        {view.comparisonPeriod && (
          <span>
            vs {view.comparisonPeriod.startDate} – {view.comparisonPeriod.endDate} UTC
          </span>
        )}
        <span>{labels[view.metric]}</span>
        {view.kind === 'bidder-performance' && (
          <span>{view.bidderIds.length ? view.bidderIds.join(', ') : 'All bidders'}</span>
        )}
      </div>

      {loading && (
        <div className="dashboard-loading" role="status">
          <div />
          <div />
          <div />
          <span>Loading observed analytics…</span>
        </div>
      )}
      {error && (
        <div className="dashboard-error">
          <p className="error" role="alert">
            {error}
          </p>
          <button className="secondary" onClick={() => setRetry((value) => value + 1)}>
            Try again
          </button>
        </div>
      )}
      {data && (
        <>
          <div className="metric-grid">
            <div className="metric-tile">
              <span>Estimated revenue</span>
              <strong>
                {format(
                  data.coverage[0]?.observedDates.length ? revenue : null,
                  'estimatedRevenue',
                  data.currency,
                )}
              </strong>
              <small>{data.currency} · synthetic observations</small>
            </div>
            {publisher ? (
              <>
                <div className="metric-tile">
                  <span>Auctions</span>
                  <strong>
                    {format(
                      data.coverage[0]?.observedDates.length ? publisher.auctions : null,
                      'auctions',
                      data.currency,
                    )}
                  </strong>
                  <small>{publisher.availableDays} observed UTC days</small>
                </div>
                <div className="metric-tile">
                  <span>Fill rate</span>
                  <strong>{format(publisher.fillRate, 'fillRate', data.currency)}</strong>
                  <small>Filled / eligible opportunities</small>
                </div>
                <div className="metric-tile">
                  <span>Average winning CPM</span>
                  <strong>
                    {format(publisher.averageWinningCpm, 'averageWinningCpm', data.currency)}
                  </strong>
                  <small>Weighted across filled opportunities</small>
                </div>
              </>
            ) : (
              <>
                <div className="metric-tile">
                  <span>Requests</span>
                  <strong>
                    {format(
                      data.coverage[0]?.observedDates.length
                        ? data.bidders.reduce((sum, bidder) => sum + bidder.requests, 0)
                        : null,
                      'requests',
                      data.currency,
                    )}
                  </strong>
                  <small>Selected bidders</small>
                </div>
                <div className="metric-tile">
                  <span>Observed offers</span>
                  <strong>
                    {format(
                      data.coverage[0]?.observedDates.length
                        ? data.bidders.reduce((sum, bidder) => sum + bidder.responses, 0)
                        : null,
                      'responses',
                      data.currency,
                    )}
                  </strong>
                  <small>Accepted and rejected, counted once</small>
                </div>
                <div className="metric-tile">
                  <span>Wins</span>
                  <strong>
                    {format(
                      data.coverage[0]?.observedDates.length
                        ? data.bidders.reduce((sum, bidder) => sum + bidder.wins, 0)
                        : null,
                      'wins',
                      data.currency,
                    )}
                  </strong>
                  <small>Selected bidders</small>
                </div>
              </>
            )}
          </div>
          {view.comparisonPeriod && (
            <p className="comparison-result">
              Estimated revenue change:{' '}
              <strong>{format(delta, 'estimatedRevenue', data.currency)}</strong>
              {percent === null
                ? ' · percentage change unavailable (zero baseline or missing observations)'
                : ` · ${percent > 0 ? '+' : ''}${percent.toFixed(1)}%`}
            </p>
          )}
          {data.coverage.map(
            (period, index) =>
              (period.missingDates.length > 0 || period.partialDates.length > 0) && (
                <p key={index} className="coverage-note" role="note">
                  <strong>{index === 0 ? 'Current' : 'Previous'} period coverage:</strong>
                  {period.missingDates.length > 0 &&
                    ` ${period.missingDates.length} missing UTC date${period.missingDates.length === 1 ? '' : 's'} (${period.missingDates.join(', ')}).`}
                  {period.partialDates.length > 0 &&
                    ` Partial days: ${period.partialDates.join(', ')}. Totals are not extrapolated.`}
                </p>
              ),
          )}
          {!data.totalRecords && (
            <div className="dashboard-empty" role="status">
              <h2>No matching observations</h2>
              <p>
                Adjust the UTC dates or bidder selection. Missing observations are not measured
                zeroes.
              </p>
            </div>
          )}
          {!!data.totalRecords && chart && (
            <>
              <section className="analytics-chart" aria-labelledby="trend-title">
                <header>
                  <div>
                    <h2 id="trend-title">{labels[view.metric]} trend</h2>
                    <p>
                      {view.comparisonPeriod
                        ? 'Periods aligned by day number. Inspect points for their actual UTC dates.'
                        : 'Daily observed values · UTC'}
                    </p>
                  </div>
                  <span className="chart-unit">
                    {view.metric === 'estimatedRevenue' || view.metric === 'averageWinningCpm'
                      ? data.currency
                      : view.metric.endsWith('Ms')
                        ? 'Milliseconds'
                        : view.metric.endsWith('Rate')
                          ? 'Percent'
                          : 'Count'}
                  </span>
                </header>
                <div className="chart-canvas">
                  <ResponsiveContainer width="100%" height="100%" minWidth={0} debounce={40}>
                    <LineChart
                      data={chart.rows}
                      margin={{ top: 10, right: 12, bottom: 2, left: 0 }}
                      accessibilityLayer
                    >
                      <CartesianGrid
                        vertical={false}
                        stroke="var(--border)"
                        strokeDasharray="3 5"
                      />
                      <XAxis
                        dataKey="day"
                        tickLine={false}
                        axisLine={false}
                        minTickGap={24}
                        tick={{ fill: 'var(--muted)', fontSize: 11 }}
                        tickFormatter={(value: number) =>
                          view.comparisonPeriod
                            ? `Day ${value}`
                            : String(chart.rows[value - 1]?.currentDate ?? '').slice(5)
                        }
                      />
                      <YAxis
                        tickLine={false}
                        axisLine={false}
                        width={76}
                        tick={{ fill: 'var(--muted)', fontSize: 11 }}
                        tickFormatter={(value: number) =>
                          format(value, view.metric, data.currency, true)
                        }
                      />
                      <Tooltip
                        labelStyle={{ color: 'var(--text)' }}
                        cursor={{ stroke: 'var(--muted)', strokeDasharray: '3 4' }}
                        contentStyle={{
                          border: '1px solid var(--border)',
                          borderRadius: 0,
                          fontSize: 12,
                          background: 'var(--canvas)',
                          color: 'var(--text)',
                        }}
                        formatter={(value) =>
                          format(
                            typeof value === 'number' ? value : null,
                            view.metric,
                            data.currency,
                          )
                        }
                        labelFormatter={(label) => {
                          const row = chart.rows[Number(label) - 1];
                          return (
                            [row?.currentDate, row?.previousDate].filter(Boolean).join(' / ') +
                            ' UTC'
                          );
                        }}
                      />
                      <Legend wrapperStyle={{ fontSize: 11, paddingTop: 12 }} />
                      {chart.lines.map((line) => (
                        <Line
                          key={line.key}
                          dataKey={line.key}
                          name={line.name}
                          type="linear"
                          stroke={line.color}
                          strokeWidth={2}
                          strokeDasharray={line.previous ? '5 4' : '0'}
                          dot={false}
                          activeDot={{ r: 4 }}
                          connectNulls={false}
                          isAnimationActive={false}
                        />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <details className="chart-inspection">
                  <summary>Inspect chart values with keyboard</summary>
                  <label>
                    Day in chart
                    <select
                      value={Math.min(inspected, chart.rows.length - 1)}
                      onChange={(event) => setInspected(Number(event.target.value))}
                    >
                      {chart.rows.map((row, index) => (
                        <option key={index} value={index}>
                          Day {index + 1}:{' '}
                          {[row.currentDate, row.previousDate].filter(Boolean).join(' / ')}
                        </option>
                      ))}
                    </select>
                  </label>
                  <ul>
                    {chart.lines.map((line) => (
                      <li key={line.key}>
                        <span>{line.name}</span>
                        <strong>
                          {format(
                            typeof inspectedRow?.[line.key] === 'number'
                              ? (inspectedRow[line.key] as number)
                              : null,
                            view.metric,
                            data.currency,
                          )}
                        </strong>
                      </li>
                    ))}
                  </ul>
                </details>
              </section>
              <section className="matching-records" aria-labelledby="records-title">
                <header>
                  <div>
                    <h2 id="records-title">Matching records</h2>
                    <p>
                      {data.totalRecords}{' '}
                      {view.kind === 'publisher-performance' ? 'daily publisher' : 'daily bidder'}{' '}
                      metric records · all matching dates, not an agent-selected sample
                    </p>
                  </div>
                </header>
                <div
                  className="records-scroll"
                  tabIndex={0}
                  role="region"
                  aria-label="Matching records table"
                >
                  <table>
                    <caption className="sr-only">
                      Daily {view.kind === 'publisher-performance' ? 'publisher' : 'bidder'} metric
                      records. Money is estimated revenue in {data.currency}.
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">UTC date</th>
                        {view.kind === 'bidder-performance' && <th scope="col">Bidder</th>}
                        <th scope="col">Estimated revenue ({data.currency})</th>
                        {view.kind === 'publisher-performance' ? (
                          <>
                            <th scope="col">Auctions</th>
                            <th scope="col">Eligible opportunities</th>
                            <th scope="col">Filled opportunities</th>
                            <th scope="col">Fill rate</th>
                            <th scope="col">Winning CPM ({data.currency})</th>
                          </>
                        ) : (
                          <>
                            <th scope="col">Requests</th>
                            <th scope="col">Offers</th>
                            <th scope="col">Eligible offers</th>
                            <th scope="col">Late offers</th>
                            <th scope="col">Wins</th>
                            <th scope="col">Response rate</th>
                            <th scope="col">Win rate</th>
                            <th scope="col">Latency (ms)</th>
                          </>
                        )}
                        <th scope="col">Coverage</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.records.map((record) => (
                        <tr key={`${record.date}:${'bidderId' in record ? record.bidderId : ''}`}>
                          <th scope="row">{record.date}</th>
                          {'bidderId' in record && <td>{record.bidderId}</td>}
                          <td>
                            {format(record.estimatedRevenue, 'estimatedRevenue', data.currency)}
                          </td>
                          {'bidderId' in record ? (
                            <>
                              <td>{format(record.requests, 'requests', data.currency)}</td>
                              <td>{format(record.responses, 'responses', data.currency)}</td>
                              <td>
                                {format(record.eligibleResponses, 'responses', data.currency)}
                              </td>
                              <td>{format(record.lateResponses, 'responses', data.currency)}</td>
                              <td>{format(record.wins, 'wins', data.currency)}</td>
                              <td>{format(record.responseRate, 'responseRate', data.currency)}</td>
                              <td>{format(record.winRate, 'winRate', data.currency)}</td>
                              <td>
                                {format(record.averageLatencyMs, 'averageLatencyMs', data.currency)}
                              </td>
                            </>
                          ) : (
                            <>
                              <td>{format(record.auctions, 'auctions', data.currency)}</td>
                              <td>
                                {format(
                                  record.eligibleOpportunities,
                                  'opportunities',
                                  data.currency,
                                )}
                              </td>
                              <td>
                                {format(record.filledOpportunities, 'opportunities', data.currency)}
                              </td>
                              <td>{format(record.fillRate, 'fillRate', data.currency)}</td>
                              <td>
                                {format(
                                  record.averageWinningCpm,
                                  'averageWinningCpm',
                                  data.currency,
                                )}
                              </td>
                            </>
                          )}
                          <td>
                            {data.coverage.some((coverage) =>
                              coverage.partialDates.includes(record.date),
                            )
                              ? 'Partial day'
                              : 'Observed'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="records-pagination">
                  <span>
                    Page {page} of {totalPages} · {data.records.length} shown
                  </span>
                  <div>
                    <button
                      className="secondary"
                      disabled={page <= 1}
                      onClick={() => setPage((value) => value - 1)}
                    >
                      Previous
                    </button>
                    <button
                      className="secondary"
                      disabled={page >= totalPages}
                      onClick={() => setPage((value) => value + 1)}
                    >
                      Next
                    </button>
                  </div>
                </div>
              </section>
            </>
          )}
          <p className="dashboard-data-note">
            Synthetic observations. Earnings are estimated revenue, not verified paid revenue.
            Comparisons do not establish causation.
          </p>
        </>
      )}
    </div>
  );
}
