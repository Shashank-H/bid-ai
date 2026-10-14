# Langfuse tracing

## Scope and setup

The API uses the official Langfuse TypeScript SDK with OpenTelemetry and explicit agent generation observations. Traces go to an **existing Langfuse project**, Cloud or self-hosted; Compose does not add a Langfuse stack. Nothing is exported from the browser.

Langfuse receives **agent telemetry only**: investigation turns, model generations, tool calls, and the `model:probe` compatibility diagnostic. Application logs are not forwarded to Langfuse. HTTP/authentication, startup, database, health-check and infrastructure diagnostics stay in application/container logs. Investigation telemetry includes publisher, conversation and turn context; correlation IDs connect model failures to application diagnostics.

Set these variables privately in `.env`:

```dotenv
LANGFUSE_TRACING_ENABLED=true
LANGFUSE_BASE_URL=https://your-langfuse-instance.example
LANGFUSE_PUBLIC_KEY=your-project-public-key
LANGFUSE_SECRET_KEY=your-project-secret-key
LANGFUSE_TRACING_ENVIRONMENT=development
LANGFUSE_TIMEOUT_MS=2000
```

Tracing defaults to **disabled**. Enabled configuration requires a valid URL and both project keys. `LANGFUSE_TIMEOUT_MS` accepts 100–10000 milliseconds and bounds export/shutdown operations; it is separate from the model request deadline. Do not use `VITE_` variables, paste keys into source, or publish interpolated Compose configuration. Model credentials remain separate.

After configuring the model's base URL, model name, and API key:

```sh
docker compose build api
docker compose run --rm --no-deps api node dist/commands/cli.js model:probe
```

For the user's unauthenticated Llama endpoint, use a command-local placeholder required by the OpenAI SDK rather than changing API-key validation:

```sh
docker compose run --rm --no-deps -e LLM_API_KEY=local-no-auth \
  api node dist/commands/cli.js model:probe
```

These commands load current `.env` configuration into a new container. To update the long-running API's environment as well, recreate it with `docker compose up -d --no-deps --force-recreate api`, then restart `web` if its upstream address changed. Container-to-host connectivity requirements are described in [the local runbook](LOCAL-DEVELOPMENT.md). A model URL with `localhost` points inside a normal Compose container, not at the host. The successful live diagnostic used Docker Desktop's `host.docker.internal` alias, not host networking. For a host-local unauthenticated model, use a one-off Compose override; replace the example port/path with those of your configured model endpoint:

```sh
docker compose run --rm --no-deps \
  -e LLM_BASE_URL=http://host.docker.internal:11434/v1 \
  -e LANGFUSE_TRACING_ENABLED=true -e LLM_API_KEY=local-no-auth \
  -e LLM_TIMEOUT_MS=120000 -e LLM_PROBE_MAX_TOKENS=512 \
  -e LLM_PROBE_MAX_OUTPUT_BYTES=262144 \
  api node dist/commands/cli.js model:probe
```

This does not alter `.env` or the application's regular network isolation. Compose also correctly parses quoted `.env` values, unlike raw Docker `--env-file`. Host networking did not reach the model in this Docker Desktop/WSL setup. On Linux Docker Engine, the host alias may require the optional `host-gateway` mapping and a reachable model-server binding described in the runbook. For ongoing Compose use, configure a host-reachable model address. Setting Langfuse keys alone does not enable tracing: set `LANGFUSE_TRACING_ENABLED=true` explicitly.

Requests to the official OpenAI endpoint use `max_completion_tokens`; other compatible endpoints retain `max_tokens` for compatibility. Optional temperature and reasoning-effort parameters are sent only when explicitly configured. Provider errors identify unsupported parameters in the diagnostic metadata rather than hiding the cause behind `MODEL_INCOMPATIBLE`.

The larger diagnostic budgets above accommodate a reasoning model that otherwise consumes the default 64/128-token completion allowances without producing a visible answer. Optional `LLM_PROBE_MAX_TOKENS` accepts 64–1024 per request; `LLM_PROBE_MAX_OUTPUT_BYTES` accepts 2048–1048576 total serialized output bytes. The overall model deadline remains bounded (maximum 120000 ms). Defaults remain unchanged for lightweight models; these options do not enable reasoning export.

