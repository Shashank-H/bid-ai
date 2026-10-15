# Full-size persisted data verification

## Current status — storage change approved October 15, 2026

The user approved **one uncompressed record per auction** and selected **`bid-publisher-data`** (`TABLE_PREFIX=bid`) for the replacement operation. Target configuration/data keys must be unoccupied and existing identities/memberships compatible before loading. Existing credentials, publisher metadata and conversations must not be replaced.

The earlier event-row load in `bid-test-phase3-20261014193005-b01669` was intentionally stopped; its container `bid-test-phase3-20261014193005-b01669-load` exited 1. **All test tables and partial data must be retained. No deletion, reset, resume or regeneration of that prefix is authorized.** The former overnight handoff is superseded, not a successful load.

The replacement container `bid-phase3-auctions-load` started at **2026-10-15T04:55:14.627169113Z** and finished naturally at **05:54:55.832487371 UTC**, exit **0**, targeting `bid-publisher-data`. Its final `seed-ready` reported **110,288 auctions / 1,925,599 logical events**, both publisher descriptors ready, and **3,579,569 ms** loader duration (59 min 39.569 s). Independent complete read-only reconciliation twice reproduced both original hashes and all persisted metrics. Browser verification also passed; see [BROWSER-VERIFICATION.md](BROWSER-VERIFICATION.md). See [RUNBOOK.md](RUNBOOK.md) for the one-time workflow. No extrapolated speedup is claimed.

## Verified persisted dataset

The original candidate values below are now **verified persisted logical content** for the new target: the loader and two independent full reconciliation passes reproduced them.

| Publisher   | Auctions / physical auction items | Logical events | Verified content hash                                              |
| ----------- | --------------------------------: | -------------: | ------------------------------------------------------------------ |
| publisher-a |                            56,053 |        972,599 | `8bb3ca3cd487b5d0609f601974cf5ef3863b3afed07d6d9d85db3febc955f63f` |
| publisher-b |                            54,235 |        953,000 | `f1025fefb3495203200e649331f40227a87a11ba0e84d11b0b0c45da3d362f5a` |
| **Total**   |                       **110,288** |  **1,925,599** | Per-publisher hashes above                                         |

The new layout stores an auction header, initiation/end and five bidder entries with request, response, completion, timeout, candidate, win and render details as applicable. It retains original normalized event IDs, timestamps and payloads; it is not gzip/compression or arbitrary multi-auction chunks. The reader expands each UTC day's auction items and sorts observations by timestamp/event ID for the existing aggregation/hash order. Legacy event-row reads remain supported.

`counts.auctions` is the number of auctions; `counts.events` remains the number of logical normalized observations. **1,925,599 events no longer means 1,925,599 DynamoDB items.** The 110,288 auction items exclude configuration, history, descriptors and derived daily/bidder metrics. New-layout roundtrip, persisted hashes and complete daily/bidder metric equality passed; they were checked rather than assumed from the intended lossless representation.

## Replacement results

