# Phase 0 verification

## Subsequent live-model verification

The formerly pending endpoint check has since passed with the configured local model. The production-image diagnostic verified streaming, actual tool execution and continuation; its live Langfuse observations were independently audited. See [the tracing verification report](../../architecture-and-implementation/TRACING-VERIFICATION.md) for the trace ID, token counts and required networking/budgets. The results below preserve the initial implementation-time record.

## Initial result

The approved foundation implementation is complete on branch `phase-0-foundation`; automated and local runtime checks pass. **Full Phase 0 exit acceptance remains pending the real Llama endpoint compatibility probe.** No live endpoint settings were supplied, and mock results are not represented as live-model verification.

The implementation follows reviewer notes: only three workspaces (`web`, `api`, `shared`); server domain/tool/database/command folders stay inside the API; DynamoDB physical keys are provisional; model configuration is provider-neutral for initial Llama and later OpenAI. No login, agent, historical dataset, configuration editing or approval workflow was implemented.

## Checks actually run

Environment: Docker 29.2.0, Compose 5.0.2, Node 24.18.0 and pnpm 10.30.3. The supported run/check path uses Docker; host builds were additionally checked during integration.

| Check                                 | Result                                                                                                                                                                                                                                   |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Requirements path normalization       | Moved byte-for-byte; no stale source-path links                                                                                                                                                                                          |
| `pnpm install --frozen-lockfile`      | Passed; exact direct dependencies and lockfile pinned                                                                                                                                                                                    |
| Root `build` and `typecheck`          | Passed on host and in API test image; compiled ESM shared/API imports passed                                                                                                                                                             |
| Root `test`                           | **43 tests passed in 7 files**, including schema validation, health/readiness recovery, configuration/CLI failures, SDK streaming/tool mocks and secret boundaries; independently rerun by parent in API test image with the same result |
| Root `test:integration`               | **8 tests passed**, real DynamoDB Local: empty initialization, session TTL, retained records on repeat init, schema/TTL mismatch refusal, unavailable readiness bounds/recovery, reset safety and scoped confirmed reset                 |
| Root `test:e2e`                       | **5 Chromium tests passed**: production same-origin API, unavailable/retry recovery, HTML fallback rejection, narrow layout/keyboard focus and assets/public response isolation                                                          |
| `docker compose config --quiet`       | Passed                                                                                                                                                                                                                                   |
| `docker compose up --build -d --wait` | Passed: web/API/DynamoDB healthy; one-shot init exited 0                                                                                                                                                                                 |
| Fresh `db:verify`                     | Three configured tables present; consistent counts 0/0/0                                                                                                                                                                                 |
| Persistence across restart            | Unique verification record survived DynamoDB/API restart and repeat init; removed using only its token afterwards                                                                                                                        |
| Explicit destructive reset safety     | Missing confirmation, foreign prefixes and cloud URLs refused; successful reset tested only against unique test-owned prefixes and preserved unrelated tables                                                                            |
| Future command placeholders           | All four exit nonzero with phase-specific `NOT_IMPLEMENTED`; no data written                                                                                                                                                             |
| Missing model configuration           | Explicit probe exits nonzero with safe `INVALID_CONFIGURATION`; normal startup remains healthy                                                                                                                                           |
| Invalid startup settings              | Invalid repository-mode environment fails with sanitized `STARTUP_FAILED`; supplied sentinel not printed                                                                                                                                 |
| Secret isolation                      | Real Vite bundle built with synthetic server key/URL contains neither; actual runtime synthetic model key absent from Chromium-fetched assets, public health responses and API logs; original environment restored                       |
| UI rendering                          | Production desktop 1280×800 and narrow 360×780 screenshots rendered with Chromium and inspected: readable hierarchy, usable controls, no clipping/overflow; screenshots kept as temporary local artifacts, not committed                 |
| Cleanup                               | Zero remaining `bid-test-*` tables; main project counts remain 0/0/0; temporary verification/visual containers removed                                                                                                                   |
| Live user model probe                 | **Pending** privately supplied base URL, API key and model name                                                                                                                                                                          |

Representative container commands executed:

```sh
docker compose up --build -d --wait
docker compose -f compose.yaml -f compose.test.yaml build api web
docker compose -f compose.yaml -f compose.test.yaml run --rm --no-deps api sh -lc 'pnpm build && pnpm typecheck && pnpm test && pnpm test:integration'
docker compose -f compose.yaml -f compose.test.yaml run --rm --no-deps web pnpm test:e2e
docker compose exec -T api node dist/commands/cli.js db:verify
```

The environment's WSL Docker credential helper failed on a public image pull. Execution used an isolated `DOCKER_CONFIG=/tmp/bid-docker-config` with empty `auths`; normal user Docker settings were not changed. This is an environment-specific workaround documented in the shared runbook.

## Exit checklist

- [x] Three-workspace compiled foundation with browser-safe contracts and reusable server boundaries.
- [x] Production web/API shells and same-origin networking healthy.
- [x] Initialized empty resources, idempotent initialization and persistent storage verified.
- [x] Explicit, scoped reset and non-silent future command wiring.
- [x] Unit, real-database and browser checks green through existing container targets.
- [x] Secret isolation, visible dependency failures and sanitized model diagnostics verified.
- [x] Shared runbook and concise README cover startup/checks/persistence/reset/model networking.
- [ ] Real configured Llama server proves streaming text, validated tool execution and tool-result continuation.

To close the remaining gate, provide endpoint settings privately and run:

```sh
docker compose run --rm --no-deps api node dist/commands/cli.js model:probe
```

Record only the safe capability summary/result here, never credentials. A failure blocks the full compatibility handoff and must be resolved with endpoint/provider configuration or a justified probe adjustment. Product authentication and the investigating agent remain Phase 1 work.

## Review and remaining limits

Independent read-only reviews of shared/database helpers, Docker/Compose, and environment/CLI/model probe reported no blocking findings. A Fastify 5 request-logging option emits a deprecation warning; it does not affect the passing checks and is not a claim of future Fastify 6 compatibility. Broader performance, product tenant authorization, real-model answer quality and later-phase workflows are outside this foundation's coverage.
