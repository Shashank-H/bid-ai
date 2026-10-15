# Phase 3 — Historical data runbook

## Current operation

On October 15, 2026 the user approved **one uncompressed DynamoDB item per auction**, retaining all five bidders' detailed observations, instead of one item per normalized event. The replacement target is **`bid-publisher-data`** (`TABLE_PREFIX=bid`), subject to preflight. The replacement loader `bid-phase3-auctions-load` completed successfully at **2026-10-15 05:54:55 UTC**, with exit 0 and `seed-ready`, after **59 minutes 39.6 seconds**. Both publisher datasets are ready: **110,288 auction items / 1,925,599 logical events**, with the original content hashes. Fixture and persisted browser suites passed; see [DATA-VERIFICATION.md](DATA-VERIFICATION.md) and [BROWSER-VERIFICATION.md](BROWSER-VERIFICATION.md) for detailed verification.

The former event-row load was intentionally stopped. Its container is `bid-test-phase3-20261014193005-b01669-load` (exited 1); that is cancellation, not successful completion. **Retain all `bid-test-phase3-20261014193005-b01669-*` tables and partial data. Do not delete, reset, resume or regenerate that prefix.** The earlier step 9 acceptance was a background handoff, not passed verification.

## Storage and volume

- Approximately 1,000 **auctions per publisher per full day**, not 1,000 event records.
- Verified loaded totals: **110,288 auction items** (A: 56,053; B: 54,235), containing **1,925,599 logical normalized events**. Configuration, history, descriptors and derived metric items are additional.
- One auction item contains its configuration/version and timing header, initiation/end observations, and bidder request/response/completion/timeout/candidate/win/render details. Original event identities, timestamps and payloads are retained. This is native structured JSON, **not compression or arbitrary multi-auction chunks**.
- Auction keys use `PK=PUBLISHER#<id>#AUCTIONS#<UTC-date>` and timestamp/auction-ID sort keys. `storageFormat: auctions` distinguishes this layout; absent format retains legacy event-row reads. Readers expand and sort observations by timestamp/event ID for the existing aggregation and content-hash rules.
- `counts.auctions` counts auctions; `counts.events` counts logical trace events, not DynamoDB items. Read the detailed rules in [EVENT-AND-METRIC-SEMANTICS.md](EVENT-AND-METRIC-SEMANTICS.md).

## One-time generation

**Do not run the launch command until the replacement implementation/build and target preflight have passed.** Preflight must confirm that both publishers' configuration, history, dataset, metrics and event/auction partitions are unoccupied and that unchanged `demo-user-a` / `demo-user-b` identities and memberships are compatible. Existing publisher `METADATA`, credentials, chats and unrelated records are preserved. A conflict stops the operation; it is not permission to clear a table.

Existing logins are `demo.a` and `demo.b`, not email aliases. Bootstrap is an explicit prerequisite only if the expected identities are absent; never overwrite existing accounts or passwords. Resource initialization is non-destructive and is not a reset.

The dedicated Compose service is `data-generator`; its command is `data:generate`, not `load`. The replacement was launched once using the following workflow. **Do not repeat generation against the now-occupied `bid` dataset:**

```sh
docker compose --profile data build api web data-generator
docker compose up -d --wait dynamodb
# Only if resources are absent; existing compatible resources are retained:
docker compose run --rm --no-deps -e TABLE_PREFIX=bid \
  api node dist/commands/cli.js db:init
# After the implementation/build, identity and empty-data checks pass; execute once:
docker compose --profile data run -d --no-deps --name bid-phase3-auctions-load \
  -e TABLE_PREFIX=bid data-generator data:generate
```

Only optional `--seed <value>` is accepted by the generator. Offline candidate/scenario/sensitivity checks do not write the database:

```sh
docker compose --profile data run --rm --no-deps data-generator data:verify
```

Configurations and immutable attributed history are stored and read back before their effective snapshots drive persisted auctions. Generation and reconciliation work by UTC date, not by holding the full corpus in memory. DynamoDB batches contain at most 25 items; the new layout batches auction items rather than individual events. Fewer writes do not establish a measured loading duration or a proportional speedup.

The command-only `phase3-output` volume holds `/output/private-scenario-manifest-<prefix>.json`. The manifest is written after persisted reconciliation/scenario checks and before activation. It is not mounted into API/web or used by runtime answers; see [BUILD-BOUNDARY.md](BUILD-BOUNDARY.md).

