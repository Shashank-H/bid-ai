# Configuration management — working plan

## Context

Add publisher-scoped configuration editing, immutable versions with individually addressable UI pages, and agent access to view/navigate/propose updates. This completes deferred Phase 2 editing and brings forward the necessary Phase 5 approval slice; it does not require completing analytics/dashboard Phase 4 first.

Requirements source: `docs/requirements/Full-Requirements.md`; roadmap: `docs/architecture-and-implementation/IMPLEMENTATION-ROADMAP.md`. Existing policy requires explicit publisher approval before agent-originated mutations. Stored changes must not rewrite synthetic auction history or imply deployment to a live website.

## Approach

- **One shared mutable draft per publisher.** Saving edits updates that draft; it does not create a version. No multiple drafts, branches or separate activation workflow.
- **Publish creates the immutable version and makes it current in one action.** Identify versions in the UI by server-assigned UTC publish date/time; each has its own page.
- **The authenticated person who publishes is the author.** If the agent contributed to the draft, record the agent as coauthor; do not substitute the requesting/approving person for the publishing author.
- Keep structured forms plus validated JSON within the existing supported synthetic Prebid profile. Derive summary settings server-side.
- Agent changes require a review/approval card before updating the shared draft. Publishing is always a separate explicit human action. Agent links and requested navigation remain in scope.
- Reuse existing services, authentication, tools and DynamoDB table. Keep the implementation small; no generalized proposal/activation framework.
- Preserve original seeded records: `data-reconcile.ts` hashes original configuration/history, so store runtime draft/publications separately and leave reconciliation's seed reads unchanged.

## Draft and publish behavior

Use the existing publisher-data table. Add only a singleton draft, immutable publication records and a runtime current pointer under each publisher; no new database.

- Draft stores the supported Prebid document, revision for concurrent edits, base published version and an agent-contributed flag. Manual edits preserve that flag; publishing/resetting starts a fresh draft lifecycle. Unsaved typing stays local until Save draft.
- Saving checks the expected draft revision. Conflicting edits from another user/tab or an outdated agent card return `409`; never silently overwrite the shared draft.
- Publish validates the exact saved draft and expected current version, then atomically writes the publication, updates current and clears the draft. Store publish-request identity on the publication so a retried publish returns the same result rather than publishing twice.
- Version IDs use server-assigned UTC publish timestamps, including milliseconds; allocate monotonically per publisher to handle same-millisecond requests. Existing numeric configuration versions may continue internally for compatibility; they are not an additional user-facing lifecycle.
- Publication records store immutable content, derived summary, publication time, authenticated publishing author and optional agent coauthor. Keep draft editor/approval attribution separate from authorship. Historical synthetic user attribution remains unchanged.
- Opening an old version is read-only. “Use as draft” replaces the single draft after confirmation and revision check; publishing it creates a new timestamped version. No direct reactivation or version mutation.
- Serve original seeded snapshots/history alongside runtime publications, falling back to seeded current before the first publish. Preserve seed records and historical metrics; runtime changes do not alter the dataset hash or reconciliation inputs.
- Reuse strict validation, publisher authorization, same-origin write protection and existing byte limits. Page version/history results rather than failing after 50 lifetime changes. No silent truncation of agent evidence.

## UI and API

Preserve `DESIGN.md`, existing themes and workspace shell; no redesign or new editor/router dependency.

- `/configurations`: current configuration, one Edit draft entry and paginated published history labelled by date/time, author and agent coauthor where applicable.
- `/configurations/draft`: structured form/JSON tabs sharing one document; Save draft and Publish actions, plus diff against current. Forms cover supported floor, timeout, bidder/ad-unit and common auction settings; JSON covers the full existing schema. Preserve invalid JSON until corrected and show field/path errors. No independently editable derived summary.
- `/configurations/versions/:versionId`: immutable published document, JSON, diff and authorship; “Use as draft” warns before replacing existing shared work.
- Publish confirmation shows the exact saved draft, publishing author, agent coauthor if applicable, and warns that performance is unverified and this is stored configuration only—not live website deployment.
- Keep chat/conversation parameters intact; support deep links, reload and back/forward using the existing shell with minimal History API routing. Guard unsaved edits and handle loading, empty, conflict and error states accessibly.
- APIs: authenticated current/list/detail/draft reads; save draft; publish draft; and approve/reject an agent draft update. Reuse authorization and request validation for every endpoint. No separate activation or multiple-draft APIs.
- Refresh configuration views after save/publish without resetting chat or analytics selection.

