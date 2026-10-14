# Phase 0 — Complete local foundation

## Context

The requested scope is Phase 0 (corrected from Phase 1): establish the roadmap's complete local foundation before product implementation. At planning time the repository contained only documentation, with no code, dependencies, infrastructure, or tests to reuse. Implementation status and the pending live-model gate are recorded in `VERIFICATION.md`.

Sources: `docs/architecture-and-implementation/IMPLEMENTATION-ROADMAP.md`, `docs/requirements/Full-Requirements.md`, and `docs/architecture-and-implementation/Full-Coding-Task.md`. The roadmap intentionally defers live Prebid capture, cloud deployment, MCP, and approval functionality.

## Approach

- Build a TypeScript pnpm monorepo with three workspaces: React/Vite web, Fastify API, and browser-safe shared contracts. Domain, tools, database access and command modules remain folders within the API.
- Make Docker Compose the sole runtime target: web, API, persistent DynamoDB Local, and an idempotent database-init job. No model, Redis, MCP, or cloud services.
- Use Node 24 LTS, pnpm 10, TypeScript 5, React 19, Vite 7, Fastify 5, Zod 4, AWS SDK v3, OpenAI SDK, Vitest, and Playwright. Resolve compatible patch versions during implementation, pin them in manifests/lockfile, and pin container versions (not `latest`).
- Define shared boundaries and logical entities now; implement only health/readiness, initialization, command wiring, and compatibility probes.
- Normalize requirements paths without changing requirements. Keep phase documentation here and shared operational documentation under `docs/architecture-and-implementation/`.

## Files to modify / create