## Observe completion

For the replacement container, once launched:

```sh
LOAD=bid-phase3-auctions-load
docker inspect "$LOAD" --format '{{.State.Status}} {{.State.ExitCode}}'
docker logs "$LOAD" 2>&1 | tail -30
# Optional: Ctrl-C stops following logs, not the detached container.
docker logs -f "$LOAD"
```

Keep the laptop awake and Docker running. The service has restart policy `no`; interruption does not resume automatically. SDK request-timeout warnings alone are not command failures.

Success requires **exit code 0 and `seed-ready`**. The loader rereads stored configurations, reconciles the expanded observations, checks hashes/counts/metrics and scenarios, writes derived records and the private manifest, then atomically activates both publishers. `candidate-verified` or a manifest alone is not proof that persisted data is ready.

## Failure or interruption

Inspect the exit status, `seed-failed` phase and dataset status. Before claims, failures leave dataset content unchanged; after claims, interruption can leave unpublished `loading` data. Read tools refuse incomplete data and never fall back to fixtures.

There is **no resume, replacement, reset or automatic cleanup**. Do not rerun generation on an occupied prefix, remove volumes, alter shared backend settings or overwrite credentials to recover. Preserve logs and data for deliberate review. In particular, the user requires retaining the stopped test tables. `data:reconcile` rebuilds derived records for ready datasets; it cannot complete or activate an interrupted seed.

## After `seed-ready`

Record actual counts, hashes, `durationMs` and storage in [DATA-VERIFICATION.md](DATA-VERIFICATION.md). Independently rerun reconciliation; it verifies configuration/auction observations before replacing aggregates by stable keys, not incrementing totals:

```sh
docker compose build api
docker compose run --rm --no-deps -e TABLE_PREFIX=bid \
  api node dist/commands/cli.js data:reconcile
```

Fixture and persisted browser checks passed. See the verification record for independent complete reconciliation, full-span tool budgets/isolation, empty ready-range behavior and fresh-process checks. Follow [BROWSER-VERIFICATION.md](BROWSER-VERIFICATION.md); do not aim a fixture harness's cleanup at retained or application tables.

The target is now ready. To select it in the main application, build current API/web images and recreate only those services:

```sh
docker compose build api web
TABLE_PREFIX=bid REPOSITORY_MODE=database \
  docker compose up -d --no-deps api web
```

Verification left the main application in fixture mode. These overrides do not edit `.env`, seed chats or change credentials; set the same values in private `.env` if they should persist across future recreations. Normal startup remains non-generating. Before readiness, scoped metadata reports no available period and read tools refuse incomplete datasets.

## Investigation checks

The synthetic client-side banner profile uses pinned Prebid.js **11.41.0**, two publishers, five mock bidders each (`atlas`, `beacon`, `cedar`, `delta`, `ember`) and three ad units each. It is not a live SSP/ad-server integration. All monetary results are **Estimated revenue**, not payments; see the [native configuration profile](PREBID-CONFIGURATION.md).

Coverage is exactly August 24, 2026, 09:00 IST through October 19, 2026, 09:00 IST (`2026-08-24T03:30:00.000Z`–`2026-10-19T03:30:00.000Z`, inclusive): 56 elapsed days and **57 UTC date buckets**, with both boundary dates partial. Relative complete-week comparisons use October 12–18 versus October 5–11.

| Login    | Suggested investigation                                                                                   | Controlled pattern to investigate                                                                            |
| -------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `demo.a` | Compare September 14–20 with September 7–13; inspect history, fill and winning CPM.                       | Banner floor rises $0.80→$1.40; timeout stays 1,000 ms. Estimated revenue drops with reduced fill.           |
| `demo.b` | Compare bidder performance September 14–27 with August 31–September 13; inspect late offers and settings. | Beacon latency worsens against the unchanged 900 ms timeout; floor stays $0.60. Ember is consistently weak.  |
| `demo.b` | Compare October 5–11 and October 12–18 separately with September 28–October 4.                            | Lower traffic accompanies stronger fill/winning CPM and higher estimated revenue, without a settings change. |

These are synthetic scenario checks, not prewritten findings for the agent. Private scenarios stay outside serving images. No settings editor, agent mutation, seeded conversation, chart or live-model verification is included.