| Check / observation                                                            | Status                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read-only `bid` target and identity preflight                                  | Passed: only two compatible publisher `METADATA` rows, no historical rows; enabled demo identities and memberships unchanged. Loader repeated preflight successfully.                                                                                            |
| Replacement image build and focused layout checks                              | Generator image built; shared/API/generator TypeScript builds passed; 105 existing/shared tests passed; focused DynamoDB integration passed (6.99 s), covering one-row storage, pagination, lossless reads, reconciliation, activation and legacy compatibility. |
| Complete candidate auction roundtrip                                           | Passed for all 110,288 auctions / 1,925,599 logical events in 158,948 ms; both original content hashes unchanged. This check did not establish full persisted readiness.                                                                                         |
| Replacement launch / container                                                 | Completed naturally: `bid-phase3-auctions-load`, `TABLE_PREFIX=bid`; start/end timestamps above.                                                                                                                                                                 |
| Loader exit 0 plus `seed-ready`                                                | Passed: exit 0, both ready descriptors, final event retained in `/tmp/bid-phase3-auctions-load.log`.                                                                                                                                                             |
| Actual per-publisher auction/logical-event counts and hashes                   | Passed: exactly the table above, including both unchanged original hashes.                                                                                                                                                                                       |
| Final `durationMs` and measured throughput                                     | 3,579,569 ms; approximately 30.81 auctions/s and 537.94 logical events/s over total loader duration, including its validation/reconciliation. These are observed whole-operation rates, not write-only performance.                                              |
| Target table item count and `TableSizeBytes`                                   | 110,981 items / 884,185,186 bytes. Exactly 110,288 physical auction items plus 693 other items; detailed breakdown below.                                                                                                                                        |
| Shared DynamoDB volume storage observation                                     | 3,293,048 KiB from `du -sk /home/dynamodblocal/data`; includes retained legacy/test data and SQLite allocation, not per-target storage.                                                                                                                          |
| Independent complete reconciliation and repeat aggregate stability             | Passed twice for both publishers with `write: false`; descriptor/hash/count and all daily/bidder metrics exactly equal across runs and to persisted metrics.                                                                                                     |
| Ready tools, full-span budgets, isolation, empty range and fresh-process reads | Passed for all five registered read-only tools and both trusted publisher identities; details below.                                                                                                                                                             |
| Existing full integration suite                                                | Fresh API test-target build passed; 17/17 integration tests across three files passed in 24.20 s. Only suite-owned UUID test resources were cleaned up.                                                                                                          |
| Fixture and persisted browser suites / visual inspection                       | Passed: 10/10 fixture, 2/2 persisted (16.5 s), desktop/mobile screenshots inspected; separate browser agent evidence in [BROWSER-VERIFICATION.md](BROWSER-VERIFICATION.md).                                                                                      |

The final event and exit status established success, not `candidate-verified` alone. Both publishers activated atomically after configuration readback, persisted reconciliation, scenario checks, derived metrics and private-manifest creation. The loader reported `/output/private-scenario-manifest-bid.json` in the command-only output volume; the private manifest contents were not exposed to API/browser verification.

### Independent persisted checks

Two full reconstruction passes used the host-compiled API repository/aggregator against loopback DynamoDB, explicitly `write: false`. Per-publisher elapsed times were 231,988 / 218,667 ms on pass 1 and 217,597 / 238,103 ms on pass 2 (A / B). Every reconstructed daily record and bidder record matched persisted metrics by canonical equality; the complete second result matched the first. Log: `/tmp/bid-phase3-persisted-check.log`.

A separate fresh process queried publisher-scoped non-auction keys and read table metadata: 570 bidder metrics, 114 daily metrics, two configurations, two dataset descriptors, three history records and the two pre-existing `METADATA` rows total **693**. Subtracting these from 110,981 table items independently confirms **110,288 physical auction items**. A read-only `preflightEmpty` invocation refused the occupied target with `DATA_CONFLICT`; table item count and byte size remained identical before/after. No generator rerun, account update, metrics rewrite, reset or foreign-table cleanup was performed. Log: `/tmp/bid-phase3-storage-check.log`.

The retained old publisher-data table still reports **1,423,723 items / 759,285,326 bytes**, exactly the parent's 04:42:46 UTC baseline. Its tables and partial contents were not modified or resumed.

Trusted `Authorization.resolveUser` supplied each context; no publisher-brand object was fabricated. Ready metadata in both fresh processes had exact observation bounds, the two partial boundary dates and `lastCompleteDate: 2026-10-18`. Empty January ranges returned empty daily, bidder and history arrays. Pre-aborted reads rejected with `AbortError`. This verifies fresh-process persistence/access, not a DynamoDB restart or mid-flight cancellation stress test.

All **five** existing tools were exercised for both publishers over the complete inclusive 57-date span. Comparison used overlapping full-span periods to exercise reference deduplication. All evidence remained scoped to its authorized publisher, with no truncation or increased budgets:

| Tool                  | Publisher A bytes / refs | Publisher B bytes / refs |
| --------------------- | -----------------------: | -----------------------: |
| performance_summary   |              11,747 / 57 |              11,746 / 57 |
| compare_periods       |              12,257 / 57 |              12,255 / 57 |
| bidder_performance    |                3,769 / 5 |                3,732 / 5 |
| current_configuration |               11,668 / 1 |               11,666 / 1 |
| configuration_history |               17,653 / 2 |               11,768 / 1 |

All are below the unchanged 32,768-byte / 100-reference limits. No sixth tool exists or was added.

