// Definitions only. Phase 2 owns event aggregation/reconciliation algorithms.
export const METRIC_SEMANTICS = Object.freeze({
  timeZone: 'UTC',
  opportunityIdentity: 'publisherId + auctionId + adUnitId',
  fillRate: 'filledOpportunities / eligibleOpportunities',
  responseRate: 'bidder responses / bidder requests',
  winRate: 'bidder wins / bidder requests',
  averageWinningCpm: 'sum winning CPM / filled opportunities',
  estimatedRevenue: 'sum winning CPM / 1000, in the recorded currency',
  zeroDenominator: 'null, not zero or Infinity',
  lateResponses: 'retained as observations but excluded from eligible responses and wins',
  revenueLabel: 'Estimated revenue',
  paymentAttribution: 'bidWon does not verify paid ad-server revenue',
});