## Observation structure

One trace represents one compatibility-probe execution:

```text
model-compatibility-probe                 span: selected checks and result
├── streaming-check                      generation
├── tool-call-check                      generation
├── execute-probe-echo                   tool: actual local execution
└── tool-result-continuation              generation
```

Investigation turns use a `publisher-investigation` root with `investigation-model` generations and `investigation-tool` observations. A failed turn is recorded as a failure, not a successful `{ finished: true }` result.

Generation observations include the configured model, request messages and parameters, streamed results, and provider-reported usage when available. A forced tool-call turn may validly contain no text; a separate initial request verifies streaming text. The echo tool is not incorrectly nested under an LLM generation. Failures retain sanitized diagnostic context, including failure stage, endpoint/model, HTTP status, provider request ID and error type/code/parameter/message when available. Stream validation failures include the validation paths, finish reason, bounded partial output and last chunk. Streams interrupted by deadlines close their existing generation rather than creating duplicates.

No fake user IDs or sessions are attached. The environment and `feature:model-probe` tag distinguish runs. Token usage is requested with `stream_options.include_usage`; missing provider usage is **not** replaced with estimated counts. The application does not invent prices or report local Llama costs as OpenAI costs. Langfuse may calculate costs independently for models recognized by its own pricing catalog.

## Privacy and lifecycle

- Only server-side instrumentation receives project credentials. Known keys, credential-like fields, authorization values, email addresses and reasoning fields are masked before export.
- Export filtering removes raw request headers and exception events. Agent errors include redacted, bounded structured diagnostics rather than only a static error code. SDK debug logging and media uploads are disabled.
- Agent payloads can contain publisher context and tool evidence. Treat the configured Langfuse project as a destination for sensitive agent data and restrict its access appropriately. Application logs are never exported there.
- OpenTelemetry initializes before model clients are constructed. Explicit generation observations capture requests, streamed output and failures as the stream is consumed; no OpenAI auto-instrumentation duplicates them.
- Disabled tracing creates no telemetry traffic. Export failures do not change the probe result. Short-lived CLI commands flush and shut down; server shutdown also cleans up telemetry, with bounded waits.

## Verification and live audit

For failures, first inspect `docker compose logs --tail=200 api` for `model_request_failed` and `investigation_failed`. Match conversation/turn/correlation IDs with the failed agent trace. `http_request_failed`, `startup_failed`, and database diagnostics are application-only. Provider response messages and bounded stream snapshots are sanitized; API keys, cookies, authorization values and credential-bearing endpoint components must never appear.

Unit tests exercise the actual SDK/export pipeline with a local HTTP OTLP receiver: hierarchy, streaming usage, masking, error/cancellation closure, disabled mode and unavailable export destinations. Run the standard build/typecheck/unit checks from the [local runbook](LOCAL-DEVELOPMENT.md).

A passing local test is not proof of live ingestion. After running the probe, inspect its observations in the configured project. The official Langfuse CLI supports selected field groups:

```sh
# Supply Langfuse settings to this host process privately; Compose .env is not
# automatically loaded by npx. Never put keys into command arguments.
npx langfuse-cli api observations list \
  --name model-compatibility-probe --fields core,basic --limit 5 --json
```

For a particular run, filter by its trace ID and request `usage`/`io` fields only as needed. Check one root, three generations, one tool, correct parent links/model, final root result, generation completion, reported token usage, and absence of secrets/private reasoning. An unsuccessful capability probe should still leave a sanitized error trace; trace delivery and model compatibility are separate acceptance checks.

Live validation is recorded in [TRACING-VERIFICATION.md](TRACING-VERIFICATION.md). The configured model passed the streamed text/tool/continuation probe, and a live CLI audit confirmed five correctly parented observations, actual token usage, and no detected credentials or inline reasoning. Do not infer compatibility with a different model or endpoint from this run.
