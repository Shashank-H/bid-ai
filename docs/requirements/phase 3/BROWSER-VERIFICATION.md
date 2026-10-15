# Persisted browser verification

## Safety and modes

- Default fixture mode creates an owned UUID DynamoDB prefix and fresh owned PostgreSQL chat/checkpoint database; graceful shutdown cleans only those owned resources.
- `PHASE3_TEST_PREFIX=bid-test-phase3-<token>` reads an existing isolated dataset without initializing, bootstrapping, resetting, or deleting its DynamoDB tables.
- Exact `PHASE3_TEST_PREFIX=bid` additionally requires `PHASE3_READ_EXISTING_DATA=true`. Both publisher descriptors must already be ready before the E2E server creates its fresh UUID PostgreSQL database. All external DynamoDB clients reject non-read commands at SDK middleware. Existing accounts, password hashes, publisher data, and main application chats are not modified.
- For `bid`, the browser worker requires explicit `PHASE3_TEST_PASSWORD_A` and `PHASE3_TEST_PASSWORD_B`; it never uses the isolated password fallback. These variables are forwarded only to the browser worker, not the API test server. Traces are disabled for real-account mode. Do not print credentials, full environments, or resolved Compose configuration.
- Existing test logins are `demo.a` and `demo.b`. Fixture passwords remain the isolated test values. Actual-account mode reuses existing passwords without bootstrapping or changing accounts.

The abandoned `bid-test-phase3-20261014193005-b01669` load/tables are preserved. No cleanup/reset command in this verification touches them.

The fake HTTP model invokes real read-only tools and derives amounts, floor values, late-offer shares, and citations from authorized tool JSON. It imports no generator scenarios and makes no paid/live-model calls.

## Commands

Build only test images; do not recreate main API/web or storage services:

```sh
docker compose -f compose.yaml -f compose.test.yaml -f compose.e2e.yaml \
  build api web agent-test-web

# Separate unchanged fixture suite:
PHASE3_TEST_PREFIX= PHASE3_READ_EXISTING_DATA= \
  docker compose -f compose.yaml -f compose.test.yaml -f compose.e2e.yaml \
  up -d --no-deps agent-test-api agent-test-web
PHASE3_TEST_PREFIX= PHASE3_READ_EXISTING_DATA= \
  docker compose -f compose.yaml -f compose.test.yaml -f compose.e2e.yaml \
  run --rm --no-deps web pnpm exec playwright test tests/e2e/agent.spec.ts
```

For actual-account persisted verification, first require loader container `bid-phase3-auctions-load` to exit **0**, emit `seed-ready`, and expose ready descriptors for **both** publishers. Then set `PHASE3_TEST_PREFIX=bid`, `PHASE3_READ_EXISTING_DATA=true`, and privately supply the two existing passwords as `PHASE3_TEST_PASSWORD_A/B` in child-process environment only:

```sh
docker compose -f compose.yaml -f compose.test.yaml -f compose.e2e.yaml \
  up -d --no-deps agent-test-api agent-test-web
docker compose -f compose.yaml -f compose.test.yaml -f compose.e2e.yaml \
  run --rm --no-deps -v /tmp/bid-phase3-browser-results:/workspace/test-results \
  web pnpm exec playwright test tests/e2e/phase3.spec.ts
docker compose -f compose.yaml -f compose.test.yaml -f compose.e2e.yaml \
  stop agent-test-web agent-test-api
```

Run named suites separately. Use `pnpm exec playwright test <spec>`: the earlier `pnpm test:e2e -- <spec>` invocation selected all specs instead of filtering. A subsequent `--list` command confirmed the direct persisted invocation selects exactly two tests in one file.

## Checks executed

On 2026-10-15:

- Strict focused TypeScript passed:
  `node node_modules/typescript/bin/tsc --noEmit --strict --allowImportingTsExtensions --module NodeNext --moduleResolution NodeNext --target ES2023 --skipLibCheck tests/support/e2e-server.ts tests/support/model-server.ts tests/e2e/phase3.spec.ts`.
