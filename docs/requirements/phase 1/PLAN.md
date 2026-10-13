# Phase 1 — Working read-only investigation agent

## Context

The local foundation is implemented. Phase 1 delivers authenticated browser chat with a real streaming model and publisher-scoped read-only tools over tiny demo fixtures. Requirements source: `docs/requirements/Full-Requirements.md`; scope and sequencing: `docs/architecture-and-implementation/IMPLEMENTATION-ROADMAP.md`.

Full historical generation, persisted analytics, configuration editing, charts, and approval cards remain later-phase work. The README reports a successful live model compatibility probe; the roadmap's pending-probe wording is stale and must be reconciled.

## Approach

- Reuse existing shared contracts, model integration and DynamoDB setup. Add one local PostgreSQL Compose service with persistent storage and explicit schema/checkpointer initialization; this is the user-approved exception to the original no-extra-database roadmap.
- Authenticate development users with Argon2id credentials and stateless signed expiring cookies; resolve publisher access exclusively on the server. The approved implementation note forbids storing session data in any database.
- Implement bounded streaming tool execution with performance summary, period comparison, bidder performance, configuration, and configuration history tools.
- Use small checked-in publisher fixtures; label all earnings estimated revenue and all observations demo data.
- Show chat, cancellation, tool status/results, and evidence references without exposing chain-of-thought.
- PostgreSQL owns conversation metadata, turns, visible tool evidence and LangGraph checkpoints. DynamoDB retains users/memberships and publisher analytics/configuration; no sessions/token hashes are persisted. Browser input contains only the new message, never trusted transcript, checkpoint or identity.
- Implement the bounded tool loop as a LangGraph JS `StateGraph` compiled with `PostgresSaver`, while retaining the proven OpenAI SDK directly inside model nodes and existing first-class TypeScript tools. No MCP, hosted LangGraph service or prebuilt agent abstraction is required.
- Existing shared stream events carry turn/correlation IDs but no conversation or structured metric payload. Extend these deliberately; otherwise the browser cannot show numerical evidence or reconnect a saved turn.
- The existing nginx proxy already disables buffering and propagates client aborts with a 120-second timeout. Keep turns below that limit; no new streaming infrastructure is needed.

## Files to modify

Existing files:
- `apps/api/src/app.ts`, `server.ts`, `env.ts`: dependencies, route registration, safe HTTP errors, lifecycle and bounded agent settings.
- `apps/api/src/domain/interfaces.ts`, `tools/types.ts`: PostgreSQL conversation storage and typed numerical tool outputs.
- `apps/api/package.json`, `pnpm-lock.yaml`: add compatible pinned `argon2`, `drizzle-orm`, `@langchain/langgraph`, `@langchain/langgraph-checkpoint-postgres` and `pg` dependencies, plus `drizzle-kit` as a development dependency (and direct peer/type dependencies as required); validate exact versions together during implementation.
- `apps/api/src/commands/cli.ts`, `commands/deferred.ts`: activate the existing `users:bootstrap` command and add `postgres:init`; leave historical data commands deferred.
- `apps/api/src/observability/tracing.ts`: add a generic turn root using existing generation/tool privacy guards; retain audited pinned SDK versions (5.13.1), not a dependency-upgrade project.
- `packages/shared/src/protocol.ts`, `identity.ts`, `index.ts`; new `conversation.ts`: browser-safe auth, conversation, numerical result and stream contracts.
- `apps/web/src/App.tsx`, `styles.css`: replace foundation-only page with basic login/chat while retaining availability feedback.
- `tests/e2e/foundation.spec.ts`, `tests/unit/boundaries.test.ts`: adapt expected capabilities without weakening existing boundaries.
- `.env.example`, `compose.yaml`, `compose.test.yaml`: add Postgres service/volume/readiness, database settings and test isolation; document bootstrap and agent budgets. Preserve private `.env` and existing DynamoDB storage; do not route database reset commands across stores.
- `README.md`, `docs/architecture-and-implementation/LOCAL-DEVELOPMENT.md`, `IMPLEMENTATION-ROADMAP.md`: commands, conversation scope, and corrected model-probe status.

