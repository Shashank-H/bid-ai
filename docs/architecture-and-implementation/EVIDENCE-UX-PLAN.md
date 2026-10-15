# Implementation plan — dashboard-first investigations and meaningful evidence

## Context

Today, `ToolResults.tsx` presents raw tool JSON and evidence entries containing IDs, source names and timestamps. Analytics tools calculate useful results but produce separate record references; a comparison has no first-class comparison evidence. Citation validation checks known IDs and answer structure, not the truth of a cited claim.

The agreed replacement is a main analytics dashboard with conversation history/messages in a right-side chat panel. Evidence describes **what was examined**, shows the exact filters, and offers **Show in dashboard**. Neither agent activity nor citation navigation automatically changes the dashboard.

Requirements source: `docs/requirements/Full-Requirements.md`, particularly supporting charts/metrics, publisher isolation, estimated-revenue labeling and correlation-versus-causation. Preserve metric definitions in `docs/requirements/phase 3/EVENT-AND-METRIC-SEMANTICS.md`. This is cross-phase workspace/evidence documentation, not a new numbered phase.

## Agreed scope

- Publisher performance, period comparisons, and bidder breakdowns.
- Dashboard filters, charts, metric summaries, and all matching **daily publisher/bidder metric records**, paginated in a table. These are the records the existing analytics tools actually query; label their granularity explicitly. An auction/event-level explorer is not part of this first implementation.
- Three-column desktop workspace: a narrow left navigation rail, main dashboard, and an agent panel collapsible to the right. Opening the agent panel starts a new chat; existing conversations are accessible through a hamburger history menu inside that panel. Preserve streaming, cancellation and restored conversations.
- Replace user-facing evidence-reference lists with readable investigation summaries and saved filters.
- Historical analytics is immutable: no snapshots, dataset versioning, or changed-data warnings.
- Configuration dashboard views, change markers, mutable configuration handling and configuration editing are deferred. Existing read-only configuration tools remain functional; do not invent dashboard links for unsupported views.

## Approach

### 1. One typed dashboard-view contract

Add shared schemas for a supported analytics view: publisher-performance or bidder-performance, metric, inclusive UTC period, optional comparison period, and explicit bidder selection where applicable. Use an enumerated metric allowlist, not arbitrary query expressions. Publisher identity comes from server authorization, never a trusted client filter.

The view descriptor is reused by dashboard requests and evidence links. A comparison saves both periods; a bidder investigation saves the exact bidder selection. Metric changes affect visualization, not the underlying filter scope unless documented. Summary cards and records use the same applied periods/bidders as the chart.

Evidence remains backend-created and citation-addressable. Extend the existing evidence contract with an optional structured analytics payload for backward compatibility: readable title/summary, saved dashboard view, measured result/coverage. Generate one meaningful item for a publisher summary/comparison and appropriately scoped items for bidder results, not one entry per underlying daily row. Keep legacy/configuration reference variants readable internally. Preserve source traceability without duplicating all records into model context.

Generate summaries deterministically from existing calculations: describe what was examined and supported measurements; do not generate causal claims or add another LLM call. Evidence IDs are internal citation links only: assign simple turn-local IDs such as `e1`, unique across all tool results in that turn, and resolve UI links using turn ID + evidence ID. Normalize IDs at the graph/tool-result boundary before model exposure, streaming and persistence, so every consumer sees the same mapping. Do not derive global IDs from publisher/filter scope or assign an evidence ID to every source record. Preserve legacy IDs when restoring existing turns.

### 2. Shared calculation and query path

Extract the existing publisher and bidder aggregation logic into reusable domain functions. Both agent tools and a new authenticated analytics endpoint use these functions and the same `AnalyticsRepository`; do not average daily rates or latency means incorrectly and do not recompute totals from a paginated table page.

Return bounded series/summary data plus a separately paginated records response. Existing repository limits are 90 daily rows and 450 bidder rows, making bounded reads plus deterministic application pagination adequate initially. Enforce these bounds at the request schema, use stable date/bidder ordering, and validate page parameters. No raw-event scan or database migration is needed.

Provide the service in both existing runtime modes: database and fixtures. Preserve ready-gating, authorization ownership validation, abort handling and no database-to-fixture fallback. The dashboard must function without a model call.

Coverage must identify absent/partial dates. Zero-denominator metrics remain null, percentages and percentage-point changes are distinguished, all money is labeled Estimated revenue, and daily gaps must not be plotted as observed zeroes. Initial defaults use dataset coverage and complete UTC dates, not today's calendar.

### 3. Dashboard-first workspace

Introduce a workspace shell owning applied dashboard view state, outside the chat streaming lifecycle. Desktop has three columns: a narrow left navigation rail, a flexible main dashboard, and an agent panel on the right with a practical minimum width and a collapse-to-right action. The dashboard expands when the agent panel is closed. Keep navigation separate from conversation history; history lives in a hamburger menu within the agent panel, not a fourth permanent column.

