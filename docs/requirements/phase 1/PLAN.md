# Phase 1 — Working read-only agent (inactive draft)

> Created before the user clarified that the requested scope was Phase 0 only. This draft is not submitted for approval or implementation. Active plan: `docs/requirements/phase 0/PLAN.md`.

## Context

Deliver the roadmap's first product slice: authenticated browser chat with a real streaming model, publisher-scoped read-only tools, visible execution results, and evidence-backed findings.

Initial inspection: this repository contains documentation only. `README.md` confirms no application or infrastructure exists; the roadmap requires Phase 0 before Phase 1. The requirements currently remain at `docs/requirements/Full-Requirements.md`, not the canonical `docs/requirements/Full-Requirements.md`.

## Approach

- Preserve Phase 0 as a prerequisite rather than quietly folding infrastructure work into Phase 1. Confirm how the user wants to handle this dependency.
- Use the planned TypeScript/pnpm, React/Vite, Fastify, DynamoDB Local, and OpenAI-compatible architecture.
- Authenticate users and resolve publisher memberships in the backend; use DynamoDB-backed sessions and tiny checked-in analytics/configuration fixtures.
- Implement a bounded, cancellable streaming agent that directly invokes validated read-only tool functions. No MCP or configuration mutation.
- Refine contracts, fixture scope, security checks, UI flow, and tests after requirements review.

## Files to modify

Tentative locations, to refine against requirements and the Phase 0 handoff:

- `apps/api/`: authentication, publisher resolution, streaming agent routes and orchestration.
- `apps/web/`: login, authorized publisher selection, chat and tool results.
- `packages/contracts/`, `packages/tools/`, `packages/domain/`, `packages/db/`: schemas, read-only tool functions, fixture services, user/session persistence.
- `tools/data/`: explicit development-user bootstrap and tiny demo fixtures.
- `tests/`: security, streaming, model/tool contracts and browser checks.
- `README.md`: update current capabilities and execution instructions when implemented.
- `docs/requirements/phase 1/`: phase-specific plan and demo documentation.

## Reuse

- `docs/architecture-and-implementation/IMPLEMENTATION-ROADMAP.md`: Phase 1 scope, architecture, and exit gate.
- `docs/requirements/Full-Requirements.md`: requirements source pending Phase 0 path normalization.
- No existing application functions, utilities, or tests are present.

## Steps

- [ ] Resolve missing Phase 0 prerequisite and inspect full requirements.
- [ ] Define authentication/session and authorized publisher flow.
- [ ] Define tiny fixtures, metric semantics, tool schemas, and evidence references.
- [ ] Implement bounded model/tool orchestration and streaming lifecycle.
- [ ] Build minimal login/chat UI with cancellation and readable tool status/results.
- [ ] Verify isolation, errors, endpoint compatibility, and end-to-end investigation.

## Verification

- Automated authentication/session and cross-publisher authorization tests.
- Mock-model tests covering actual tool dispatch, validation, budgets, cancellation, streaming and failures.
- Browser login → question → multiple tools → evidence-backed streamed answer → logout.
- Opt-in real-endpoint smoke test for streaming and tool calling.
- Confirm no model credentials or raw chain-of-thought reach the browser, no mutation tools are exposed, and fixture revenue is labeled estimated.

## Open decisions

- User chose to plan Phase 0 first. This Phase 1 skeleton is deferred until the foundation is planned and implemented; the active plan is `docs/requirements/phase 0/PLAN.md`.