- Root: `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `tsconfig.base.json`, `.env.example`, `.gitignore`, `.dockerignore`, `compose.yaml`.
- `docker/`: API, web, and command-target Dockerfiles plus web proxy configuration.
- `apps/api/`, `apps/web/`: buildable service shells.
- `packages/shared/`, `apps/api/src/domain/`, `apps/api/src/tools/`, `apps/api/src/db/`: shared boundaries and contracts.
- `apps/api/src/commands/`: init/reset/bootstrap/seed/generator/reconciliation command wiring.
- `tests/`: foundation tests and browser harness.
- Normalize the requirements location at `docs/requirements/Full-Requirements.md`; fix documentation references without changing contents.
- `README.md`, `docs/architecture-and-implementation/LOCAL-DEVELOPMENT.md`: shared run/check instructions.
- `docs/requirements/phase 0/PLAN.md`: this plan and foundation acceptance checklist.

### Critical implementation paths

- `apps/api/src/{app,server,env}.ts`, `apps/api/src/routes/health.ts`, `apps/api/src/commands/model-probe.ts`: service shell, environment and diagnostic probe.
- `apps/web/src/{App,main}.tsx`: foundation status UI; no design-system work needed yet.
- `packages/shared/src/{common,identity,auction,configuration,protocol,index}.ts`: browser-safe schemas and protocol contracts.
- `apps/api/src/domain/{interfaces,metric-semantics}.ts`, `apps/api/src/tools/types.ts`: interfaces only, no fabricated business implementations.
- `apps/api/src/db/{client,tables,initialize,readiness,reset,verify}.ts`: reusable local DB setup helpers.
- `apps/api/src/commands/{cli,database,deferred,model-probe}.ts`: implemented foundation commands and explicit later-phase shells.
- `docker/{api,web,dynamodb}.Dockerfile`, `docker/nginx.conf`, `compose.test.yaml`: build/runtime/test targets and API proxy.
- `tests/integration/foundation.test.ts`, `tests/e2e/foundation.spec.ts`, `playwright.config.ts`: container-based integration/browser harness; colocate unit tests with source.
- Each workspace also receives `package.json`, `tsconfig.json`, and exports/entry points as appropriate.

## Reuse

- Roadmap architecture, phase boundaries, and exit gates.
- Full requirements: publisher isolation, reproducibility, reconciled metrics, and estimated-revenue labeling.
- Exercise brief: agentic focus, streaming, validation, and explicit approval.
- No reusable implementation exists; establish shared contracts rather than duplicating later-phase business logic.

## Foundation design

### Workspace and runtime

- Workspace names: `@bid/web`, `@bid/api`, and `@bid/shared`. Shared packages compile to ESM with explicit package exports; no runtime dependency on TypeScript path aliases.
- Dependency direction: contracts → database/domain interfaces → domain services → tools/API. Web imports browser-safe contracts only. Keep OpenAI orchestration in the API, not domain or database packages.
- Root scripts: `build`, `typecheck`, `test`, `test:integration`, and `test:e2e`. Verify compiled entry points, not only development transpilation.
- Multi-stage container builds use the frozen lockfile. API serves compiled JavaScript; web serves a production Vite build through a lightweight reverse proxy. The browser uses same-origin `/api`; proxy forwarding must support unbuffered streaming and client disconnects. No runtime bind mounts are required for baseline startup.
- API shell exposes `/api/health/live` and `/api/health/ready`; readiness verifies all required tables are active with bounded timeouts. Web renders a plain foundation-status page with the API status, not a login/chat product UI.
- Start order: healthy DynamoDB → successful init job → API readiness → web. Init failures block application startup visibly. API readiness tolerates transient database failures without pretending dependencies are healthy.
- DynamoDB Local uses a named volume, `-sharedDb`, and persistent `-dbPath`; expose it only within the Compose network. Bind web/API host ports to loopback and document configurable ports.
- Use existing API/web image test targets via `docker compose run --rm --no-deps …` for checks; do not introduce a fifth permanent service. Web's test target includes Playwright and its browser binaries.

### Contracts and empty database resources

Provision three prefix-configurable DynamoDB tables, all with provisional string `PK`/`SK` keys and on-demand billing. The reviewer approved treating physical keys/access patterns as placeholders: later phases will design them and may change them. Avoid speculative indexes; refine query access patterns in later phase plans. Init compares existing key schemas and TTL settings, creates missing tables, waits for ACTIVE, enables session TTL, and fails clearly on incompatible schemas; it never deletes or overwrites records.

| Table                | Reserved logical entity groups (keys designed later)                                       |
| -------------------- | ------------------------------------------------------------------------------------------ |
| `bid-identity`       | Users, login identity, publisher memberships and sessions; session TTL `expiresAt`         |
| `bid-publisher-data` | Publisher-scoped events, daily/bidder metrics, current configuration and immutable history |
| `bid-workflow`       | Reserved publisher-scoped proposals/audit records; workflows deferred to Phase 5           |

- Implement DB client, resource definitions, initialization, and table-readiness helpers only. Declare user/session and publisher repository interfaces; defer operational repositories and writes to their owning phases. Fixture/database repository mode is validated configuration, not a promise of an implemented analytics backend.
- Publisher-bearing records include `publisherId`; define trusted `UserPublisherContext` derived only by server authorization. Tool schemas must not grant unrestricted publisher selection. Future sessions validate expiry server-side, independent of eventual TTL deletion.
- Define Zod schemas/types for users, memberships, hashed session records, `bidRequested`/`bidResponse`/`bidWon` events, daily/bidder metrics, configurations and immutable history, and proposal/audit envelopes. Use UTC timestamps, explicit currency, nonnegative counters and bounded configuration fields. This phase defines shapes only, not scenario data or aggregation algorithms.
- History contract includes publisher, configuration version, timestamp, updating user ID, before/after values (or validated diff), and optional proposal/approver references. Future saves require expected-version checks and atomic current/history writes.
- Define tool name/description/input/output schemas and async execution interface with trusted context, cancellation signal, bounded output and evidence references. Declare analytics/configuration service interfaces; do not implement a tool registry or tool-calling loop.
- Streaming event union: turn-start, text-delta, tool-start/result/error, turn-complete/cancelled/error. Include correlation IDs and safe error codes; distinguish evidence/observations from hypotheses and never include private reasoning. Actual authenticated chat transport is Phase 1.
- Document metric vocabulary: auction/ad-unit opportunity identity; filled opportunities / total eligible opportunities for fill rate; bidder responses / requests for response rate; wins / requests for win rate; average winning CPM over wins; estimated revenue = sum(winning CPM / 1000). Preserve late-response eligibility and zero-denominator semantics; `bidWon` is not verified paid revenue. Exact aggregation implementation is Phase 2.

### Environment and operational commands

- `.env.example` contains placeholders for `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, table prefix, `DYNAMODB_ENDPOINT`, local-only AWS credentials, repository mode, bind ports, and session cookie/lifetime settings. Validate numeric ranges, modes, and URLs; use explicit adapters so browser code never imports server environment modules.
- Database configuration rejects nonlocal/cloud endpoints for this local-only project. Never inject model secrets through Vite variables/build args; ignore real `.env` files. Startup of the foundation does not require a working model; invoking its probe requires complete model settings.
- Model probe: server-side OpenAI SDK chat-completions request to the configured base URL. Validate streaming text and a forced harmless `probe_echo` tool call, assemble streamed arguments, validate them, execute locally, and send the tool result for a streamed continuation. Bound duration/output; distinguish authentication, network, missing streaming/tool support, and malformed protocol errors. Report capabilities without printing credentials, authorization headers, or raw private reasoning. This isolated diagnostic is not the product agent.
- Implement `db:init`, `db:verify`, `db:reset`, and `model:probe` commands through the API/command image. `db:reset` requires explicit local endpoint, table prefix and destructive confirmation; only drops/recreates this project's tables, never removes the volume automatically.
- Wire `users:bootstrap`, `data:seed`, `data:generate`, and `data:reconcile` entry points. Until their owning phases implement them, return a clear nonzero `NOT_IMPLEMENTED` message naming that phase; never claim success or silently insert data. Provide help and argument-validation smoke tests.
- Ordinary startup runs only non-destructive initialization. Do not bootstrap users, seed data, reset tables, or contact the model automatically.