New focused modules (filenames may be combined where small):
- `apps/api/src/auth/{credentials,authorization}.ts`, `routes/auth.ts`, `db/identity.ts`, `db/postgres.ts`, `db/conversations.ts`, `db/schema.ts`, `db/migrations/` (Drizzle-generated SQL and migration metadata), `apps/api/drizzle.config.ts`, `commands/users-bootstrap.ts`, `commands/postgres-init.ts`.
- `apps/api/src/fixtures/publishers.ts`, `domain/{analytics,configuration}.ts`, `tools/{registry,dispatch}.ts`.
- `apps/api/src/agent/{graph,state,prompt,stream}.ts`, `routes/conversations.ts`: LangGraph orchestration with the existing SDK/tools and safe stream adapter.
- `apps/web/src/{api,Login,Chat}.tsx` (API helper may be `.ts`).
- `tests/e2e/agent.spec.ts`, `tests/integration/phase1.test.ts`, `tests/support/model-server.ts`: deterministic fake OpenAI-compatible endpoint and core flow checks.
- `docs/requirements/phase 1/VERIFICATION.md`: actual implementation checks/results, not fabricated during planning.

## Reuse

- `apps/api/src/domain/interfaces.ts`: opaque `UserPublisherContext`, cancellable `ExecutionContext`, user and analytics/configuration repository/service interfaces (the session repository was removed under the approved stateless-auth override).
- `apps/api/src/tools/types.ts`: `ReadOnlyToolDefinition` with schemas, byte limits, trusted execution context and evidence results.
- `apps/api/src/db/tables.ts`: existing identity, publisher-data, and workflow tables with PK/SK keys; identity TTL is provisioned.
- `apps/api/src/env.ts`: session cookie/lifetime settings, fixture mode, server-only model settings and safe configuration errors.
- `apps/api/src/app.ts`: Fastify factory, redacted logs, body limit and health route registration; extend rather than replace.
- `apps/api/src/commands/model-probe.ts`: proven OpenAI SDK streaming/tool continuation patterns; diagnostic itself is deliberately not a reusable product loop.

## Steps

### 1. Authentication and explicit user bootstrap
- [x] Use Argon2id through a pinned `argon2` dependency, with library-generated random salts and library verification. Start with memoryCost 19456 KiB, timeCost 2 and parallelism 1; verify native package compatibility and login latency in the API Docker image. Bound password/login sizes; never log credentials. Require two passwords through private environment settings for explicit bootstrap; no hardcoded/default passwords or registration/reset flows.
- [x] Implement repeat-safe conditional creation in `identity`: `LOGIN#<normalized-login>/USER` for lookup, `USER#<id>/MEMBERSHIP#<publisher>` for membership; no `SESSION#` records. Use transactions for consistent user/membership bootstrap; reruns must not silently replace passwords or memberships.
- [x] Implement `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`. Return only public user/publisher metadata. Uniform invalid-login responses and small bounded local login throttling; explicitly document single-process limits.
- [x] Issue a fresh random session token in HttpOnly, SameSite=Strict, path `/` cookie; honor existing Secure/lifetime settings. Store only token hash. Enforce expiry and disabled-user/membership checks on the server (TTL deletion is not an authorization check); revoke on logout.
- [x] Enforce same-origin validation and JSON content type on state-changing browser requests; reject foreign origins. Use same-origin proxy for all browser traffic, no permissive CORS. Authenticated missing/foreign conversation IDs return indistinguishable 404 responses.
- [x] Keep trusted context construction confined to authorization code; resolve the publisher from membership, never model arguments. Preserve safe 400/401/403/404/409/429 errors rather than mapping all expected failures to the current generic 500.

### 2. Tiny fixtures and usable read-only tools
- [x] Check in two distinct fixed 14-day UTC fixture windows with daily/bidder aggregates, current configuration and attributed history. Expose available dates and synthetic/demo labels in auth/chat context, so “last week” resolves relative to fixture data rather than wall-clock time.
- [x] Use internally consistent counts, weighted CPM/fill/response/win calculations, null zero-denominator ratios and revenue totals. Publisher A has a small demonstrable before/after change; Publisher B has visibly different bidder behavior. Do not implement raw-event generation, an exact 18% target or a hidden answer manifest here.
- [x] Implement fixture repositories using trusted context and existing interfaces, then shared analytics/configuration services. Keep configuration mutation unimplemented. Return bounded numerical observations plus evidence; text summaries alone are insufficient.
- [x] Register exactly `performance_summary`, `compare_periods`, `bidder_performance`, `current_configuration`, `configuration_history`. Reuse `PeriodInputSchema` and its 90-day bounds; strict tool schemas have no publisher/user fields. Empty periods and null percentage comparisons are explicit data, not invented zeros.
- [x] Dispatch by allowlisted name, validate input/output, publisher-match evidence and enforce result byte limits. Stable evidence IDs reference returned metric/config records; never expose credential/session records or opaque errors to the model. No tool transport or mutation tools.

