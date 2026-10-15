# Phase 3 — Event and metric semantics

This dataset is a normalized, synthetic record of the supported banner flow, **not untouched Prebid.js hook payloads**. The [pinned Prebid profile](PREBID-CONFIGURATION.md) defines the native behavior, supported settings and explicit simulation assumptions. All earnings are **Estimated revenue**.

## Storage units and logical observations

The user-approved replacement layout stores **one uncompressed item per auction**, not one item per normalized event. An auction record retains its configuration/version and timing header, initiation/end observations, and five bidder entries with request, response, completion, timeout, candidate, win and render details as applicable. Original event IDs, timestamps and payloads are preserved; this is structured JSON, not compression or arbitrary multi-auction chunks.

The expected default dataset contains **110,288 auctions / auction items** and **1,925,599 logical normalized events**. Configuration, history, descriptors and derived metrics add separate items. `counts.auctions` counts auctions; `counts.events` counts the preserved logical observations, not physical DynamoDB rows. Approximately 1,000 auctions per publisher per full day therefore does not mean 1,000 trace events per day.

Auction partitions use `PUBLISHER#<id>#AUCTIONS#<UTC-date>` with timestamp/auction-ID sort keys. Descriptors declare `storageFormat: auctions`; absent format retains legacy event-row behavior. Readers expand a UTC day's auction records and sort observations by timestamp/event ID before the existing aggregation and canonical hash operations. The stopped legacy test tables remain intact and incomplete; they must not be deleted or treated as a ready dataset. New-layout hash/metric equality remains a verification requirement, not a consequence assumed from the format.

## Configuration and auction lifecycle

- Each auction resolves an immutable native configuration snapshot at initiation. Its version applies to every linked request, offer, candidate and render outcome; a later configuration change does not alter an in-flight auction.
- Snapshots separate `setConfig`, `adUnits`, `bidderSettings` and `requestBids` from application publisher/version/updating-user attribution. History preserves complete before/after snapshots; initial history has no prior snapshot. Current configuration equals the final history state.
- `floorCpm`, `auctionTimeoutMs`, `enabledBidders` and `currency` are **derived product summaries**, not independent native Prebid settings. Private demand and latency distributions are simulation inputs, not configuration parameters.
- Auction initiation/end records retain selected ad unit, resolved timeout and actual cutoff. An auction can finish early when all adapters complete, including adapters returning no bid. Only adapters still outstanding at the cutoff produce timeout outcomes.
- The simulator assumes zero event-loop timer jitter. The deadline timer wins callbacks scheduled at exactly the deadline, as observed in the pinned browser check; those offers are late/excluded. At an earlier all-adapter completion, the final offer at the same cutoff timestamp remains eligible because it precedes completion. Real Prebid may close later than its nominal timeout; eligibility follows the recorded cutoff/order, not a blanket claim that response latency above the configured budget always means rejection.

Stable publisher, auction, ad-unit, request and event identities preserve the causal chain through reconciliation. Each configured opportunity solicits bids even when no offer or win follows.

## Offers, timeouts and wins

| Observation                    | Meaning and counting rule                                                                                                                                                                                      |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request                        | A bid solicitation to a configured adapter for the selected opportunity. Counts once in that bidder's requests.                                                                                                |
| Accepted offer (`bidResponse`) | An offer added to the auction. Acceptance alone does not establish eligibility at the frozen targeting cutoff; a late arrival may still emit this native event.                                                |
| Rejected offer (`bidRejected`) | An observed offer rejected for an actual recorded reason, such as being below the enforced floor. Do not relabel it as an accepted `bidResponse`. Floor equality passes.                                       |
| Late offer                     | An arrival after the recorded auction cutoff. Lateness is a timing property, not an additional offer or an invented native late-rejection event. It cannot change this simulator's frozen candidate/targeting. |
| Adapter done / no bid          | Completion without an offered price is not a response. Completion can allow the auction to end early.                                                                                                          |
| Timeout                        | The request was outstanding at the cutoff. A later observed offer can coexist with this timeout; neither observation cancels or duplicates the other.                                                          |
| Candidate                      | The selected eligible bid at auction completion. It is not yet a rendered win. Original/comparison CPM and bucketed targeting price remain separate.                                                           |
| `bidWon`                       | A win notification in the controlled synthetic ad-server/render flow. Native `bidWon` alone guarantees neither successful rendering nor payment.                                                               |
| Render outcome                 | Explicit synthetic successful rendering accompanies generated wins. Reference checks inspect success/failure separately from `bidWon`. No actual ad-server competition or payment is modeled.                  |

