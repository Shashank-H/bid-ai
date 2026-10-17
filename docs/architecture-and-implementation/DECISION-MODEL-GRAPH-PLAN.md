# Decision-model gated specialist graph

## Context

Replace the current general model/tool loop with three specialist roles: read-only evidence gathering, evidence-grounded analysis/response, and optional configuration assistance. Use TypeSafe.ai JEV for relevance and routing, exposed internally as the generic **decision model**, with endpoint and API key from environment variables.

This is cross-phase architecture documentation. Requirements source: `docs/requirements/Full-Requirements.md`; existing phase plans remain in their phase directories.

## Research findings and confirmed constraints

- User confirmed: this is internal graph restructuring only; do not change the existing chat/configuration user flow. Keep proposal card → human **Update draft** → separate human **Publish**, and explicit configuration navigation.
- User confirmed: fail closed if the decision model is unavailable or returns invalid output; never fall back to an ungated general model.
- JEV uses `POST https://api.typesafe.ai/v1/systemone`, bearer authentication and `{model, state, questions}`. It is a typed decision API, not an OpenAI chat-completions endpoint. Choice questions use `{type: 'choice', instructions, criteria: {option: description}}`; answers contain `choice`, `probabilities`, and `confidence` under the question ID. Responses include resolved model and token usage.
- Docs currently map `jev-latest` to `jev-1.13.0`. Keep the model ID environment-configurable; do not hard-code the moving alias resolution.
- Confidence measures concentration of the answer distribution, not verified factual truth. Small focused state is recommended; the documented 1.13 limitations warn that unrelated context reduces accuracy.
- Existing graph: `START → model ↔ tool → finalize → END`. Tool execution already persists results, remaps turn-local evidence IDs, fences execution and enforces byte/count budgets. Reuse it.
- Current runtime registry mixes analytics reads, configuration reads, explicit navigation and proposal creation. Prompt separation alone cannot enforce specialist capabilities; filter model-visible tools and enforce the same allowlists at dispatch.
- `modelRunner` streams text from every model call, so specialist output must be suppressed until the public response node. The final response must retain evidence checks and existing sections.
- `validateAnswer` currently requires the exact insufficient-evidence message if no evidence exists. Scope/clarification responses need narrow server-defined outcomes, not a global weakening of citation validation.
- Cumulative model budget is hard-coded to six in both graph and `ConversationRepository.reserveAttempt`. Adding decision calls without coordinating those limits would consume the investigation allowance or bypass budget accounting.
- Existing checkpoints may name the old `model` node; migration/resume behavior must be handled explicitly, not assumed compatible.

## Documentation reviewed

Read before finalizing this plan, on 2026-10-16:

- [Documentation index](https://docs.typesafe.ai/llms.txt), [HTTP API](https://docs.typesafe.ai/api), [Choice](https://docs.typesafe.ai/primitives/choice), [state](https://docs.typesafe.ai/concepts/state), [models](https://docs.typesafe.ai/models).
- [Intent routing](https://docs.typesafe.ai/patterns/intent-routing), [confidence](https://docs.typesafe.ai/confidence), [confidence-gated routing](https://docs.typesafe.ai/patterns/confidence-routing), [Jev 1.13 limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13).
- [LangGraph JS graph API](https://docs.langchain.com/oss/javascript/langgraph/graph-api): conditional edges select the next node; checkpoints are saved at node/super-step boundaries, so interrupted nodes can run again.
- [Langfuse instrumentation](https://langfuse.com/docs/observability/sdk/instrumentation): record custom observations and usage for non-OpenAI calls without trying to wrap them as OpenAI completions.

## Node assessment

**The three specialist roles are sound, but they should not be exactly three total graph nodes.** Retain infrastructure nodes for decisions, tool execution and final validation.

| Specialist        | Responsibility                                                                                                                         | Capabilities                                                                                                          |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Read              | Plan and execute a bounded sequence of authorized queries; gather evidence for the user's question or claim.                           | Analytics and configuration read tools only. No proposals, navigation or public answer.                               |
| Configuration     | Explain parameter tradeoffs, prepare requested configuration proposals and handle explicit configuration navigation.                   | Relevant configuration reads/comparisons, existing proposal and navigation tools. Never human approval or publishing. |
| Analysis/response | Interpret retrieved evidence, distinguish supported/contradicted/insufficient claims when applicable, and compose the public response. | No tools. Preserve Observation / Hypothesis / Recommendation and exact citations.                                     |

Read is not an infallible truth checker; the analysis node judges claims against retrieved evidence. JEV selects a permitted path; it does not calculate auction metrics, establish causation, generate a native configuration document or authorize mutations. Configuration assistance remains optional and follows the user's request, including short contextual follow-ups; do not require a new command or UI step.

## Approach

### 1. Generic decision-model adapter

Add a small native `fetch` client with Zod validation; no new SDK or generic provider framework is needed. Name internal types/functions `DecisionModelSettings`, `DecisionRunner`, and `readDecisionModelSettings`, not `Jev*`.

Backend-only environment settings:

```dotenv
DECISION_MODEL_ENDPOINT=https://api.typesafe.ai/v1/systemone
DECISION_MODEL_API_KEY=
DECISION_MODEL_NAME=jev-latest
DECISION_MODEL_TIMEOUT_MS=5000
DECISION_MODEL_MIN_CONFIDENCE=0.5
```

The endpoint is the **full evaluation URL**, not an OpenAI base URL; do not append a second path. Endpoint and API key must come from environment configuration. The existing `LLM_*` settings still select the specialist language model. Use one configured LLM with role-specific prompts/tool lists, not three new provider integrations.

- Read decision settings lazily for agent work, preserving model-independent foundation startup. Missing/invalid settings block agent execution safely rather than bypassing the gate.
- Validate URLs, reject embedded credentials/query/hash, require HTTPS outside explicit local development endpoints, and never accept a request-selected destination. Disable redirects on credential-bearing calls.
- Send `{model, state, questions}` with `Authorization: Bearer …`. Ask independent entry questions (scope and intent) in one request, as recommended by the docs.
- Use closed Choice labels with descriptions plus an uncertain option; validate expected question IDs, answer type, allowed choice, finite confidence/probabilities and consistent probability maps. Allow harmless additional response fields for forward compatibility.
- Capture resolved model and `usage.input_tokens` / `usage.output_tokens`; never use the API response as executable instructions.
- Send only the latest request, bounded relevant dialogue, current stage, permitted transitions, and compact tool/evidence metadata. Include the prior assistant proposal context for “yes”, “do that”, or “change it”. Do not transmit raw auction rows, secrets, the entire checkpoint or unrelated history. Do not enable the provider's long-context danger-zone header.

The documented `0.5` confidence floor is a starting policy, not an accuracy guarantee. Below the configured floor, do not guess or initiate configuration work. For a genuinely ambiguous in-scope request, return one concise server-template clarification through the existing chat response; do not ask for information already available from conversation context or dataset metadata. A confident out-of-scope decision returns a short scope explanation without invoking specialists. Provider failure or invalid output returns the existing safe dependency-error flow, with no automatic fallback or retries that hide budget use.

### 2. Graph and routing

```text
START → decision(entry)
          ├─ out_of_scope / clarify → fixed public response → finalize → END
          ├─ investigate → Read ↔ scoped tools
          │                    ↓ handoff complete
          │                decision(after_read)
          │                    ├─ Analysis/response
          │                    └─ Configuration ↔ scoped tools
          └─ configuration request → Configuration ↔ scoped tools
                                              ↓ handoff complete
                                         decision(after_configuration)
                                              ↓
                                       Analysis/response → finalize → END
```

- The same decision infrastructure handles entry and handoff stages. Static stage-specific allowlists constrain every choice; no arbitrary node names from the provider.
- Entry scope accepts analytics, investigations, configuration explanations/proposals/history/navigation and contextual follow-ups. Analytics requests that mention configuration causality are still investigations, not automatic edit requests. Mixed requests gather analytics evidence before configuration assistance.
- Read and Configuration use bounded specialist/tool loops; deterministic dispatch and return edges do **not** need another JEV request. Recheck JEV at semantic specialist handoffs, not every token or tool-result emission.
- Read completion returns an internal typed handoff, not a public answer. Configuration completion returns its setting-specific explanation/proposal outcome. Neither output is streamed to the user. Reuse tool results/evidence from state; do not copy an entire second conversation or synthesize new evidence IDs.
- Request additional reads inside the current specialist loop when required. On exhaustion or missing data, route the known limitations to Analysis rather than cycling specialist nodes indefinitely. At most three decision stages per turn: entry, after Read if used, after Configuration if used.
- No configuration-proposal tool on ordinary read-only paths. Allow the configuration node for settings explanations, requested recommendations, contextual proposal requests and explicit navigation, retaining current behavior and approval rules.
- Add graph version, active specialist, routing stage, intent, validated decisions, decision-call count and typed handoff fields to checkpoint state. Persist routing results so a completed gate is not needlessly rerun on ordinary resume. Never reuse another turn's decision.

### 3. Enforce capabilities and preserve the current flow

- Build per-role model tool lists from the existing registry. Also validate a call against the active role's allowlist **before** emitting `tool-start`, loading a saved execution or dispatching it. A prompt is not a permission boundary, and a `readOnly` flag alone does not distinguish navigation.
- Read includes configuration snapshots/history/comparison as needed; excludes `configuration_propose_draft` and `configuration_navigate`. Configuration gets current configuration tools. Analysis gets no tools at all; omit tool declarations rather than sending an invalid empty tools array to providers.
- Keep the existing proposal requirement to read the draft/current document, preserve exact supported fields/revision, attach authorized turn-local evidence, and use the invocation-derived idempotency key.
- Keep proposal cards → human **Update draft** → separate human **Publish** unchanged. Preserve explicit-navigation checks, revision conflicts, coauthor attribution and the distinction between stored configuration and live deployment.
- Stream `text-delta` only from Analysis or a server-defined scope/clarification response. Do not publish intermediate specialist reasoning or call `text-reset` on every private planner call. Keep existing tool events, evidence links, proposal cards and navigation events; no frontend redesign or stream-schema change is expected.
- Keep `validateAnswer` strict for investigation/configuration answers. Add a narrow server-owned response-kind branch for scope/clarification messages, validated against their fixed server-produced content; the LLM cannot select this branch to evade citations. Retain the exact insufficient-evidence answer where required.
- Preserve complete UTC dataset-date selection, synthetic-data labels, estimated revenue wording, and the rule that correlation is not proof of causation or guaranteed gains.

### 4. Budgets, resume, and observability

- Retain six specialist LLM calls total per turn, counting Analysis, and reserve a final-response slot before another specialist iteration. Retain twelve tool executions. Allow at most three additional decision calls; use a cumulative persisted external-model-attempt ceiling of nine, including failed/replayed attempts. Coordinate graph limits and `ConversationRepository.reserveAttempt` rather than maintaining conflicting hard-coded limits. Existing model-attempt storage can be reused; no schema migration is expected.
- Every external model request reserves a model attempt before calling the provider; share the existing turn deadline, authorization recheck, cancellation signal, fencing and byte budgets. Decision requests use the smaller of their configured timeout and remaining turn time.
- Preserve `saveTool` / `loadTool`, proposal idempotency and no-navigation-on-resume behavior. A replayed node may make another billed decision request if it failed before its checkpoint; count and trace that attempt rather than promising exactly-once external calls.
- Existing checkpoints can contain `model`/`tool` tasks. Retain compatibility aliases/wrappers for those names during rollout; bootstrap missing version/role fields through an entry gate before any legacy specialist or tool task can run. Validate pending legacy calls under the chosen role, reuse compatible saved results, and safely interrupt incompatible pending work rather than executing it ungated. Do not clear checkpoints or replay mutations as a migration shortcut.
- Add a provider-neutral custom generation observation alongside the existing OpenAI generation wrapper. Log gate stage, permitted/selected route, confidence, resolved model, usage, latency and safe error codes under the existing turn trace. Trace specialists by role. Disabled tracing remains a no-op and exporter failure must not change graph behavior.
- Add `DECISION_MODEL_API_KEY` to the existing diagnostics/tracing secret-redaction paths, including startup and request/turn errors. Never persist credentials or bearer headers in state, browser payloads or logs.

## Files to modify

| File                                                                                                                           | Planned change                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/agent/decision-model.ts` (new)                                                                                   | Small typed HTTP adapter, bounded gate state and response validation.                                                         |
| `apps/api/src/env.ts`                                                                                                          | Generic decision-model settings and validation.                                                                               |
| `apps/api/src/agent/graph.ts`                                                                                                  | Specialist nodes, decision handoffs, scoped dispatch checks, budgets and legacy aliases.                                      |
| `apps/api/src/agent/state.ts`                                                                                                  | Typed role/routing/handoff fields and fresh-turn defaults.                                                                    |
| `apps/api/src/agent/model.ts`                                                                                                  | Role-specific tool declarations, internal handoff output and public-only streaming.                                           |
| `apps/api/src/agent/prompt.ts`                                                                                                 | Shared scope/date constraints plus Read, Configuration and Analysis instructions.                                             |
| `apps/api/src/agent/service.ts`                                                                                                | Inject the decision runner and role-aware LLM runner, gated legacy resume, response-kind validation and final-only streaming. |
| `apps/api/src/agent/evidence.ts`                                                                                               | Retain citation checks; narrowly support fixed non-investigation outcomes.                                                    |
| `apps/api/src/domain/runtime-data.ts`, `apps/api/src/tools/registry.ts`                                                        | Expose/reuse role-specific registry selections instead of a single unrestricted model-tool list.                              |
| `apps/api/src/db/conversations.ts`                                                                                             | Centralize cumulative model-attempt limit with the graph; reuse existing storage.                                             |
| `apps/api/src/observability/tracing.ts`                                                                                        | Custom provider-neutral decision generation observations without OpenAI emulation.                                            |
| `apps/api/src/server.ts`, `apps/api/src/app.ts`                                                                                | Dependency wiring and decision-key redaction in existing diagnostic paths.                                                    |
| `.env.example`, `docs/architecture-and-implementation/LOCAL-DEVELOPMENT.md`, `docs/architecture-and-implementation/TRACING.md` | Document generic configuration, decision failure behavior and trace roles.                                                    |
| `README.md`                                                                                                                    | Briefly update implemented architecture/setup and link detailed docs; no phase report.                                        |
| `tests/e2e/agent.spec.ts`, `tests/e2e/configuration-agent.spec.ts`, relevant existing `tests/support/` provider helpers        | Extend core-flow coverage with deterministic decision responses.                                                              |

Do not change the human configuration routes, shared event contracts or frontend components unless compatibility checks reveal a concrete requirement. Keep all new cross-phase documentation in this directory. Preserve logical blank-line separation in implementation code.

## Reuse

- `buildAgentGraph` and its `guard`, `reserve`, `saveTool`, `loadTool`, evidence remapping and finalization hooks — `apps/api/src/agent/graph.ts`.
- `modelRunner`, model context/tuning/stream parsing and safe provider errors — `apps/api/src/agent/model.ts`.
- `investigationPrompt` / `coverageInstructions` — `apps/api/src/agent/prompt.ts`; share existing coverage/safety rules rather than duplicating them inconsistently.
- `validateAnswer` / `INSUFFICIENT_EVIDENCE` — `apps/api/src/agent/evidence.ts`.
- `createReadOnlyTools`, `toolsForModel` — `apps/api/src/tools/registry.ts`; `createConfigurationTools` — `apps/api/src/tools/configurations.ts`.
- `createToolDispatcher` / `dispatchTool` input/output/publisher checks — `apps/api/src/tools/dispatch.ts`.
- `ConfigurationManagement` proposal/revision/approval enforcement — `apps/api/src/domain/configuration-management.ts`; do not reimplement it inside a node.
- `ConversationRepository.reserveAttempt`, tool persistence, recent context and fenced checkpoints — `apps/api/src/db/conversations.ts`, `apps/api/src/agent/checkpointer.ts`.
- `TracingRuntime`, masking and safe diagnostics — `apps/api/src/observability/tracing.ts`, `apps/api/src/observability/diagnostics.ts`.

## Steps

- [x] Read JEV API, primitives, routing/confidence guidance and limitations before finalizing the design.
- [x] Inspect existing graph, model/prompt/state, tool registry, configuration flow, budgets, persistence and tracing.
- [x] Confirm fail-closed behavior and no user-flow changes.
- [x] Implement generic environment settings and the validated decision adapter.
- [x] Add per-role capabilities/prompts and typed internal handoffs; keep specialist output private.
- [x] Refactor the graph and service wiring; add entry/handoff gates, final response generation and fixed scope/clarification outcomes.
- [x] Preserve proposal/navigation behavior, evidence validation, persisted budgets and legacy resume compatibility.
- [x] Add redacted decision/specialist tracing and update concise setup/architecture documentation.
- [x] Run typechecks/build and focused core-flow verification below; report any live-provider checks not performed.

## Verification

During planning: no implementation, installs, application runs or tests. Implementation checks:

1. Run `pnpm typecheck` and `pnpm build`; no new unit-test suite is required.
2. Extend/run focused existing agent/configuration-agent E2E flows using deterministic decision-provider responses. Assert entry rejection invokes neither the specialist LLM nor tools; low-confidence ambiguity yields one useful clarification; invalid/timeout/auth/429/5xx decision responses stop safely without bypass.
3. Verify real investigation paths: supported claim, contradicted claim, neutral analytical question, missing evidence, tool failure, period/config-history comparison, exact turn-local citations and no unsupported causal/gain claims.
4. Verify configuration paths and short follow-ups: explain settings, read/compare versions, propose with current revision/evidence, unchanged human Update draft and Publish actions, explicit navigation only, and no automatic page changes on resume.
5. Attempt out-of-role tool calls; ensure rejection happens before tool-start/side effects. Test another publisher's references and attempted approval/publish instructions; existing code authorization must still reject them regardless of JEV output.
6. Stop/resume in each specialist and gate stage; confirm saved tool reuse, no duplicate proposals, safe handling of old `model`/`tool` checkpoints and enforcement of total budgets across retries/resumes.
7. Inspect streaming/traces: only final answer text is public; existing tool/proposal events still render; decision usage/route/confidence are traced; no API keys or private specialist handoffs leak. Repeat with tracing disabled/unavailable.
8. When environment credentials are supplied, run a small live JEV smoke check for in-scope, out-of-scope, ambiguous and contextual configuration requests. Adjust confidence/criteria using representative requests rather than treating the initial threshold as calibrated performance. Never put keys in a fixture or plan.

## Risks and exclusions

JEV adds latency and a required runtime dependency; fail-closed behavior intentionally trades availability for routing control. False relevance/intent decisions remain possible, especially with short follow-ups or excess context, so retain uncertain outcomes and representative scenario checks. Legacy checkpoint execution and cumulative budgets are the highest-risk integration points.

No new product screens, automatic configuration approval/publishing, live-site deployment, backtesting, unrestricted tool access, per-node provider framework or broad unrelated refactor. No live JEV call has been made and no API credentials were read during planning.