### 3. PostgreSQL conversations and LangGraph checkpoints
- [x] Add one pinned supported Postgres image, internal Compose networking, healthcheck and named persistent volume. Do not expose its port by default. Add server-only URL/credentials, bounded connection pool/timeouts and graceful shutdown. Keep DynamoDB identity and publisher-data ownership unchanged; publisher metadata is now explicitly bootstrapped.
- [x] Use Drizzle ORM with the `pg` driver for application conversation tables, queries and transactions. Define the application schema in `db/schema.ts`; generate and commit versioned SQL migrations with Drizzle Kit. An explicit repeat-safe `postgres:init` command applies committed migrations with Drizzle's migrator, then runs `PostgresSaver.setup()` before checkpoints are used. Do not use schema push during startup.
- [x] Keep agent checkpointing on LangGraph's official PostgreSQL saver, independently of Drizzle. It already implements LangGraph checkpoint/pending-write semantics and owns its migrations; do not recreate those tables in Drizzle or build a custom ORM checkpointer. Follow the installed saver's pool/schema requirements and use the same Postgres database with clear table/schema ownership. Fresh initialization and restart must preserve both application and saver tables; no destructive resets or credentials in logs.
- [x] SQL application tables: `conversations(id, user_id, publisher_id, thread_id, timestamps, active_turn_id, lease_generation, lease_expires_at)`; `turns(id, conversation_id, request_id, status, input, safe_output, timestamps, error_code)`; bounded `tool_executions`/evidence associated with turns. Add foreign keys, unique request IDs per conversation and owner/list indexes. Use Drizzle's parameterized queries and owner/publisher predicates on every operation; use its SQL escape hatch only where conditional lease operations require it. No cross-database transaction is needed: authenticate in DynamoDB, then authorize SQL ownership.
- [x] Create a server-generated LangGraph `thread_id` per conversation and `checkpoint_ns` for the agent graph. Validate owner metadata before any saver/graph operation. Clients cannot select arbitrary thread IDs/checkpoint IDs or access raw checkpoint APIs. Separate app/saver tables logically; the saver is authoritative execution state, SQL turn rows are the display/status projection—not a second custom checkpoint engine.
- [x] Build explicit model → validated tools → model conditional graph nodes, with terminal finalization and bounded state. Checkpoint only safe messages, validated tool calls/results, evidence, counters and turn IDs. Supply freshly authorized execution context, clients, signals and secrets via runtime dependencies, not serialized state. Reauthorize on resume and before tool execution; never trust identity in saved state.
- [x] Implement create/list/detail routes, `POST /api/conversations/:id/turns` and explicit `POST /api/conversations/:id/turns/:turnId/resume`, both streamed using fetch-readable SSE. Refresh displays persisted state only. Offer Resume only for recoverable interrupted turns; user Stop is terminal and never auto-resumed.
- [x] Accept input and acquire a per-conversation lease atomically in SQL; unique client request ID makes duplicate submissions return existing status rather than start duplicate graphs. One running graph per conversation across tabs. Do not hold database locks/transactions across model calls. Check lease generation before node side effects and checkpoint writes; use a fenced saver adapter if the installed saver has no concurrency guard. Expired leases must not permit a stale runner to overwrite a newer checkpoint.
- [x] Persist completed model/tool boundaries through the saver. For multiple tool calls, persist per-call progress so resume skips saved results where possible. LangGraph recovery can replay an unfinished node after a crash; tools remain read-only and replay-safe. Do not promise exactly-once model/tool execution or restore a mid-token provider stream.
- [x] Cancel on Stop, disconnect, session expiry, logout or deadline; abort upstream and prevent further dispatch. Save partial visible text separately with interrupted/cancelled/error status, never as a valid completed model message. Resume restores the last durable graph boundary with fresh budgets, while enforcing a bounded total per-turn resume count and cumulative tool/model allowance.
- [x] Commit terminal graph state and idempotently project the final answer/status before emitting completion. Because saver and application writes may use separate transactions, recover projection gaps from the durable graph terminal state without another model run. Restart marks stale active turns recoverable only after lease expiry; reject resume when SQL ownership/session checks fail or the checkpoint is not eligible.
- [x] Preserve saved display history, but construct bounded model context from completed messages and valid tool-call/result pairs. Never remove pending tool calls during context trimming. Keep older-context omission explicit; no vector store, semantic memory, branching/time-travel UI or conversation summarization.

