# Bid Intelligence — High-Level Implementation Roadmap

## Context

Build an agent-first publisher ad-ops assistant. Prioritize a functioning agent before historical datasets, synthetic scenario generation, or advanced analytics. Complete the shared setup once in Phase 0; Phase 1 starts product implementation.

The local foundation and Phase 1 read-only investigation agent are implemented. Phase 3 incorporates the DynamoDB repository/aggregation prerequisite from Phase 2 and adds configuration-first deterministic historical generation; the settings editor and agent mutation remain deferred. The user-approved auction-item dataset is ready in `bid-publisher-data`; two independent full reconciliations, all five read-only tools, 17 integration checks and fixture/persisted browser suites passed. See `docs/requirements/phase 3/DATA-VERIFICATION.md`. The configured live endpoint previously passed the audited compatibility probe in `docs/architecture-and-implementation/TRACING-VERIFICATION.md`; that is not a new live-agent smoke.

Requirements source: `docs/requirements/Full-Requirements.md`. Preserve the exercise brief at `docs/architecture-and-implementation/Full-Coding-Task.md`.

## Approach

Deliver one demonstrable vertical slice per phase. Phase 0 owns shared setup; Phase 1 starts actual product implementation. Historical data is not a prerequisite for seeing the agent work.

### High-level architecture

```text
React dashboard ── Node backend
                    ├─ user module: authentication + publisher authorization
                    ├─ configuration routes: authenticated edits and saves
                    └─ streaming agent ── OpenAI-compatible API
                               │
                         tool definitions + functions
                               │
                    shared analytics/configuration services
                               │
                         DynamoDB repositories
                               │
                          DynamoDB Local
                               ▲
                    explicit seed/generation commands

Optional later MCP adapter ── same tool functions / shared services
(agent execution does not depend on MCP)
```

- **Monorepo:** pnpm workspaces; TypeScript throughout. React/Vite for the dashboard; a small Node HTTP server such as Fastify hosts the agent, user/authentication module, configuration management, and approval routes together.
- **Agent:** OpenAI SDK pointed at the user's compatible server through `LLM_BASE_URL`, `LLM_API_KEY`, and `LLM_MODEL`. Implement a bounded LangGraph JS tool-calling graph with PostgreSQL checkpoints, not a scripted chatbot. No model hosting or model selection work is planned. The endpoint must support streaming and tool calls; verify compatibility early.
- **First-class tools:** each tool has a name, description, input/output schema, and ordinary TypeScript execution function. The agent validates arguments and calls the function directly with server-derived user/publisher context. Tool functions invoke shared domain services; these are independent of both LLM and transport protocols. Swap fixture repositories for DynamoDB repositories without changing tool definitions.
- **Optional MCP:** not part of the core agent path or required phase sequence. If requested later, export the same tool functions through an MCP adapter, or wrap the same shared services; do not duplicate business logic or make the agent depend on MCP. A future adapter can live in the existing backend, without another database or mandatory Compose service.
- **Persistence:** DynamoDB Local with a Docker volume. AWS SDK v3 is used only as the DynamoDB client against its local endpoint, with local-only credentials. PostgreSQL is included by user-approved Phase 1 revision for conversations/checkpoints; Drizzle manages application tables and the official LangGraph saver manages checkpoint tables. Redis, vector databases, queue brokers and other AWS services are not planned.
- **Data model:** users, publisher memberships, stateless signed-cookie authentication (no stored sessions), publisher-scoped Prebid events, aggregated daily/bidder metrics, current configurations, and immutable configuration change history. Each configuration save records the authenticated updating user's ID, publisher, timestamp, before/after values or diff, and configuration version; agent-approved changes also reference their proposal and approving user. Later proposals/audit records reuse that attribution. Define logical entities/access patterns in Phase 0; refine keys/indexes in phase plans.
- **Seed-first data:** explicit commands validate and write synthetic auction observations, configurations and user-attributed history into DynamoDB, then derive reconciled metrics. Phase 3's approved storage unit is one uncompressed auction item retaining detailed bidder observations, not one item per lifecycle event. No live browser integration, injected script, collector or event-ingestion API is required. Tiny fixtures remain available independently of historical data.
- **User module and security:** the same backend that hosts the agent authenticates users and resolves their publisher memberships. Use Argon2id credentials in DynamoDB and stateless signed expiring cookies with fresh disabled-user/membership checks; never persist session records. Logout clears the cookie but does not revoke a copied token. No external identity service or Redis session store. Bootstrap a minimal set of development users explicitly; keep this separate from the later historical dataset. Configuration routes let authorized users modify/save settings through shared services. Tool dispatch and all configuration writes use trusted user/publisher context, never an unrestricted model-supplied publisher ID.
- **Testing:** shared validation schemas, unit/integration tests, and browser end-to-end tests, run locally. No CI/CD pipelines.

