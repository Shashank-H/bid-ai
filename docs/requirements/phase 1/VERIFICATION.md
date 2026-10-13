# Phase 1 verification

## Observed results — 2026-10-13

| Check actually run | Result |
| --- | --- |
| Production API Docker native Argon2id hash/correct/wrong-password check | Passed; 211 ms for hash plus verifications |
| Docker production API/web builds, including final PostgreSQL/LangGraph/Drizzle runtime packaging | Passed |
| Docker `pnpm build && pnpm typecheck && pnpm test && pnpm test:integration` | Passed: **56 regression tests, 15 integration tests** |
| Chromium foundation proxy/unavailable/retry/HTML fallback/narrow layout/asset privacy checks | **5 passed** |
| Chromium real isolated API → actual SDK/fake HTTP model → three real tool functions → cited answer → saved reload/Publisher B denial/logout | Passed |
| Chromium actual streamed request Stop/partial persistence/reload and fabricated-citation error | Passed; **2 agent checks** |
| Compiled real-Postgres checkpoint restart, explicit interrupted resume, stale-writer fencing and terminal-projection-gap recovery | Passed; no model rerun for a durable terminal answer |
| Chunk-aware nested/mismatched/unterminated reasoning suppression (1–14-character fragments) | Passed |
| Existing tracing SDK/OTLP privacy/lifecycle regression suite | **11 passed** (included in regression total) |
| Desktop/mobile Chromium UI renders and evidence focus/link behavior | Passed; screenshots inspected |
| Drizzle fresh/repeated initialization and existing application v0→v1 migration | Passed |
| Normal local publisher/account bootstrap, repeat and actual browser logins | Passed; see below |
| New publisher metadata repeat/conflict-refusal self-check in owned DynamoDB tables | Passed; owned tables cleaned |
| New opt-in real model smoke | **Skipped** once: required private model-key setting missing; no live-agent success claimed |
| New live Langfuse agent trace audit | Not run; tracing stayed disabled during deterministic checks |

The investigating agent was tested: the actual OpenAI SDK SSE decoder, LangGraph graph/checkpoints and real TypeScript tool functions were exercised against a deterministic **fake model HTTP server**, not canned production answers. The fake model synthesizes the final estimated-revenue numbers from actual tool results. This verifies protocol/control/security flows, not real-model quality or latency. The earlier [audited compatibility probe](../../architecture-and-implementation/TRACING-VERIFICATION.md) is separate historical evidence.

## Commands

```sh
docker compose -f compose.yaml -f compose.test.yaml build api web
docker compose -f compose.yaml -f compose.test.yaml run --rm --no-deps api sh -lc 'pnpm build && pnpm typecheck && pnpm test && pnpm test:integration'
docker compose -f compose.yaml -f compose.test.yaml -f compose.e2e.yaml build agent-test-web
docker compose -f compose.yaml -f compose.test.yaml -f compose.e2e.yaml up -d --wait agent-test-api agent-test-web
docker compose -f compose.yaml -f compose.test.yaml -f compose.e2e.yaml run --rm --no-deps web pnpm test:e2e
docker compose -f compose.yaml -f compose.test.yaml -f compose.e2e.yaml stop agent-test-web agent-test-api
```

During debugging, only the affected agent browser checks were rerun with mounted current tests/config and the freshly built web bundle. An internal HTTP DNS name lacked `crypto.randomUUID`; a platform CSPRNG UUID fallback fixed the actual browser path without relaxing browser security. A cross-publisher hash-only navigation test was corrected to reload the application before asserting its owned-record error. Final agent checks passed in 12.4 seconds. Existing checks were not repeatedly rerun unchanged. Optional host root build initially could not find a `pnpm` shim in its child shell; supported Docker builds/typechecks passed instead.

## Database isolation and cleanup

All checks used the **same local Compose DynamoDB and PostgreSQL servers**, with unique test-owned resources—not new database services:

- Bootstrap-only smoke: `bid-test-bootstrap-<UUID>` with `-identity`, `-publisher-data`, `-workflow` tables; cleaned. The generated UUID suffix was not recorded.
- Integration: `bid-test-phase1-<suite UUID>` DynamoDB tables and `bid_test_<suite UUID>` Postgres database; cleaned by `afterAll`. Application tables are in `public`, migration tracking in `drizzle`, saver tables in `agent_checkpoints`.
- Last real-browser suite: prefix `bid-test-e2e-cfcec274e4704609ad5fa1ad11d377e3` with the same three table suffixes; Postgres database `bid_test_e2e_cfcec274e4704609ad5fa1ad11d377e3`. Test API/web were gracefully stopped and owned database/tables removed. No normal demo records were deleted.

Other focused smoke tests similarly used generated owned prefixes/databases and explicit scoped cleanup. Interrupted force-killed test processes can leave their unique resources behind; cleanup must target those recorded resources only, never the demo prefix or a wildcard.

## Normal runnable checkout

At the user's explicit request, normal `bid-*` resources—not test resources—were populated:

- `bid-identity`: two Argon2id user records, two login indexes and two publisher memberships (**6 rows**, zero authentication session records).
- `bid-publisher-data`: `PUBLISHER#publisher-a/METADATA` and `PUBLISHER#publisher-b/METADATA`; repeat-safe metadata creation refuses conflicts.
- PostgreSQL database `bid`: explicit application and official saver migrations initialized.
- Normal API/web/DynamoDB/Postgres services healthy. Chromium login/logout and public publisher assignments verified for both accounts at **http://localhost:8080**.
- Demo-only generated credentials are intentionally saved in [DEMO-ACCOUNTS.md](DEMO-ACCOUNTS.md). Only missing/blank signing/demo-password settings were added to gitignored `.env`; existing nonblank settings were preserved. No real signing/model/API/database secret was copied into documentation.
- Tiny aggregate observations remain checked-in fixtures, not a full historical DynamoDB seed. A saved demo.a smoke question confirms a visible missing-model-settings error.

To investigate with the real model, privately complete `LLM_BASE_URL`, `LLM_MODEL` and `LLM_API_KEY`, using a container-reachable URL. An explicitly unauthenticated endpoint may permit a nonempty local placeholder key. Recreate API/web after settings change; do not paste real keys into chat or credential documentation.

## Known limits

Stateless logout clears the browser cookie but cannot revoke a copied token before expiry; secret rotation invalidates all tokens. Local login throttling is single-process. Resume can replay an unfinished read-only node, not exactly-once execution or a mid-token provider stream. Evidence validation checks provenance/section support, not the truth of every model interpretation. Supported private-reasoning fields/tags are suppressed; no universal detection guarantee for arbitrary untagged provider text is claimed. No configuration editing, approvals, charts, live ingestion or historical generator was introduced.