### 4. Actual streaming model/tool loop
- [x] Lazily initialize the configured OpenAI SDK inside the LangGraph model node; missing/incompatible model settings must not prevent login or health startup. Reuse safe model configuration and tracing generation/tool wrappers; `runModelProbe` remains a diagnostic. Graph conditional routing and state counters enforce round/tool budgets; LangGraph recursion limit is an additional guard, not the sole budget.
- [x] Assemble streamed tool-call arguments by call index/ID (including multiple fragmented calls), then validate and execute sequentially. Return actual tool results to the model and continue until its final answer or a budget/error ends the turn. Disable automatic whole-turn retries after partial output.
- [x] Initial limits: 6 model rounds, 12 tool calls, 16 KiB per tool input, 32 KiB per tool result, 128 KiB model context, 64 KiB visible assistant output, 110-second total deadline and bounded per-request timeout. Completion-token budget configurable independently of probe settings (default 4096, hard cap 8192); tests override limits to exercise exhaustion. Bound total serialized turn/evidence storage and chunk counts too.
- [x] Translate graph/model activity into allowlisted shared stream events with conversation identity, numerical tool payloads and final validated evidence references. Never proxy LangGraph raw state/checkpoints or `streamMode: "values"` to the browser: private state channels are not inherently redacted. Heartbeat while model/tools run. Fail visibly for unknown tools, malformed arguments, unsupported streaming/tool protocol, provider failures, budget limits and database persistence failures; never echo provider payloads.
- [x] Prompt for separate observations, hypotheses and recommendations, citations to returned evidence IDs, estimated-revenue wording and uncertainty about causation. Treat user/tool text as untrusted data; tool capability enforcement is server-side, not prompt-only.
- [x] Keep streamed final text provisional until citation validation. Validate cited IDs against successful tool evidence; reject invented IDs and unsupported uncited analytical answers with an explicit incomplete/evidence error. Data-unavailable or tool-failure explanations may be uncited but must not assert analytical findings. Citation validation establishes provenance, not proof that every interpretation is correct.
- [x] Drop separate reasoning fields and suppress supported inline thinking/analysis tags with a stateful chunk-aware filter before emitting, saving or tracing content. No raw model chain-of-thought or private payload viewer. Retain known trace masking/normalization and extend turn tracing without new Langfuse services, prompt management, datasets or SDK upgrades.

### 5. Bare functional browser UI
- [x] Accessible labelled login, authenticated publisher/demo-date header, logout, basic saved conversation list and New chat. No selector, charts, design system overhaul or settings editor.
- [x] Chat composer, streaming response, Stop, explicit loading/error/interrupted states and no duplicate sends. Render model text as plain text (no raw HTML); show observation/hypothesis/recommendation distinctions and evidence links.
- [x] Expandable tool execution cards show actual inputs, bounded numerical results and evidence records, not internal reasoning. Display “Estimated revenue” and demo-data label consistently. After refresh/restart show persisted terminal/partial state; after logout clear all cached publisher chat state.

### 6. Verification and documentation
- [x] Run core cross-service/e2e checks below; no broad new unit-test suite is required. Adapt existing foundation checks and preserve boundary/security assertions.
- [x] Document explicit user/Postgres bootstrap, fixture dates, conversation/checkpoint persistence, authorized resume, replay semantics, limits and runtime settings. Update roadmap's stale Phase 0 probe status using `TRACING-VERIFICATION.md`; replace obsolete no-Postgres/no-extra-service claims and record LangGraph/Postgres as user-approved architecture revisions.

## Verification

Use the existing Docker test targets plus the new local Postgres service. Before checks, explicitly run the new `pnpm --filter @bid/api postgres:init` command through the running API container, followed by existing `users:bootstrap` using private configured development passwords. Neither operation contacts the model or seeds publisher history. Test SQL/checkpoint schemas must be isolated from demo conversations. Run build/typecheck plus existing regression checks and new focused integration/browser flows:

```sh
docker compose -f compose.yaml -f compose.test.yaml build api web
docker compose -f compose.yaml -f compose.test.yaml run --rm --no-deps api sh -lc 'pnpm build && pnpm typecheck && pnpm test && pnpm test:integration'
docker compose -f compose.yaml -f compose.test.yaml run --rm --no-deps web pnpm test:e2e
```