Docker Compose owns `web`, `api`, `dynamodb`, `postgres`, and an idempotent DynamoDB-init job; PostgreSQL migrations are explicit. Run user-bootstrap, seed/generation, and verification commands through existing containers. No production MCP/model/collector/Redis service is required. Test-only isolated API/web services are optional; subsequent phases reuse this setup.

Phase 0 is complete setup, not speculative product implementation: empty database entities, service skeletons, build outputs, environment configuration, and scripts are ready. Later phases can evolve schemas and add dependencies as implementation details become clear, but reuse existing setup; the approved Phase 1 PostgreSQL addition is the explicit exception to the original no-extra-database decision.

Keep this document high-level. Resolve algorithms, schemas, exact package versions, UI design, and task breakdowns in `docs/requirements/phase N/PLAN.md` before implementing that phase. Never permit configuration mutation without explicit publisher approval; label all synthetic earnings as estimated revenue.

## Confirmed decisions

- Phase 1 implements persistent read-only streaming investigations over tiny fixtures, with stateless backend authentication, PostgreSQL/Drizzle conversations, LangGraph checkpoints and explicit authorized resume.
- Tools/functions are first-class; MCP is an optional future export adapter, not an agent dependency.
- TypeScript end-to-end: pnpm monorepo, React dashboard, and one Node backend hosting agent, user, and configuration modules.
- Seed the database rather than collecting live Prebid events; no injection or ingestion implementation is planned.
- Persist configuration changes with the identity of the user who made or approved them.
- Docker Compose is the sole runtime orchestration target. All databases run locally in Docker.
- No AWS deployment, cloud infrastructure definitions, or CI/CD pipelines. Use DynamoDB Local to meet the persistence requirements without introducing unrelated databases.
- Phase 0 provisions empty database resources and all service wiring; later phases implement capabilities and populate data, not repeat setup.

## Steps — Phases and exit gates

### Phase 0 — Complete local foundation

**Outcome:** a clean checkout can start the whole local environment before any product functionality is built.

- [x] Create three workspaces for dashboard, backend (including domain/tools/database/data commands), and browser-safe shared contracts. Leave an adapter boundary for optional MCP exports, not a running MCP service.
- [x] Establish Dockerfiles, Compose networking, persistent DynamoDB storage, readiness checks, and idempotent creation of all planned database resources.
- [x] Wire API/web URLs, fixture-versus-database repository configuration, authentication/session settings, and OpenAI-compatible settings. Secrets stay outside version control; the browser never receives the model API key.
- [x] Scaffold build/typecheck/test commands, local browser-test execution, database initialization/reset, user-bootstrap, and later seed/generator commands. Destructive resets must be explicit, never part of ordinary startup.
- [x] Define user/publisher context, tool definitions/function contracts, metric semantics, streaming results, configuration versioning and updating-user attribution, plus logical user/session/event/proposal records. Create no historical seed dataset.
- [x] Normalize requirements documentation paths and write the environment/runbook documentation. Keep README concise.

**Exit gate:** documented startup brings up healthy service skeletons and initialized empty DynamoDB resources; restart retains data; repeat initialization is safe; repository checks run. Verify the user's model endpoint with a minimal streaming/tool-call probe, without building the agent here. Implementation and local checks are complete; full exit acceptance remains pending that real endpoint probe.

### Phase 1 — Working read-only agent

**Outcome:** implemented authenticated browser chat with a bounded LangGraph/OpenAI SDK investigation agent.