Each logical offered bid counts **once**, whether accepted or rejected. Accepted/rejected counts describe disposition; late counts describe timing and may overlap disposition. A no-bid or still-unanswered request contributes no offered response. Record offer arrival/latency, original and comparison CPM, currency, size, matched/signaled floor, enforcement/skip result, TTL/buffer/expiry, targeting bucket and causal links.

Targeting freezes at auction completion. Expiry uses arrival time plus `(ttl − effective ttlBuffer)` seconds and requires strict unexpired status at targeting. The baseline has fresh bids, positive TTL, no cache reuse, and a fixed brief render delay. The generator's tied-bid order and any stricter requested-size policy are explicit simulation/publisher rules, not claims about universal Prebid core behavior.

## Metric definitions

| Metric                 | Definition                                                                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bidder responses       | Observed offers: accepted plus rejected, counted once per logical offer. **Not** a literal count of native `bidResponse` hooks.                       |
| Response rate          | Observed offers / bidder requests.                                                                                                                    |
| Eligible responses     | Offers eligible under the snapshotted configuration and frozen auction cutoff; late offers cannot win.                                                |
| Late responses         | Observed offers arriving after the recorded cutoff; retain them for investigation but exclude them from candidate/win selection.                      |
| Win rate               | Bidder wins / bidder requests.                                                                                                                        |
| Average latency        | Offer-latency total / observed offers; aggregate using response counts, not an unweighted average of daily means.                                     |
| Eligible opportunities | Opportunities configured to solicit bids, **not** opportunities that received eligible offers. All generated opportunities are eligible.              |
| Filled opportunities   | Generated opportunities with a rendered winning bid; at most one win per opportunity.                                                                 |
| Fill rate              | Filled opportunities / eligible opportunities. Increasing a floor can reduce fill without shrinking its denominator.                                  |
| Average winning CPM    | Winning CPM total / filled opportunities.                                                                                                             |
| Auction wait           | Actual auction end − initiation, in milliseconds. This is a synthetic visitor-experience proxy, not measured LCP, viewability or network performance. |

A zero denominator produces **`null`**, never zero or infinity. No-response and no-fill opportunities remain in the dataset through their requests/lifecycle records.

Generated prices use integer **micro-CPM** units internally: one unit is `0.000001` CPM. Sum those integers before converting:

- Winning CPM total = winning micro-CPM total / `1,000,000`.
- Estimated revenue = winning CPM total / `1,000` = winning micro-CPM total / `1,000,000,000`, in the recorded currency.

Revenue comes from the recorded winning CPM, **not** the rounded/capped `hb_pb` targeting bucket. Bidder win/revenue sums must reconcile with publisher daily totals, and derived totals must reconcile with normalized event/outcome records. Use declared tolerances only when comparing serialized floating-point values; never patch aggregates to create a scenario.

## UTC coverage and complete-period comparisons

The inclusive event bounds are:

- Start: `2026-08-24T03:30:00.000Z` — 24 August 2026, 09:00 IST.
- End/final event: `2026-10-19T03:30:00.000Z` — 19 October 2026, 09:00 IST.

The elapsed span is exactly **56 days**, touching **57 UTC date buckets**. August 24 and October 19 are partial dates; label them and do not extrapolate their totals into full days. Daily metric/tool periods use UTC dates, while metadata retains the exact timestamp bounds.

Relative weekly comparisons use seven complete UTC dates, excluding partial boundary dates:

- Latest complete week: **October 12–18, 2026**.
- Immediately preceding week: **October 5–11, 2026**.

Explain the actual dates used rather than resolving against today's calendar or comparing a partial tail with a full week. Preserve configuration/event links and reconcile boundary records without duplicate counting.
