# Phase 1 verification

## Observed results — 2026-10-13

| Check actually run                                                                                                                          | Result                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Production API Docker native Argon2id hash/correct/wrong-password check                                                                     | Passed; 211 ms for hash plus verifications                                                  |
| Docker production API/web builds, including final PostgreSQL/LangGraph/Drizzle runtime packaging                                            | Passed                                                                                      |
| Docker `pnpm build && pnpm typecheck && pnpm test && pnpm test:integration`                                                                 | Passed: **56 regression tests, 15 integration tests**                                       |
| Chromium foundation proxy/unavailable/retry/HTML fallback/narrow layout/asset privacy checks                                                | **5 passed**                                                                                |
| Chromium real isolated API → actual SDK/fake HTTP model → three real tool functions → cited answer → saved reload/Publisher B denial/logout | Passed                                                                                      |
| Chromium actual streamed request Stop/partial persistence/reload and fabricated-citation error                                              | Passed; **2 agent checks**                                                                  |
| Compiled real-Postgres checkpoint restart, explicit interrupted resume, stale-writer fencing and terminal-projection-gap recovery           | Passed; no model rerun for a durable terminal answer                                        |
| Chunk-aware nested/mismatched/unterminated reasoning suppression (1–14-character fragments)                                                 | Passed                                                                                      |
| Existing tracing SDK/OTLP privacy/lifecycle regression suite                                                                                | **11 passed** (included in regression total)                                                |
| Desktop/mobile Chromium UI renders and evidence focus/link behavior                                                                         | Passed; screenshots inspected                                                               |
| Drizzle fresh/repeated initialization and existing application v0→v1 migration                                                              | Passed                                                                                      |
| Normal local publisher/account bootstrap, repeat and actual browser logins                                                                  | Passed; see below                                                                           |
| New publisher metadata repeat/conflict-refusal self-check in owned DynamoDB tables                                                          | Passed; owned tables cleaned                                                                |
| New opt-in real model smoke                                                                                                                 | **Skipped** once: required private model-key setting missing; no live-agent success claimed |
| New live Langfuse agent trace audit                                                                                                         | Not run; tracing stayed disabled during deterministic checks                                |

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

The earlier missing-model setup limitation is superseded by the Ollama defaults and real-agent check below. Local Ollama needs no secret API key. Explicit alternate endpoints remain configurable; do not paste real provider keys into credential documentation.

## Ollama demo-default follow-up

- Missing/blank model settings now default to local Ollama `qwen3.5:9b` and non-secret SDK key `ollama`; missing/blank auth/demo-password settings use explicit public demo defaults. Existing nonblank overrides remain honored.
- This machine uses **Docker Desktop**, not native Linux Docker. API → `host.docker.internal:11434/api/tags` returned HTTP 200 and the installed model. No custom proxy is needed; an initially attempted proxy was removed after verifying the built-in bridge.
- Native `think:false` returned OK after ~67 seconds of cold loading; warm OpenAI-compatible completion returned OK in ~1 second. Product requests use supported `max_tokens` and generic configurable `reasoning_effort: none` / `temperature: 0` defaults; no model-specific branches or custom tool parser.
- Build/typecheck and all **56 regression tests** passed with the default behavior changes.
- Initial live attempts exposed intermittent provider tool-call formatting errors, stale inherited shell model settings overriding `.env`, and unnecessarily strict citation formatting. Compose now takes model overrides directly from its optional `.env` service file, so host `localhost` variables do not override Docker addressing.
- Citation handling remains provider-neutral: observations require known evidence IDs (single or comma-separated bracketed references); labelled hypotheses/recommendations need not carry artificial citations. Every cited ID must still exist. The model receives explicit valid IDs and date-only tool guidance, without provider-specific parsing or retries.
- **Real end-to-end PASS:** conversation `504966a0-a2a4-41d1-a7aa-63f930415dff` completed in **31 seconds** through `http://localhost:8080`, actual Ollama/OpenAI SDK/LangGraph and `compare_periods`. Returned $63.00 → $50.40 (-20%), fill 60% → 45%, CPM $1.50 → $1.60 with actual citations; GET reload showed `status: completed` and retained answer/evidence.
- Build/typecheck, **56 regression and 15 integration tests** passed after provider-neutral settings changes; focused checks cover hypotheses without forced citations, grouped IDs, and rejection of unknown/missing observation IDs.
- Model quality is not guaranteed: the successful question also requested configuration history, but the model chose only comparison and recommended checking history. Earlier live runs executed both comparison/history tools before citation rejection. Actual tool choice is model-driven, not a hidden deterministic script. Cold load is slow (~55–67 seconds); a native operator warmup retained the model for one hour during verification.

## Known limits

Stateless logout clears the browser cookie but cannot revoke a copied token before expiry; secret rotation invalidates all tokens. Local login throttling is single-process. Resume can replay an unfinished read-only node, not exactly-once execution or a mid-token provider stream. Evidence validation checks provenance/section support, not the truth of every model interpretation. Supported private-reasoning fields/tags are suppressed; no universal detection guarantee for arbitrary untagged provider text is claimed. No configuration editing, approvals, charts, live ingestion or historical generator was introduced.