- [x] Argon2id development users/publisher metadata/memberships explicitly bootstrapped in DynamoDB; stateless signed cookies, no session storage, one publisher per user.
- [x] Bare login/chat UI with streamed provisional/final findings, Stop, tool results/evidence and saved reload.
- [x] Five validated publisher-scoped read-only tools over tiny fixed demo fixtures; no mutation tools or historical generator.
- [x] PostgreSQL/Drizzle conversation records and official LangGraph checkpoints with fenced execution leases, cumulative budgets, explicit resume and terminal projection recovery.
- [x] Actual SDK/mock-HTTP multi-tool integration and real database/browser flows verify isolation, persistence, cancellation, evidence and failure handling; no private chain-of-thought displayed.

**Verification:** 56 regression tests, 15 integration tests and seven Chromium checks passed; see `docs/requirements/phase 1/VERIFICATION.md`. New live-agent smoke was skipped because current private model-key settings were incomplete. Prior audited probe success is not presented as a new live agent test. Public demo-only accounts/setup are in the phase's `DEMO-ACCOUNTS.md`.

### Phase 2 — Persisted seed data and user configuration management

**Outcome:** the same agent investigates persisted data; authenticated users can edit/save configurations in the same backend.

**Current scope:** Phase 3 implements the required read repositories, canonical configuration/history storage and reconciliation. Its historical seed is one-time, not a general replacement/resume system. Direct configuration editing/saving below remains deferred; the full Phase 2 exit gate is not claimed.

- [x] Implement DynamoDB repositories behind the existing tool/domain services, bounded date-range queries, current configuration storage, and timestamped version history.
- [ ] Add a small explicit seed command for synthetic Prebid events including `bidRequested`, `bidResponse`, and `bidWon`, initial configurations, and history attributed to development users. This is not yet the 6–8-week scenario generator.
- [ ] Validate seed records and stable event identities; support repeatable loads without duplicates, bounded batch writes/retries, and useful errors. Reset/replacement behavior must be explicit and scoped to the demo dataset.
- [x] Build rerunnable aggregation using existing commands; account for auctions, eligible/late responses, filled impressions, winning CPM, and estimated revenue without counting `bidWon` as verified paid revenue. Implemented and verified by Phase 3, including two independent complete read-only reconciliations with unchanged metrics/hashes.
- [ ] Add authenticated configuration read/edit/save routes and a minimal settings UI. Check publisher membership, allowed fields/ranges, and expected configuration version; atomically persist the updated configuration and an immutable history entry with the updating user's ID.
- [ ] Keep the agent read-only. A user's explicit settings save is a direct authorized action, not approval for arbitrary future agent mutations.

**Exit gate:** seed commands populate DynamoDB and reconcile metrics; rerunning does not inflate counts; existing tool functions answer from persisted data. An authenticated user's save updates the configuration and records who changed it; unauthorized and stale saves fail safely. No live event ingestion is needed.

### Phase 3 — Reproducible historical data and scenarios

**Outcome:** realistic investigations are supported by deterministic data for both publishers.

**Current scope:** deterministic generation, offline scenario checks, repository/tool wiring, the separate generator boundary and one-uncompressed-item-per-auction storage are implemented and verified. Both datasets are ready in `bid-publisher-data`: 110,288 auction items preserve 1,925,599 logical events and the original content hashes. The one-time load completed in 59 minutes 39.6 seconds; two independent full reconciliations matched all metrics, all five tools passed full-span budgets/isolation checks, 17 integration tests passed, and browser suites passed (10 fixture / 2 persisted). Coverage is exactly 56 elapsed days across 57 UTC date buckets. Detailed counts, storage and commands are in the phase verification/runbook documents. The earlier event-row load was intentionally stopped; **retain its test tables/partial data**. Main application settings remain fixture mode until explicitly switched; no editor or mutation capability is included.

- [x] Generate 6–8 weeks per publisher using seeded randomness and controlled scenario parameters, through the shared data contracts and aggregation path; exactly 56 elapsed days for this dataset.
- [x] Model Publisher A's floor increase from $0.80 to $1.40 and approximately 18% Week 4 estimated revenue decline; offline assertions pass.
- [x] Model Publisher B's bidder latency degradation, revenue growth despite lower traffic, and underperforming bidder, without contradictory or confounded scenario windows; offline assertions pass.
- [x] Persist corresponding configurations and change history attributed to synthetic development users; document metric definitions, dataset volume, scenario windows, and reproduction commands. Both publishers are ready and verified.
- [x] Provide a separate scenario manifest path available only to tests/demo preparation; do not mount it into the backend container or expose it through tools. Generation runs in a separate command image/process using the existing Compose infrastructure; the private manifest was created before atomic readiness.
- [x] Add reconciliation, anomaly, deterministic-output, and cross-publisher access tests. Load datasets through an explicit command, not normal startup.