## Agent updates and navigation

- Agent can read current, draft and published versions, compare them, and propose an exact update to the single draft. Reuse existing tools/services and return typed same-origin links.
- Keep at most one pending agent update for the shared draft, with exact before/after content, rationale, authorized evidence and expected draft/current revisions. A new proposal supersedes the prior card; it does not create another draft or publication.
- Approval card offers “Update draft” / “Reject.” Approval revalidates revisions and atomically updates the singleton draft with agent contribution recorded. Manual saves invalidate outdated cards. Reject does not change the draft. Only a human Publish action creates a published version, with that human as author and agent as coauthor.
- Bind proposal identity to trusted conversation/turn/tool-call identity; retries/resumed execution return the same outcome and cannot reapply or replace newer work. Persist enough status to disable stale/replayed cards after reload; no generalized proposal ledger.
- Generalize read-only tool typing only as needed for proposing draft updates; never expose approval or publication as model-callable tools. Supply model tool definitions and dispatcher from the same runtime registry (`agent/model.ts` currently imports a separate static list).
- Agent returns Open draft/version controls and can request navigation when explicitly asked. Allowlist targets, protect unsaved work, keep chat available and never replay navigation when loading history.
- Update the agent prompt for one draft, timestamped publications, author/coauthor rules and no promises of performance gains. Reuse existing tracing; no new AI infrastructure.

## Files to modify

Existing boundaries:

- `packages/shared/src/configuration.ts`, `prebid.ts`, `protocol.ts`, `analytics.ts`, `index.ts` — singleton draft, timestamped publications, approved draft-update contracts and author/coauthor attribution; preserve historical contracts.
- `apps/api/src/domain/configuration.ts`, `interfaces.ts`, `runtime-data.ts` — shared editing/proposal services, repository capability and runtime registry wiring.
- `apps/api/src/db/publisher-data.ts`, `fixtures/publishers.ts` — seed read adapter and isolated per-app fixture capabilities; keep command-only seed writer unchanged.
- `apps/api/src/app.ts`, `server.ts` — inject/register configuration services and routes.
- `apps/api/src/tools/types.ts`, `registry.ts`, `dispatch.ts`; `agent/model.ts`, `service.ts`, `graph.ts`, `prompt.ts` — tool capabilities, consistent definitions/dispatch and trusted replay-safe invocation context.
- `apps/web/src/Workspace.tsx`, `Chat.tsx`, `ToolResults.tsx`, `EvidenceIndicator.tsx`, `api.ts`, `workspace.css` — URL-backed pages, configuration evidence/navigation and approval cards.
- `README.md`, `docs/architecture-and-implementation/IMPLEMENTATION-ROADMAP.md` — reflect delivered editor/approval slice without claiming all Phase 2/5 work is complete.

New focused modules:

- `apps/api/src/db/configuration-management.ts` — singleton draft, atomic publish, bounded pending agent update and published history.
- `apps/api/src/routes/configurations.ts` — authorized reads, draft save, publish and agent draft-update approval using the shared service.
- `apps/web/src/Configurations.tsx`, `ConfigurationVersion.tsx`, `ConfigurationEditor.tsx`, `ConfigurationProposal.tsx`, `configuration.css` — list, detail, editing and approval presentation; split only by these responsibilities.
- `tests/e2e/configurations.spec.ts`, `tests/support/model-server.ts` deterministic fake-model scenario extensions, and `docs/requirements/phase 2/CONFIGURATION-MANAGEMENT-VERIFICATION.md`.

Implementation must inspect all callers of changed contracts and update fixture/model test helpers, barrel exports and saved conversation decoding together.

## Reuse

