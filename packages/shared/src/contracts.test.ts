import { describe, expect, it } from 'vitest';
import { AuctionEventSchema, BidderMetricsSchema, ConfigurationHistorySchema, ConfigurationSettingsSchema, DailyMetricsSchema, PeriodInputSchema, ProposalSchema, PublicUserSchema, StreamEventSchema, ToolResultSchema } from './index.js';

const timestamp = '2026-01-01T00:00:00.000Z';
const settings = { floorCpm: 0.8, auctionTimeoutMs: 1000, enabledBidders: ['bidder-a'], currency: 'USD' };
const evidence = { evidenceId: 'e1', publisherId: 'pub-a', source: 'daily-metrics', recordId: 'day-1', observedAt: timestamp };

describe('foundation contracts', () => {
  it('keeps publisher selection outside strict model period input', () => {
    expect(PeriodInputSchema.parse({ startDate: '2026-01-01', endDate: '2026-01-07' })).toBeDefined();
    expect(PeriodInputSchema.safeParse({ startDate: '2026-01-01', endDate: '2026-01-07', publisherId: 'pub-b' }).success).toBe(false);
    expect(PeriodInputSchema.safeParse({ startDate: '2026-01-07', endDate: '2026-01-01' }).success).toBe(false);
    expect(PeriodInputSchema.safeParse({ startDate: '2026-01-01', endDate: '2026-04-01' }).success).toBe(false);
  });

  it('does not expose credentials in public users', () => {
    expect(PublicUserSchema.safeParse({ userId: 'u1', login: 'alice', credentialHash: 'secret' }).success).toBe(false);
  });

  it('retains timing and currency without admitting eligible late responses', () => {
    const event = { eventId: 'e1', publisherId: 'pub-a', auctionId: 'a1', adUnitId: 'ad1', bidRequestId: 'r1', bidderId: 'b1', timestamp, currency: 'USD', type: 'bidResponse', cpm: 1, latencyMs: 100, late: false, eligible: true };

    expect(AuctionEventSchema.parse(event)).toEqual(event);
    expect(AuctionEventSchema.safeParse({ ...event, late: true }).success).toBe(false);
    expect(AuctionEventSchema.safeParse({ ...event, timestamp: '2026-01-01T01:00:00+01:00' }).success).toBe(false);
    expect(AuctionEventSchema.safeParse({ ...event, cpm: -1 }).success).toBe(false);
  });

  it('rejects negative or contradictory counters and permits missing denominator ratios', () => {
    const daily = { publisherId: 'pub-a', date: '2026-01-01', currency: 'USD', estimatedRevenue: 0, auctions: 0, opportunities: 0, eligibleOpportunities: 0, filledOpportunities: 0, winningCpmTotal: 0, fillRate: null, averageWinningCpm: null };

    expect(DailyMetricsSchema.parse(daily)).toEqual(daily);
    expect(DailyMetricsSchema.safeParse({ ...daily, auctions: -1 }).success).toBe(false);
    expect(DailyMetricsSchema.safeParse({ ...daily, filledOpportunities: 1 }).success).toBe(false);
    expect(BidderMetricsSchema.safeParse({ publisherId: 'pub-a', date: '2026-01-01', currency: 'USD', estimatedRevenue: 0, bidderId: 'b1', requests: 1, responses: 1, eligibleResponses: 0, lateResponses: 1, wins: 1, responseRate: 1, winRate: 1, averageLatencyMs: 1000 }).success).toBe(false);
  });

  it('bounds configuration fields and requires agent approval attribution', () => {
    expect(ConfigurationSettingsSchema.parse(settings)).toEqual(settings);
    expect(ConfigurationSettingsSchema.safeParse({ ...settings, enabledBidders: ['b1', 'b1'] }).success).toBe(false);
    expect(ConfigurationSettingsSchema.safeParse({ ...settings, floorCpm: 101 }).success).toBe(false);

    const history = { historyId: 'h1', publisherId: 'pub-a', version: 1, timestamp, updatedByUserId: 'u1', before: null, after: settings };

    expect(ConfigurationHistorySchema.parse(history)).toEqual(history);
    expect(ConfigurationHistorySchema.safeParse({ ...history, proposalId: 'p1' }).success).toBe(false);
  });

  it('requires evidence references and scoped proposal evidence', () => {
    const result = { summary: 'Estimated revenue fell.', evidence: [evidence], findings: [{ kind: 'observation', text: 'Estimated revenue fell.', evidenceIds: ['e1'] }] };

    expect(ToolResultSchema.parse(result)).toEqual(result);
    expect(ToolResultSchema.safeParse({ ...result, evidence: [] }).success).toBe(false);

    const proposal = { proposalId: 'p1', publisherId: 'pub-a', createdAt: timestamp, proposedByUserId: 'u1', expectedVersion: 1, before: settings, after: settings, rationale: 'Evaluate a controlled rollback.', evidence: [evidence], status: 'pending' };

    expect(ProposalSchema.parse(proposal)).toEqual(proposal);
    expect(ProposalSchema.safeParse({ ...proposal, publisherId: 'pub-b' }).success).toBe(false);
  });

  it('allows only public stream fields, not raw reasoning/provider payloads', () => {
    const delta = { type: 'text-delta', turnId: 't1', correlationId: 'c1', text: 'Observed change' };

    expect(StreamEventSchema.parse(delta)).toEqual(delta);
    expect(StreamEventSchema.safeParse({ ...delta, reasoning_content: 'private' }).success).toBe(false);
    expect(StreamEventSchema.safeParse({ ...delta, apiKey: 'secret' }).success).toBe(false);
  });
});