**Exit gate:** identical seeds/settings reproduce the same dataset and expected metric relationships; raw events reconcile with aggregates; each scenario is discoverable through normal tools without reading the manifest.

### Phase 4 — Evidence-backed investigations and dashboard

**Outcome:** the agent handles the requirements' investigation questions with inspectable evidence.

- [ ] Extend tools where needed for time-series, bidder latency/participation, and before/after configuration comparisons.
- [ ] Add supporting charts, metric comparisons, evidence links, and readable tool traces to the chat/dashboard.
- [ ] Evaluate all Publisher A/B scenarios and additional investigation questions; compare answer quality against observations, not exact model wording.
- [ ] Distinguish observation, likely cause, recommendation, and uncertainty; avoid claiming causation from temporal correlation or promising hypothetical gains.
- [ ] Handle insufficient data, empty periods, tool failure, and context growth with bounded result sizes and clear explanations.

**Exit gate:** the agent explains the revenue decline and Publisher B patterns from authorized multi-tool evidence; charts match the tool results; recommendations remain read-only. Label fixtures/synthetic data and estimated revenue consistently.

### Phase 5 — Explicit approval and configuration changes

**Outcome:** recommendations become actionable locally without granting the model autonomous mutation rights.

- [ ] Create structured proposals containing publisher, exact configuration diff, evidence, rationale, current version, and status.
- [ ] Present interactive approve/reject cards. Approval is a dedicated authenticated user action, not model interpretation of conversational text.
- [ ] On approval, revalidate authenticated user membership, publisher ownership, allowed fields/ranges, current version, and proposal status before an idempotent conditional write through the same configuration service used for direct user saves. Reject stale or replayed approvals.
- [ ] Record the approving user's ID, decision, proposal reference, and applied change in audit/configuration history; expose results for subsequent investigations.
- [ ] Refresh the dashboard's configuration after a save. Clearly distinguish updating stored configuration from controlling a real publisher website; historical synthetic events are not rewritten by a configuration change.

**Exit gate:** a proposed floor adjustment can be explicitly approved and persisted once; rejection, stale versions, cross-publisher requests, and direct unauthorized mutation all fail safely. No live publisher deployment is implied.

### Phase 6 — Hardening and repeatable delivery

**Outcome:** the local demo is reliable, reviewable, and easy to run.

- [ ] Consolidate regression tests across authentication, chat, tool functions, configuration saves/history, seed loading, aggregates, scenarios, and approvals.
- [ ] Exercise retries, partial seed-write failures, disconnected streams, unavailable model/database, expired sessions, restarts, and bounded-volume local performance.
- [ ] Add structured logs and request/tool correlation IDs without logging secrets or unnecessary raw prompts; document practical throughput limits.
- [ ] Produce a concise demo walkthrough, scenario runbook, architecture summary, and final README run/check instructions.

**Exit gate:** a fresh environment can reproduce the agent-first demo and the complete scenario/approval demo using documented Compose commands and the user's model endpoint. No AWS resources, CI/CD, or extra database setup is required.

**Dependencies:** Phase 0 → 1 → 2 → 3 → 4 → 5 → 6. Each phase remains independently demonstrable. Refinement and testing happen throughout; Phase 6 is consolidation, not the first testing phase.

## Files to modify / create

These are cross-phase implementation boundaries; individual phase plans refine exact filenames.

