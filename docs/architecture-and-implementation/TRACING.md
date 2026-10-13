# Langfuse tracing

## Scope and setup

The API uses the official Langfuse TypeScript SDK with OpenTelemetry and `observeOpenAI`. Traces go to an **existing Langfuse project**, Cloud or self-hosted; Compose does not add a Langfuse stack. Nothing is exported from the browser.

The only implemented LLM workflow is `model:probe`. Health checks, database commands, and the foundation status page do not create traces. Future chat/tool workflows should reuse `apps/api/src/observability/tracing.ts`, adding authenticated user/session and publisher context only when those features exist.

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

Generation observations include the configured model, public diagnostic messages, streamed results, and provider-reported usage when available. A forced tool-call turn may validly contain no text; a separate initial request verifies streaming text. The echo tool is not incorrectly nested under an LLM generation. Failures use sanitized error codes, and streams interrupted by deadlines close their existing generation rather than creating duplicates.

No fake user IDs or sessions are attached. The environment and `feature:model-probe` tag distinguish runs. Token usage is requested with `stream_options.include_usage`; missing provider usage is **not** replaced with estimated counts. The application does not invent prices or report local Llama costs as OpenAI costs. Langfuse may calculate costs independently for models recognized by its own pricing catalog.

## Privacy and lifecycle

- Only server-side instrumentation receives project credentials. Known keys, credential-like fields, authorization values, email addresses and reasoning fields are masked before export.
- Export filtering strips request URLs/headers, raw exception events, and unsafe status messages. Diagnostic errors are static codes, not provider response bodies or stacks. SDK debug logging and media uploads are disabled.
- These controls are defense in depth for the current public diagnostic workflow, not permission to capture arbitrary production conversations. Future features need an explicit payload allowlist and a privacy review before attaching publisher data.
- OpenTelemetry initializes before model clients are constructed. The official OpenAI wrapper captures generations; no second auto-instrumentation duplicates them.
- Disabled tracing creates no telemetry traffic. Export failures do not change the probe result. Short-lived CLI commands flush and shut down; server shutdown also cleans up telemetry, with bounded waits.

## Verification and live audit

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