## Steps

- [x] Normalize requirements location; update README/roadmap references without altering agreed scope. Mark the prematurely created Phase 1 draft as superseded by the user's Phase 0-only correction.
- [x] Pin toolchain/dependencies; create workspace manifests, package exports, strict TypeScript settings, frozen-lockfile builds, and check scripts.
- [x] Add shared schemas, metric semantics, trusted context and interface boundaries; test validation and browser/server dependency separation.
- [x] Implement DB client, table definitions, idempotent initialization, readiness, explicit reset, and persistence verification commands.
- [x] Build API health/readiness and minimal web status shells; wire production Docker images, networking, persistent volume, proxy, health checks and init dependencies.
- [x] Implement environment validation, model probe, and future command shells; verify invalid configuration and unimplemented commands fail visibly.
- [x] Add unit, real-DynamoDB integration and Playwright foundation tests runnable in existing container targets.
- [x] Write shared local runbook and concise README; capture Phase 0 verification results under this phase folder and review the exit checklist before Phase 1.

## Verification

Planned commands become runnable during implementation; they do not exist today. The runbook must give exact invocations and prerequisites.

1. **Fresh start:** copy `.env.example` to private `.env`, run `docker compose config` (do not publish interpolated secrets), then `docker compose up --build -d --wait`. Assert init exits successfully, all long-lived services are healthy, the web status page reaches the API, all three tables exist, and no users/events/configurations were inserted.
2. **Checks:** run root `build`, `typecheck`, and `test` in the API test target; integration tests use real DynamoDB Local and unique test prefixes, with cleanup restricted to test-owned resources. Test repeat init, schema mismatch, missing/unavailable database, validation, package imports, command errors, and readiness recovery.
3. **Persistence:** insert a uniquely identified verification record, restart DynamoDB/API without deleting volumes, and read it back. Repeat `db:init` and verify the record is unchanged, then delete only that record. Production-prefix tests are serial; test-created resources must not affect demo data.
4. **Reset safety:** reject reset without confirmation, foreign prefixes, and nonlocal endpoints. Verify confirmed reset only on a dedicated test prefix. Ordinary restarts and `down` without volume removal preserve data.
5. **Browser:** Playwright runs from the web test target against Compose networking; assert status rendering, same-origin API connectivity, and useful unavailable-API state. No login/chat E2E belongs to this phase.
6. **Secret isolation:** verify model key never appears in built web assets or browser network responses; use a synthetic sentinel key for automated tests. Check sanitized probe errors/logs, ignored `.env`, and server-only dependencies.
7. **Live endpoint:** with privately supplied settings, `model:probe` must demonstrate streaming text, validated tool-call dispatch and continuation. Mock tests cover chunked arguments, failed auth, incompatible endpoint, malformed tool calls and timeout. A failing live probe blocks the Phase 0 compatibility gate; health/startup remain independent.
8. **Documentation:** follow the runbook from a clean checkout using only Docker/Compose, covering init, checks, restart, diagnostics, model settings and explicitly destructive reset. No host pnpm/Node install should be required to run/check.

**Exit gate:** healthy compiled shells, initialized empty persistent resources, repeat-safe init, green foundation checks, documented commands and successful real model probe. No product authentication, agent, dataset, configuration writes or approvals have been implemented.

## Scope boundaries

Phase 1 owns credential verification, development-user bootstrap, sessions, login/chat, actual tools and tiny analytics fixtures. Phase 2 owns persisted analytics/configuration repositories, seeds and aggregation. Phase 3 owns historical generator/scenarios; Phases 4–6 own richer analytics/UI, approvals and consolidated hardening. Foundation schemas/interfaces can evolve, but later phases reuse these services and database resources rather than introducing another environment bootstrap.

## Open decisions

- Initial model is Llama served through an OpenAI-compatible API; later use of OpenAI must require only environment changes. No endpoint credentials have yet been supplied; the real-endpoint probe remains a required, explicitly pending exit gate until provided privately.
- Workspace layout, boundary contracts, command behavior, and acceptance checks are implemented. Physical database keys remain explicitly provisional.