Every closed-to-open agent-panel transition shows a fresh, unsent chat; do not create an empty server conversation until the user sends a message. A user can explicitly restore an existing conversation from the hamburger history menu after opening. Closing/reopening must not delete saved conversations or clear dashboard filters. Per approval notes, browser streaming may stop when the panel closes, but in-flight backend work must complete and persist in the correct conversation; disconnect is not explicit cancellation. Preserve explicit cancellation, authorization expiry, logout, budget and shutdown controls.

On narrow screens, retain compact navigation and show the agent as a right-side full-height sheet rather than squeezing three columns. Opening starts a new chat with the same history menu; closing returns to the dashboard.

Dashboard includes explicit filter controls, metric cards, publisher trend/comparison chart, bidder comparison/trend view, and a paginated matching-records table with units, dates and partial-day status. Distinguish previous/current periods clearly; show actual date ranges when aligning comparisons by day index.

Per approval notes, use Recharts (rather than uPlot) for themed time-series/comparison lines and bidder bars. Use its responsive container and chart primitives rather than implementing custom plotting or lifecycle machinery; keep visual styling consistent with existing typography, borders and accent. Include readable units, legends and pointer inspection, plus keyboard-accessible selected-point details and the accessible records table because canvas charts alone are not an accessible equivalent. Add only Recharts; no panel-resizing dependency is required. Include loading, empty, unavailable, error and retry states; ignore/abort stale fetches when filters change.

### 4. Evidence interaction

Render concise evidence cards near their answer, for example:

> **Estimated revenue comparison**
>
> Compared observed estimated revenue across two seven-day periods.
>
> **Filters:** Oct 1–7 vs Oct 8–14 · Estimated revenue
>
> **Show in dashboard**

- Clicking an inline citation focuses its summary card only.
- Clicking **Show in dashboard** atomically applies the saved view and identifies the selected evidence. On mobile it closes the agent sheet to reveal the dashboard; the conversation remains available in history. The next explicit agent-panel opening starts a new chat as specified above.
- Streaming tool results, new answers, and conversation switches do not change applied dashboard filters.
- Manual filter changes leave evidence mode; the original card remains available to restore its view.
- Clear selected-evidence context when its conversation is no longer displayed without resetting the user's dashboard filters.
- Keep technical tool input/output under a secondary diagnostics disclosure, not as primary evidence.
- Per code-review feedback, do not reconstruct evidence summaries or dashboard views in the frontend. Legacy results and configuration tools display their saved backend summary without a dashboard action. New structured analytics evidence provides the summary and exact view directly.

### 5. Agent and persistence compatibility

Update prompt guidance to cite the new investigation evidence IDs and distinguish observations from hypotheses. Retain known-ID and publisher checks; do not describe this as semantic verification of every AI claim.

Check graph deduplication and dispatch output limits against the new compact payload. Shared schemas must accept existing saved results as well as new ones through tool events, completed turns, persisted conversations and restoration. Prefer additive JSON contract evolution; no conversation migration unless inspection proves unavoidable. Do not add an unused claim graph or repurpose the currently empty findings array just to support UI navigation.

## Files to modify

**Shared contracts**

- New `packages/shared/src/dashboard.ts`: view/query/response schemas and metric allowlist.
- `packages/shared/src/protocol.ts`: backward-compatible structured analytics evidence.
- `packages/shared/src/index.ts`: exports.
- `packages/shared/src/analytics.ts` and `conversation.ts` only if existing result/restore schemas need adjustment.

**API**

- `apps/api/src/domain/analytics.ts`: reusable calculations and meaningful evidence creation.
- New `apps/api/src/domain/dashboard.ts`: shared dashboard querying, series and record pagination.
- `apps/api/src/domain/interfaces.ts`, `runtime-data.ts`: dashboard service wiring in database/fixture modes.
- New `apps/api/src/routes/analytics.ts`; `apps/api/src/app.ts` and `server.ts`: authenticated route registration.
- `apps/api/src/agent/prompt.ts`, `evidence.ts`, `graph.ts`, and `tools/dispatch.ts` only where evidence contract assumptions need updating.
- `apps/api/src/db/conversations.ts` only if saved-result compatibility needs normalization.

**Web**

- New `apps/web/src/Workspace.tsx` and dashboard components: shell, filters, charts, records and view state.
- `apps/web/src/App.tsx`: mount workspace after login.
- `apps/web/src/Chat.tsx`: right-panel layout, conversation navigation, evidence callback.
- `apps/web/src/ToolResults.tsx`: summary cards, citation focus, explicit dashboard action, legacy adapter.
- `apps/web/src/api.ts`, `Icon.tsx`, `styles.css`: analytics access, three-column navigation/agent-sheet layout and existing visual system integration.
- `apps/web/package.json` and `pnpm-lock.yaml`: add Recharts during implementation.

**Verification/docs**

- Focused scenario in `tests/e2e/` using existing deterministic model-server support.
- Existing integration coverage in `tests/integration/phase1.test.ts` / `phase3-auctions.test.ts` if needed for authorization and analytics parity.
- `README.md`: concise implemented-capability update and link to this document; no phase progress narrative.

## Reuse

