# Configuration management verification

## Delivered scope

One mutable shared draft per publisher; Save draft does not publish. Human Publish atomically creates an immutable UTC-timestamped version and makes it current. The publishing person is the author, with the agent as coauthor when it contributed. Published versions have individual URLs; restoring a version replaces the shared draft after confirmation, not published history.

Structured and JSON editing share validation. Agent tools read/compare configurations, propose an exact draft update for explicit approval, and provide links/requested navigation. Approval cannot publish. Backtesting, live-site deployment, multiple drafts and a generalized approval ledger are not included.

## Data safety

Runtime state/publications/operation receipts use separate keys in the existing publisher table. Original `CONFIGURATION`, `HISTORY#`, dataset descriptors, auction records and historical aggregates remain seed-owned. Reconciliation continues reading original seed records. Fixture stores are isolated per application and ephemeral; database mode is durable and never falls back to fixtures.

## Checks

- Shared/API/web TypeScript and frontend production build passed during implementation.
- Focused storage/service checks passed for concurrency, publish retries, publishing-human authorship, agent approval affecting only the draft, replay protection and restore attribution.
- Initial browser checks passed for editable invalid numeric inputs and cancelled Back/Forward navigation.
- Coordinated Docker build/typecheck passed; 104 existing regression checks and 28 integration checks passed, including all seven new configuration integration cases.
- Final isolated Chromium run: **15/15 passed** (eight existing agent tests, three configuration-agent tests, four manual configuration tests).
- Initial browser failures were stale accessible selectors: tests now assert the actual evidence trigger/dialog, keyboard focus restoration and JSON textbox. Product behavior assertions remain intact.
- All 40 changed files passed Prettier; `git diff --check` passed.
- No existing demo/historical dataset or baseline service was modified. Isolated E2E services were stopped after verification.

## Commands and final results

```sh
docker compose -f compose.yaml -f compose.test.yaml -f compose.e2e.yaml build api web agent-test-web
docker compose -f compose.yaml -f compose.test.yaml -f compose.e2e.yaml run --rm --no-deps api sh -lc 'pnpm build && pnpm typecheck && pnpm test && pnpm test:integration'

# Explicitly exclude external historical prefixes from mutable browser tests.
PHASE3_TEST_PREFIX= PHASE3_READ_EXISTING_DATA= docker compose -f compose.yaml -f compose.test.yaml -f compose.e2e.yaml up -d --no-deps --force-recreate --wait agent-test-api agent-test-web
PHASE3_TEST_PREFIX= PHASE3_READ_EXISTING_DATA= docker compose -f compose.yaml -f compose.test.yaml -f compose.e2e.yaml run --rm --no-deps web pnpm exec playwright test tests/e2e/configurations.spec.ts tests/e2e/configuration-agent.spec.ts tests/e2e/agent.spec.ts
PHASE3_TEST_PREFIX= PHASE3_READ_EXISTING_DATA= docker compose -f compose.yaml -f compose.test.yaml -f compose.e2e.yaml stop agent-test-web agent-test-api
```

API images were rebuilt after the final evidence-budget correction. The browser-test image was rebuilt after selector corrections; the clean rerun passed in 1.4 minutes. Logs are local verification artifacts in `/tmp/configuration-checks.log` and `/tmp/configuration-e2e-rerun.log` (not required runtime assets).

### Core coverage

- `tests/integration/configurations.test.ts`: seven isolated DynamoDB cases cover singleton drafts, race/conflict handling, atomic/idempotent publication, recreated-repository durability, publishing-human attribution, retained/reset agent credit, approval/rejection/replay, tenant isolation and pagination. Raw seed configuration/history/dataset/auction records remain byte-equivalent; reconciliation still matches. A 50-reference proposal regression verifies existing investigation evidence is not duplicated after committing the proposal.
- `tests/e2e/configurations.spec.ts`: four cases cover saves, timestamped immutable detail pages, restore, form/JSON validation, guarded browser navigation, authorization and isolation.
- `tests/e2e/configuration-agent.spec.ts`: three cases cover dedicated draft approval, author/coauthor on human Publish, rejection/stale cards, requested navigation, preserved chat and no replayed navigation.
- Existing regression/integration and eight investigation-browser cases remain green.

### Loading the feature locally

Verification does not redeploy the user's running demo. Rebuild/restart its API and web when ready: `docker compose build api web && docker compose up -d --no-deps api web`. No reseed or database migration is required.

## Optional per-slot floor overrides

Added after the initial configuration-management verification:

- Each ad-unit form has an optional **Slot floor override (USD CPM)**. Blank inherits the global banner floor; zero is an explicit override. Clearing the last override returns the document to the original legacy floor shape.
- Native rules use `setConfig.floors.data.schema.fields: ["adUnitCode", "mediaType"]`, `values["*|banner"]` for the global floor and `values["<slot-code>|banner"]` for overrides. This avoids native Prebid's precedence rule that otherwise ignores ad-unit floor objects when package-level floors exist.
- Global enablement, skip rate and enforcement still govern all slots. Derived `settings.floorCpm` reports the global floor; agent instructions explain how to edit one slot without changing the others. Stored historical snapshots without overrides remain unchanged.
- Shared/API/web/data-script typechecks passed. The configuration and auction integration suites passed **11/11**, including three new schema, inheritance/zero/rename and simulation/aggregation regressions. Tests used isolated tables; the first host attempt used a container-only DNS endpoint, corrected to `DYNAMODB_ENDPOINT=http://127.0.0.1:8000` for the passing run.
- Production API/web Docker build and deployment passed; health, readiness and draft-page routes returned HTTP 200. Databases and existing configuration records were not replaced or reseeded.
- No new browser E2E suite was added or rerun for this increment; the offline native-browser reference harness was not rerun. Logs: `/tmp/slot-floor-checks.log`, `/tmp/slot-floor-deploy.log`.

## Slot override accordion

- Slot code, sizes and bidder selection remain visible in their original fieldsets. Only the optional floor override is inside a collapsed **Slot overrides** accordion; its summary indicates inheritance or the configured override. Closing it never clears values.
- The broader collapsible-slot layout and added size/placement controls were reverted after clarification. No Add/Remove slot controls are included: configuration does not provision publisher page placements. Timeouts, currency and other auction-wide settings remain global.
- Web typecheck, formatting, whitespace and production Docker API/web builds passed for this correction; both deployed services are healthy. No new E2E tests were added or run, and no database services/data were changed. Deployment log: `/tmp/slot-override-accordion-deploy.log`.

## Limitations

Synthetic observations cannot prove a configuration improves future performance. Publishing explicitly warns that outcomes are unverified and only stored configuration changes. No live model smoke test or backtesting was run for this feature.
