# Langfuse verification

## Live result

The configured OpenAI-compatible local model passed `model:probe` with Langfuse tracing enabled. The root output confirms all four flags: `compatible`, `streaming`, `toolCalls`, and `continuation` are `true`.

The parent independently audited the actual Langfuse observations using the official CLI—not mock outputs or only the command's trace ID.

- Trace ID: `5722c6f5403174f8ffb025d19927684d`.
- Root completion: `2026-10-13T11:17:38.796Z`.
- Model: `qwen3.5:9b`.
- Exactly five observations: one root span, three generations, and one actual echo tool execution.
- All four children reference the root; all observations have end times and no error status.
- Inputs and outputs are present for all five observations; root output records the compatibility flags rather than configuration/function arguments.

| Generation | Input tokens | Output tokens | Total |
| --- | ---: | ---: | ---: |
| `streaming-check` | 17 | 234 | 251 |
| `tool-call-check` | 283 | 156 | 439 |
| `tool-result-continuation` | 81 | 90 | 171 |

These counts come from provider usage, not local estimates. Cost maps were empty; no prices were fabricated. Scanning the returned observation payloads detected no configured credential/endpoint values or supported inline private-reasoning tags. This verifies this diagnostic run, not a guarantee about arbitrary future payloads.

## Runtime conditions

The configured model URL uses host loopback, which cannot address the host from normal Compose networking. The successful diagnostic used the rebuilt production API image through Compose with a command-local `host.docker.internal` model-hostname override, tracing enablement, a placeholder key for the user-confirmed unauthenticated endpoint, and bounded extended probe budgets. Host networking did not reach the model in this Docker Desktop/WSL setup. See [TRACING.md](TRACING.md) for the exact command.

Private `.env` was not changed. Langfuse keys alone do not enable regular application tracing; set `LANGFUSE_TRACING_ENABLED=true` explicitly for ongoing use. Configure a host-reachable model URL for normal Compose execution, or use the documented one-off host-alias diagnostic.

Earlier attempts are also present as sanitized error traces: container-loopback connection failure, default-deadline timeout, and reasoning-token exhaustion with no visible answer. These were not reported as successful compatibility results. Larger explicit budgets resolved the latter without provider-specific request changes or exporting private reasoning.

## Automated checks and review

The implementation adds actual SDK/OTLP receiver tests covering hierarchy, model/usage, privacy filtering, disabled mode, export rejection, cancellation and process lifecycle. Independent review reproduced and verified fixes for:

- External OpenTelemetry provider conflicts and sequential runtime initialization.
- Closed and unterminated inline reasoning blocks.
- SDK aggregation of empty `tool_calls` arrays without changing consumer chunks.
- CLI process exit despite a collector that trickles bytes indefinitely.
- Invocation-scoped cancellation of simultaneous same-named generations.

Final container checks passed: build, typecheck, **55 unit tests**, **8 DynamoDB integration tests**, and **5 Chromium browser tests**. The parent also independently reran build/typecheck and all 55 unit tests successfully; services remained healthy. The earlier Phase 0 verification record remains historical; this live run satisfies its formerly pending model-compatibility check for this endpoint/model.