| Paths                                                                                     | Responsibility                                                                                                |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `docs/architecture-and-implementation/IMPLEMENTATION-ROADMAP.md`                          | Cross-phase roadmap (this document)                                                                           |
| `docs/requirements/Full-Requirements.md`                                                  | Canonical requirements (normalized during Phase 0 without changing scope)                                     |
| `docs/requirements/phase N/PLAN.md`                                                       | Detailed plan and all supporting documentation for each phase, including Phase 0                              |
| `README.md`, `docs/architecture-and-implementation/LOCAL-DEVELOPMENT.md`                  | Concise project overview and shared setup/runbook                                                             |
| `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.env.example`, `.gitignore` | Monorepo and shared tooling/environment                                                                       |
| `compose.yaml`, `docker/`                                                                 | Local services, Dockerfiles, database initialization                                                          |
| `apps/web/`                                                                               | Login, dashboard, chat, configuration editor, charts, approvals                                               |
| `apps/api/`                                                                               | Co-hosted agent, user/authentication and configuration modules; optional future MCP adapter only if requested |
| `apps/api/src/tools/`                                                                     | Tool definitions and directly callable execution functions                                                    |
| `apps/api/src/domain/`                                                                    | Shared analytics/configuration services used by tools and authenticated routes                                |
| `packages/shared/`, `apps/api/src/db/`                                                    | Shared schemas, metric semantics, user/publisher context, DynamoDB repositories                               |
| `apps/api/src/commands/`                                                                  | Development user-bootstrap, fixture/seed/generator/reconciliation commands                                    |
| `tests/`                                                                                  | Cross-service and browser tests; hidden scenario manifest in a test-only location                             |

Exact filenames within these directories will be resolved in individual phase plans. Phase 0 creates the workspace/service shells and command wiring; later phases fill in their behavior.

## Reuse

- `docs/requirements/Full-Requirements.md`: publisher scenarios, reconciliation, reproducibility, tenant isolation, and acceptance criteria.
- `docs/architecture-and-implementation/Full-Coding-Task.md`: streaming agent, persistence goals, and explicit mutation approval. This roadmap intentionally narrows the brief: synthetic Prebid data replaces capture; DynamoDB Local replaces cloud deployment; direct function tools replace MCP-first execution. MCP exports remain optional future work.
- `README.md`: concise project overview and implemented local foundation run/check instructions.
- Phase 0 establishes shared contracts and local resource helpers for later-phase reuse.

## Planning checklist

- [x] Resolve architecture and Phase 1 demonstration scope.
- [x] Define phase sequence, dependencies, implementation boundaries, and exit gates.
- [x] Include all required infrastructure in Phase 0 without prematurely implementing later product capabilities.
- [x] Map the roadmap to requirements and document end-to-end verification for each phase.
- [x] Review and approve the roadmap and detailed Phase 0 plan before implementation.

## Verification

Use each phase's exit gate as its acceptance checklist. Phase-specific plans and the shared local runbook define commands and tests. The Phase 0 verification record distinguishes completed local checks from the pending live-model gate.

| Requirement                                       | Delivery / verification                                                                                                            |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Working streaming agent with direct tools         | Phase 1 browser-to-model-to-function demonstration; mock-model contract tests plus an opt-in real-endpoint smoke test              |
| Local setup once                                  | Phase 0 clean-start, health, persistence, initialization checks; later phases reuse the same Compose services                      |
| Persisted synthetic Prebid events                 | Phase 2 seed validation, repeatable loads, duplicate protection, and aggregate reconciliation                                      |
| Backend user and configuration modules            | Phase 1 authentication/session tests; Phase 2 authorized configuration saves, version checks, and updating-user history assertions |
| Seeded history and Publisher A/B anomalies        | Phase 3 reproducibility and scenario metric assertions                                                                             |
| Tenant isolation and manifest secrecy             | Phase 1 onwards adversarial tool/API tests; Phase 3 manifest excluded from model-facing runtimes                                   |
| Charts, metrics, traces and cautious explanations | Phase 4 browser checks and evidence-grounded scenario evaluations                                                                  |
| Explicit mutation approval                        | Phase 5 authorized approval, rejection, replay/staleness, audit/history tests                                                      |
| Repeatable final demo                             | Phase 6 fresh-start walkthrough and local regression suite                                                                         |

## Out of scope

AWS deployment, cloud provisioning, CI/CD, model hosting, external identity-provider integration, live Prebid capture, injected scripts, ingestion endpoints, paid-revenue attribution, live-site deployment automation, predictive optimization, Redis/other unplanned databases, and MCP-first execution. Backend user authentication and configuration editing are in scope. Optional MCP exports are deferred until requested and must reuse function/domain contracts. This is a seed-driven local agent implementation, not a complete implementation of the brief's live collector, Lambda deployment, or MCP transport requirements.