- Targeted Prettier checks passed for the three changed files.
- No-network Node/SDK checks passed: prefix opt-in, both ready-state reads, missing/loading fail-fast, document Get permitted, Put/Delete rejected before transport. Separate checks confirmed both password requirements, traces disabled for `bid`, and Compose forwarding confined to the browser worker. The latter used `--env-file /dev/null --no-env-resolution` and fake sentinel values, never actual credentials.
- Test-image rebuild passed: API test, web test, and E2E web runtime images.
- Initial fixture browser run passed **10 tests, 2 persisted cases skipped**, in **1.1 minutes**. After the test-model formatting correction below, the final explicit fixture command `pnpm exec playwright test tests/e2e/agent.spec.ts tests/e2e/foundation.spec.ts` passed **10/10 in 41.9 seconds**, covering the existing five agent and five foundation checks. Owned E2E services stopped normally afterward. Final command output: `/tmp/phase3-fixture-browser-final.log`.
- Fixture desktop and 375-pixel mobile screenshots were rendered and inspected. The three-column desktop layout, mobile disclosures, multiline composer, citations, and synthetic/non-paid evidence label were visible without horizontal overflow. Artifacts are under `/tmp/bid-fixture-browser-results`.
- Earlier direct fake-model HTTP checks passed three/four streamed tool calls and tool-derived amounts/floor values/citations using non-seed sample JSON.

The initial 2026-10-14 fixture startup had failed before browser execution on the existing DynamoDB initialization deadline (`AbortError` with 2,500-ms request-timeout warnings). The new successful fixture run supersedes that failed attempt; no tests or infrastructure limits were weakened.

## Persisted result

**Passed: 2/2 browser cases in 16.5 seconds**, using the existing `bid` dataset/accounts and a fresh owned PostgreSQL database. Exact invocation: `pnpm exec playwright test tests/e2e/phase3.spec.ts` inside the isolated web test worker. Existing passwords were privately parsed with Node `process.loadEnvFile('.env')` and supplied only in child-process environment; values were never printed or changed.

Readiness was established before execution:

- `docker wait bid-phase3-auctions-load` returned **0**.
- Container exited at **2026-10-15T05:54:55.832Z** with a `seed-ready` log: **110,288 auctions / 1,925,599 normalized events**, stored as uncompressed auction rows.
- Independent read-only repository calls confirmed **both** publisher descriptors ready.

Browser assertions verified:

- Exact observation bounds `2026-08-24T03:30:00.000Z` through `2026-10-19T03:30:00.000Z`, both partial boundary dates, and latest complete date `2026-10-18`.
- Actual tool-derived A comparison **$9.72 → $8.06**, recorded floor **$0.80 → $1.40**, native configuration history, citations, saved-chat reload, and denial of A's conversation to B.
- Five explicitly typed bidder-period evidence references for B, the Beacon aggregate's dates/bidder identity, synthetic/non-paid labeling, and no horizontal overflow at **375 pixels**.

The first persisted attempt correctly failed `EVIDENCE_INVALID`: the new fake model generated duplicate Observation headings and omitted a separate required section. Only its answer formatting was corrected to exactly Observation/Hypothesis/Recommendation; production validation and browser assertions were not weakened. Direct fake-model HTTP checks for both branches then passed the production `validateAnswer` function before the successful browser rerun. Initial failure log: `/tmp/phase3-persisted-browser-initial-failed.log`; final successful log: `/tmp/phase3-persisted-browser.log`.

Persisted desktop and mobile screenshots were rendered and inspected:

- `/tmp/bid-phase3-browser-results/phase3-persisted-floor-inv-09708-verage-reload-and-isolation-chromium/phase3-floor-desktop.png`
- `/tmp/bid-phase3-browser-results/phase3-persisted-bidder-in-32041-egates-on-a-narrow-viewport-chromium/phase3-bidder-mobile.png`

The desktop showed cited numeric/configuration results and three completed tools; the narrow layout showed the opened bidder aggregate with its bidder and period. Scrollable panels retain access to longer evidence. This is a scoped visual/browser check, not a comprehensive accessibility audit or live-model evaluation.

Owned E2E services stopped normally and their owned PostgreSQL database was dropped. Main API/web/DynamoDB/PostgreSQL containers were not recreated or stopped; observed uptimes remained unchanged. The persisted/abandoned DynamoDB prefixes and existing accounts/chats were not altered by browser verification.