The requested full integration check used `docker compose -f compose.yaml -f compose.test.yaml build api`, then `docker compose -f compose.yaml -f compose.test.yaml run --rm --no-deps api pnpm test:integration`. Build log: `/tmp/bid-phase3-integration-build.log`; test log: `/tmp/bid-phase3-integration.log`. No live API, DynamoDB or PostgreSQL service was recreated. Warning-only SDK request-duration messages occurred during real reads/loading; no failed read, hash mismatch or nonzero verification exit occurred. No paid/live-model calls were made.

## Historical event-row operation — retained, incomplete

The following observations describe the **stopped legacy-layout test operation**, not the replacement target.

- Prefix: `bid-test-phase3-20261014193005-b01669`.
- Started: `2026-10-14T19:30:14.134652695Z`; intentionally stopped on October 15, 2026.
- Container: `bid-test-phase3-20261014193005-b01669-load`; historical log snapshot: `/tmp/bid-test-phase3-20261014193005-b01669-load.log`.
- Bootstrap logins: `demo.a` / `demo.b`; isolated test passwords: `isolated-browser-password-a` / `isolated-browser-password-b`. These do not establish the existing `bid` account passwords.
- Resource initialization created three uniquely prefixed tables; bootstrap returned `created: 2, unchanged: 0`. No PostgreSQL operation was required. Normal `bid` credentials/conversations were not reset or replaced by this test operation.

### Earlier measured progress and storage

After cancellation, the retained test table held **1,423,723 items / 759,285,326 bytes** at **2026-10-15 04:42:46 UTC** (DynamoDB table metadata). This is incomplete legacy data, not a ready replacement dataset. No test table was deleted or reset.

At **19:35:42 UTC on October 14**, a fresh production-image process read **7,902 persisted events across five query pages** for publisher A on 2026-08-24. The last observed timestamp was 12:58:59.742 UTC; the read took 4,569 ms. Both descriptors remained `loading`.

At approximately 330 seconds elapsed, early throughput was around **24 events/second overall**, or roughly **28 events/second** excluding approximately 50 seconds of candidate verification. Those early extrapolations applied to individual-event writes and are not an estimate for auction-item loading.

The shared DynamoDB directory grew from **124 KiB** before initialization to **11,172 KiB** at 19:35:45 UTC. It contains `shared-local-instance.db` and its journal under `/home/dynamodblocal/data`; it includes other tables and is **not a per-prefix allocation**. At that snapshot DynamoDB reported CPU 8.05%, memory 541 MiB and cumulative block writes 347 MB; the generator reported CPU 1.85% and memory 65.59 MiB. These observations suggested SQLite commit/disk write amplification; no disk profiler established the cause. SDK 2,500 ms warnings alone did not abort the load.

### Checks completed against the incomplete test data

- Real paginated event-row access passed: five pages / 7,902 observations.
- Trusted `Authorization.resolveUser` resolved the two bootstrap memberships in fresh production-image processes. Public metadata returned `status: loading`, `availablePeriod: null`, `lastCompleteDate: null`; scoped daily reads refused with “The publisher dataset is not ready.” No authorization brand was fabricated.
- A pre-aborted repository read rejected with `AbortError`.
- A second invocation refused this occupied prefix during preflight, exit 1: `DATA_CONFLICT: publisher data already exists; one-time seed never replaces data`. It reported `status: unchanged`, `automaticCleanup: false`; log `/tmp/bid-test-phase3-20261014193005-b01669-refusal.log`. The original writer was active at that time, so a simultaneous total-row-count comparison would not establish refusal safety.
- A diagnostic initially used the wrong metadata property (`datasetStatus` instead of `status`); the corrected diagnostic passed. This was not a product failure or source change.

On October 14 the user accepted step 9 as a detached overnight handoff, not persisted/browser success. On October 15 the user approved auction-level items, stopping the old process, targeting `bid-publisher-data`, and explicitly retaining the test tables. The old descriptors/data remain incomplete; do not treat them as a ready browser fixture or rerun generation there.

```sh
# Inspection only; do not restart or clean up this retained operation.
PREFIX=bid-test-phase3-20261014193005-b01669
docker inspect "$PREFIX-load" --format '{{.State.Status}} {{.State.ExitCode}}'
docker logs "$PREFIX-load" 2>&1 | tail -30
```