- `Analytics`, `ratio`, publisher totals and response-weighted bidder aggregation in `apps/api/src/domain/analytics.ts`.
- `AnalyticsRepository.daily/bidders` and existing bounded, publisher-scoped `PublisherDataRepository` reads.
- `createRuntimeData` and `FixtureRepository` rather than a second data-access mode.
- `Authorization.resolve` and existing Fastify route/error patterns.
- Existing shared period/metric/result/dataset schemas and authentication metadata.
- `CitedAnswer`, turn-scoped citation anchors, existing conversation persistence and streaming handling.
- Existing React/CSS visual language, API helper, Playwright setup and deterministic model server.

## Steps

- [x] Define shared saved-view, dashboard-response and additive analytics-evidence contracts.
- [x] Extract/reuse deterministic aggregation; build bounded dashboard query/pagination service in both runtime modes.
- [x] Register authenticated endpoints and verify publisher isolation and input limits.
- [x] Generate compact summary/comparison/bidder evidence from the same calculations; adapt prompt and contract checks.
- [x] Build the three-column desktop shell, left navigation rail, right-collapsible agent panel and mobile agent sheet; opening the panel starts a fresh chat, with existing conversations restored through its hamburger history menu.
- [x] Add Recharts, filters, summary metrics, accessible chart inspection and matching-records table; verify resize and teardown.
- [x] Wire explicit evidence-to-dashboard actions and legacy saved-result rendering; remove primary metadata-entry lists.
- [ ] Verify core investigation flows, update concise README documentation and record results here.

## Verification

After approval and implementation:

1. Run `pnpm typecheck`, `pnpm build`, and focused formatting checks on changed files.
2. Exercise the primary flow with deterministic E2E coverage: ask for a comparison, confirm no dashboard mutation during streaming, inspect evidence summary, click Show in dashboard, and verify exact filters, chart totals and matching rows. Repeat for one bidder and restored chat history.
3. Validate direct API publisher isolation, invalid/unsupported filters, pagination completeness/no duplicate rows, fixture/database operation and unavailable-data behavior using focused existing integration patterns. Verify period totals do not change between table pages.
4. Compare dashboard and tool results for identical periods/bidders: estimated revenue, weighted CPM/latency, rates, null denominators and coverage must agree.
5. Manually check comparison periods, partial/missing dates, previous-period zero revenue, empty results, rapid filter changes, errors/retry and keyboard chart/table access.
6. Check the three-column desktop layout and dashboard expansion on right-panel collapse. Verify every agent-panel opening starts a fresh unsent chat without creating an empty stored conversation, hamburger history restores old chats, and collapse/reopen during streaming does not lose or misroute the previous turn. Check mobile agent-sheet navigation, cancellation, old conversation rendering and unsupported configuration evidence without misleading buttons.
7. Verify Recharts resizing when the agent panel opens/closes, clean teardown on unmount, tooltips/units, keyboard-accessible data inspection and no plotted zeroes for missing data.

E2E coverage is warranted because this changes core evidence navigation and data access, not just styling.

## Implementation and verification results — 2026-10-15

- Synced `main` to `a76fc98` (persistent dark theme). Reconciled the workspace, agent sheet, evidence cards, filters, chart palette and tooltip surfaces with the shared light/dark theme tokens. The authenticated theme switch now lives in the navigation rail.
- Used Recharts per approval notes. Closing the panel detaches browser streaming; accepted backend work completes and persists. Explicit cancellation and execution guards remain intact.
- Added publisher-scoped `/api/analytics/query`, shared saved views, bounded series/records, table pagination, missing/partial-date coverage and deterministic summary/comparison/bidder evidence. The dashboard table contains daily aggregates, not raw auction events.
- Full build and shared/API/web typechecks passed. Focused Prettier checks and `git diff --check` passed.
- **13 browser tests passed** in isolated deterministic-model services (`agent.spec.ts` and `foundation.spec.ts`): user-triggered dashboard views, unchanged filters during agent work, citation focus, history restoration, fresh unsaved chats, backend completion after panel close, explicit cancellation, publisher isolation, mobile sizing/keyboard use, bidder pagination, light/dark persistence and browser privacy checks.
- **13 integration tests passed**: `dashboard.test.ts` (4), `phase3-auctions.test.ts` (1), and `phase1.test.ts` (8). Database-backed coverage includes loading-state rejection, publisher isolation, weighted bidder/tool parity and consistent partial-day coverage; fixture/API checks cover input bounds, pagination and missing-date gaps.
- Reviewed desktop light/dark screenshots and the mobile evidence-dashboard screenshot. Chart resizing and three-column bounds are covered by browser checks.
- Fixed review findings in polling (preserve loaded older history; use authoritative backend status after transport loss), missing-observation count cards, bidder partial-day evidence and observed timestamps. Escape closes the history menu even while its trigger retains keyboard focus.
- Remaining nonblocking build warnings: Recharts makes the main JS chunk exceed Vite's 500 kB advisory; existing Zod annotation and Fastify deprecation warnings remain. No unit tests or full historical-dataset-specific browser suite were run; configuration dashboard/mutable-data handling remains deferred.
- Test-only services were stopped after verification. Existing demo application services/data were not restarted, regenerated or migrated.
