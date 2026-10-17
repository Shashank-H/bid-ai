# Decision-model graph verification

Date: 2026-10-16. Scope: approved internal graph refactor; no production deployment or real configuration publication.

## Implementation notes

- Decision API is backend-only, configured with `DECISION_MODEL_*`; existing `LLM_*` selects the three specialists' shared language model.
- Read and Configuration can attach typed `complete: true` handoff metadata alongside their final native tool call. The graph waits for the actual tool result, attaches its authorized evidence/errors, then gates the specialist transition. A separate handoff-only model call remains supported but is not required.
- Code review identified that successful-checkpoint counters alone cannot enforce retry sublimits. The small additive migration `0003_decision_attempt_budgets` introduces durable specialist/decision counters and backfills old model attempts as specialist attempts. The original cumulative counter remains. Apply migrations with `postgres:init` before starting the updated API against an existing database; no conversations/configurations are reset.
- Reservations enforce six specialist attempts (with the sixth reserved for public response), three decision attempts and nine combined attempts, including provider failures and checkpoint replays. Tool limit remains twelve.
- Existing human Update draft/Publish routes and frontend event contracts are unchanged. Only the public response streams text; intermediate specialist planning/handoffs remain private.

## Checks completed

- Final full-workspace `pnpm typecheck` and `pnpm build` passed after all implementation changes. Formatting and `git diff --check` passed.
- Existing focused model/tracing checks: 26 passed.
- Direct typed-HTTP adapter smoke: in-scope, configuration, out-of-scope and uncertain decisions; invalid payload, HTTP 401/429/503 and timeout all fail closed.
- Actual LangGraph smoke with fixture repositories: investigation/citations, configuration proposal, scope rejection, clarification, and cross-role dispatch blocked before tool-start.
- Legacy checkpoint smoke using the real graph/checkpointer protocol: pending old `model` task enters the gate and completes; pending incompatible old `tool` proposal is blocked before tool events or dispatch.
- Mixed-flow smoke with actual fixture tools: compare periods, configuration history, absent-draft read, current-document read, proposal and cited final response fit six specialist calls plus three decisions.
- Durable private-budget exhaustion smoke: no extra Configuration transition, no private provider call, and the final insufficient-evidence response slot remains available.
- Decision tracing smoke: resolved-model observation, usage and key masking; a failed exporter does not alter the decision or replay the provider operation.
- Existing Phase 1 integration suite against isolated PostgreSQL/DynamoDB resources: **8 passed**, including final-source reruns. Covers real SDK/tool continuation, authorization, malformed tool arguments/citations, cancellation/resume, fencing, persisted six-specialist/three-decision/nine-total attempt counters, reservation of the final response slot after five private attempts, and migration application.
- Focused browser suites `agent.spec.ts` and `configuration-agent.spec.ts`: **20 passed / 0 failed** against final compiled API and test-source mounts. Covers existing chat/history/stream/Stop behavior, publisher isolation, gate rejection/clarification/failures, cross-role calls, handoff failure, settings/navigation, and unchanged proposal → human Update draft → human Publish behavior.
- Isolated test API/web services stopped cleanly; ordinary API/web services and retained data were not changed.

## Test-harness corrections

The initial browser run exposed optimistic-Stop timing, Chrome eviction of an SSE response during hash navigation, and too many fixture logins within the existing ten-per-minute rate limit. Helpers now wait for actual upstream start, capture short gate SSE responses before navigation eviction, and reuse test-owned sessions. Production login limits and public workflows were not weakened. The final rerun passed all twenty cases.

## Not performed

- No live JEV request or confidence calibration with customer credentials.
- No live specialist-provider quality evaluation, deployment to the ordinary API/web services, or production data migration.