- `Configurations.current/history` in `apps/api/src/domain/configuration.ts`: authorized configuration evidence and history output.
- Existing DynamoDB current/history storage and Phase 3 seed data: preserve compatibility and historical integrity.
- `packages/shared/src/configuration.ts`: configuration/history schemas, `summarizePrebidConfiguration` and canonical snapshot consistency.
- `packages/shared/src/prebid.ts`: strict native configuration validation and bidder/adapter cross-checks.
- `apps/web/src/Workspace.tsx`: existing analytics main area, navigation rail and persistent agent side panel; extend rather than create a separate app shell.
- `apps/api/src/tools/registry.ts`: first-class validated direct-function tools; currently typed as read-only, so proposals need an explicit capability boundary.
- `apps/api/src/db/publisher-data-writes.ts`: seed-only transactional write patterns; do not reuse this command-only two-publisher loader as the runtime editor.

## Steps

- [x] Confirm revised scope: one shared draft; Publish creates a date/time version; publisher is author and agent is coauthor when it contributed.
- [x] Add minimal draft/publication contracts and runtime persistence; preserve seeded history and existing conversations.
- [x] Implement validated save/publish and approved agent draft updates with concurrency and retry protection through shared services/routes.
- [x] Add configuration list, singleton editor and published-version pages to the existing workspace.
- [x] Wire agent draft/version reads, proposal cards and safe navigation using a consistent runtime tool registry.
- [x] Verify core flows and update README/roadmap and phase verification notes. Fixture mode stays per-app and ephemeral; database mode stays durable with no fallback.

## Verification

Build/typecheck affected workspaces and use existing Docker Compose infrastructure for focused core E2E checks; no new cosmetic test suite or unit-test expansion.

1. Repeated saves update the same shared draft without changing current/history. Form/JSON round-trip; invalid/unsupported/oversized input is rejected.
2. Publish creates one immutable timestamped version and updates current atomically; retries do not duplicate it. Two-user/tab stale saves and stale publish attempts fail safely.
3. Publishing user is author even if another user edited/approved the draft. Approved AI contribution results in agent coauthor, retained through subsequent manual edits; an entirely manual draft has no agent coauthor.
4. Agent approval changes only the shared draft; reject/stale/replayed cards cannot overwrite newer work. Model cannot publish. Published history stays immutable when using an older version as draft.
5. Version deep links, reload, back/forward and requested agent navigation work without losing chat or unsaved edits. Database state survives restart.
6. Publisher isolation, fresh membership checks, same-origin writes, trusted authorship and navigation targets hold for both HTTP and tool paths.
7. History is paginated and excludes the draft. Seed configuration/history/hash and historical metrics remain unchanged; reconciliation and existing analytics/chat flows still work.

## Backtesting — deferred follow-up (confirmed)

The user requested testing candidate configurations before publishing, including agent access, and explicitly chose to deliver it as a separate follow-up after configuration management. Backtesting will be optional with warnings, never an automatic approval/publish gate. Do not add replay APIs/tools, jobs, tables or nonfunctional UI buttons in this implementation. The following are discovery notes for the follow-up plan, not current implementation steps.

Recommend a read-only historical replay, not a claim of confirmed future performance.

- `packages/shared/src/auction-record.ts` retains individual bidder requests, responses/rejections, timeout and candidate/win/render observations; inspect exact offer/latency completeness before promising supported counterfactuals.
- `apps/api/src/domain/prebid-configuration.ts` already describes modeled versus validated-inactive settings and resolves effective timeout/floor; reuse these semantics.
- Inspect `scripts/phase-3-data/simulation.ts` and `prebid-harness.mjs` for reusable public auction rules, but never import private scenario definitions/manifests or regenerate favorable demand inside the agent runtime.
- Compare candidate versus baseline on identical observed opportunities/window; report estimated revenue, fill, CPM, participation, waiting time and per-day differences. Report coverage, unsupported changes, missing observations and assumptions. No missing response becomes an invented bid; observed economics are not a prediction of bidder adaptation.
- Bind results to exact candidate content/version, baseline and dataset identity; later edits invalidate applicability. Backtesting never saves, approves or activates configuration.
- Follow-up scope and replay algorithms need their own plan and verification before implementation. Current publish confirmation should truthfully state that outcomes are unverified and no live deployment is performed; it must not imply a backtest has run.

## Out of scope and risks

No multiple drafts, draft version history, separate activation lifecycle, branches/merges, backtesting implementation, arbitrary Prebid code/real SSP integration, live-site deployment, performance guarantees, generalized approval framework or new infrastructure.

The draft is shared: concurrent edits must conflict visibly instead of overwriting another person's work. Preserve seeded records used by reconciliation. No implementation or tests have run during planning.