- **Deterministic e2e:** use a fake compatible model server only in the test environment through an optional test Compose overlay. Its fragmented stream asks for multiple real tool functions and synthesizes from their returned numbers. Confirm login → question → tool statuses/results → cited streamed answer → refresh/re-login retains saved chat → logout denies access. No production mock mode or scripted chatbot.
- **Security:** invalid/expired/tampered tokens and stateless copied-token logout semantics, disabled users, Publisher A attempts to retrieve B's conversation/evidence via direct requests, unknown tools and extra model-supplied publisher fields, foreign Origin, credential/model-key/chain-of-thought leakage checks. Assert no mutation tools/routes exist.
- **Reliability:** cancellation mid-generation/tool, browser disconnect, concurrent turns across tabs, duplicate request IDs, API restart/stale lease fencing, terminal projection gaps, unavailable Postgres/DynamoDB/model, invalid/oversized tool output, exhausted budgets, empty data, fragmented inline reasoning and fabricated citations. Reload must not silently retry interrupted work. Resume from a saved tool boundary must reuse its result; an unfinished replayed read-only node must remain safe. Forged thread/checkpoint IDs and cross-publisher resume must fail. Repeat Drizzle migrations/saver initialization and restart must preserve chats/checkpoints. Verify application migrations do not alter saver-managed tables, and test an upgrade from the previous application migration as well as a fresh database.
- **Fixture invariants:** run small integration/self-check assertions for sums, weighted metrics, bidder/daily revenue consistency, allowed dates and null denominators; no historical generator or broad unit suite.
- **Live smoke:** explicitly bootstrap users and ask “What changed in my performance?” against the actual configured endpoint. Verify multiple actual tools, continuation, supporting numerical evidence, cancellation and saved reload. The prior diagnostic proves protocol compatibility, not this agent's latency/quality. The audited model previously needed longer budgets and a container-reachable `host.docker.internal` URL; document a private Compose-reachable setting without editing `.env` during planning.
- **Optional tracing:** if already enabled, inspect one real turn's root/generation/tool hierarchy and privacy-filtered outputs. Disabled tracing must produce no exporter traffic. Before editing SDK instrumentation, consult current Langfuse docs using the installed skill; preserve audited pinned versions unless a demonstrated incompatibility requires a separate upgrade.

**Exit gate:** two isolated users can investigate their own demo publisher through persisted, cancellable streaming chat with multiple real read-only tool calls, inspect numerical evidence, and safely reload conversations. Unsupported endpoints and failures are visible; no cross-publisher data, model secrets, mutation capabilities or private reasoning leak.

## Deliberate deferrals and risks

No historical dataset/aggregation pipeline, database-backed analytics, configuration editing/approval, charts, MCP, live ingestion, CI/CD, external auth, chat export/deletion UI, checkpoint branching/time travel or automatic conversation summarization. PostgreSQL and LangGraph are now intentionally included, but no hosted agent platform, Postgres semantic-memory store or general-purpose workflow framework is planned. This is a local development app, not production identity infrastructure. Provider-specific free-text reasoning cannot be universally detected; suppress known channels/tags, test the configured provider, and never claim a generic proof of reasoning privacy. Live model answer quality and time-to-first-visible-output must be measured during implementation.

## Confirmed decisions

Confirmed: bare functional demo UI; persist conversations across refresh; two isolated development users, one per publisher, without a selector.

Persistence is an explicit addition to the roadmap's original Phase 1 slice; never trust browser-supplied transcript history.

Confirmed follow-up: PostgreSQL owns conversations and agent checkpoints using LangGraph JS with `PostgresSaver`; DynamoDB retains identity/memberships and publisher data; stateless authentication supersedes earlier session-storage wording. This supersedes the earlier workflow-table chat design and the no-PostgreSQL cross-phase constraint. Explicit authorized resume from durable boundaries is included; no automatic restart/resume or exactly-once claim.

## Implementation references

- [LangGraph JS memory/Postgres checkpointer](https://docs.langchain.com/oss/javascript/langgraph/add-memory): `PostgresSaver.fromConnString`, explicit `setup()`, `compile({ checkpointer })`, and server-owned `configurable.thread_id`.
- [LangGraph JS persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence): thread-based checkpoint state and recovery.
- [LangGraph graph API](https://docs.langchain.com/oss/javascript/langgraph/graph-api): explicit graph/state and the warning that private channels are not hidden from raw graph streaming.

These docs were inspected during planning. Confirm exact compatible package APIs/versions before installation; use the existing OpenAI SDK in custom graph nodes rather than replacing proven provider integration.


## Approved execution notes and final status

All 35 checklist items were implemented and verified through core checks; see `VERIFICATION.md` for actual pass/skip results. Authentication is stateless by explicit approval note: no DB sessions, no token hashes, no copied-token revocation claim. PostgreSQL/Drizzle and LangGraph official checkpoints remain as approved. The user subsequently requested normal publisher/account bootstrap and intentionally public **demo-only** passwords: `DEMO-ACCOUNTS.md` records them and verified setup. Only missing/blank signing/demo-password fields were added to ignored `.env`; no existing nonblank settings were replaced. Real-model investigation remains unverified until current private model configuration is complete.
