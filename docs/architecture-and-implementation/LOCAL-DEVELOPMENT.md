# Local development

## Runtime and prerequisites

Use Docker with a recent Compose plugin (`docker compose`). Initial builds require internet access for public container images, pinned pnpm packages and Chromium binaries. No host Node, pnpm, AWS credentials, cloud account or model service is required to start the foundation.

The repository has three workspaces:

- `apps/web`: React/Vite; a production build served by Nginx.
- `apps/api`: Fastify, server-only environment, domain/tool interfaces, local database helpers and operational commands.
- `packages/shared`: browser-safe Zod contracts compiled to ESM.

Compose starts DynamoDB Local, waits for its health check, runs non-destructive `db-init`, then starts the API and web. Web calls same-origin `/api` through the unbuffered Nginx proxy. DynamoDB is accessible from the host at `http://127.0.0.1:8000` (loopback only); containers continue to use `http://dynamodb:8000`. The named `dynamodb-data` volume stores data; normal startup never resets or seeds it.

## Start and stop

From the repository root, copy `.env.example` once for initial setup; preserve an existing private `.env`:

```sh
cp .env.example .env
# Edit .env privately. Leave model values blank until the endpoint is supplied.
docker compose config --quiet
docker compose up --build -d --wait
docker compose ps --all
```

Expected: `dynamodb`, `api`, and `web` healthy; `db-init` exited with code 0. Open `http://localhost:8080`; it should show **Ready**. Direct API health routes are `http://localhost:3000/api/health/live` and `/api/health/ready`. Readiness returns 503 when any required table is absent/unavailable and recovers on later checks; liveness is independent of the database.

```sh
docker compose stop                 # Keeps containers and volume
docker compose up -d --wait         # Start again, preserving data
docker compose down                # Removes containers/network, preserves named volume
```

Do not remove volumes as part of ordinary startup or shutdown. After source changes, rerun `up --build -d --wait`; after environment changes, recreate the affected services. Nginx resolves the API at startup: if recreating only the API changes its container address, also restart/recreate `web` (plain container restart does not normally change the address).

## Environment

`.env` is ignored by Git and excluded from Docker build contexts. Do not put secrets in `VITE_*` variables, browser source, build arguments or documentation. `docker compose config` without `--quiet` prints interpolated values, including secrets: do not publish that output.

| Setting | Default / behavior |
| --- | --- |
| `WEB_PORT`, `API_PORT` | 8080 / 3000, host bindings restricted to `127.0.0.1`; API internally listens on 3000 |
| `DYNAMODB_ENDPOINT` | `http://dynamodb:8000`; local HTTP loopback/Compose endpoints only; cloud/remote database URLs rejected |
| `TABLE_PREFIX` | `bid`; allowed format `bid` followed by optional lowercase alphanumeric hyphen-separated segments |
| `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | `local`; dummy local-only values, never real AWS credentials |
| `REPOSITORY_MODE` | `fixture` or `database`; wiring only, analytics implementations come later |
| `SESSION_COOKIE_NAME` | `bid_session`; identifier-style cookie name |
| `SESSION_LIFETIME_SECONDS` | 28800; validated range 60–604800 |
| `SESSION_COOKIE_SECURE` | `false`; accepts only `true`/`false`; sessions/login are not implemented yet |
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` | Private server-only values; all required only when running the explicit model probe |
| `LLM_TIMEOUT_MS` | 30000; probe setting accepts 1000–120000 |

Three empty tables are provisioned: `<prefix>-identity`, `<prefix>-publisher-data`, `<prefix>-workflow`. Their `PK`/`SK` keys are **provisional foundation placeholders**, not committed future access-pattern design. Session TTL uses `expiresAt`; later phase plans may evolve schemas/indexes. Init refuses incompatible existing keys/TTL and never silently deletes data to repair them.

## Run checks in existing containers

Start the base Compose environment first, then build the one-off test targets:

```sh
docker compose -f compose.yaml -f compose.test.yaml build api web
docker compose -f compose.yaml -f compose.test.yaml run --rm --no-deps api sh -lc 'pnpm build && pnpm typecheck && pnpm test && pnpm test:integration'
docker compose -f compose.yaml -f compose.test.yaml run --rm --no-deps web pnpm test:e2e
```

The test override uses distinct API/web test image tags; it does not replace running production services when used with `run --no-deps`. **Do not run `up` with the test override.** It is for one-off checks only. The web test image installs Chromium matching the pinned Playwright package; tests are headless and need no host browser. Rebuild test images after source changes.

- Unit tests cover contracts, health, environment/command failures, real-SDK mocked streaming/tool protocol and secret isolation, including an actual Vite build with a synthetic private key.
- Integration tests query real DynamoDB Local, using unique `bid-test-*` prefixes and test-owned cleanup; they never reset the configured demo prefix.
- Browser tests run against `http://web` on the Compose network and check same-origin readiness, unavailable/retry states, malformed responses, narrow layout and public responses/assets.
- Root `build`, `typecheck`, `test`, `test:integration`, and `test:e2e` scripts also exist for optional host tooling. Container execution is the supported runtime/check path.

## Database commands and persistence

All commands below use the existing API image; no extra infrastructure service is needed:

```sh
docker compose run --rm --no-deps api node dist/commands/cli.js --help
docker compose run --rm --no-deps api node dist/commands/cli.js db:init
docker compose run --rm --no-deps api node dist/commands/cli.js db:verify
```

`db:init` is repeat-safe. `db:verify` returns consistent scanned counts; a fresh foundation has three counts of 0. It is a bounded diagnostic, not a large-dataset analytics query.

To check persistence without writing demo data:

```sh
docker compose exec -T api node dist/commands/cli.js db:verify --record write
# Copy the returned token; do not reuse another record's token.
TOKEN='paste-returned-uuid-here'
docker compose restart dynamodb api
docker compose up -d --wait
docker compose exec -T api node dist/commands/cli.js db:init
docker compose exec -T api node dist/commands/cli.js db:verify --record read --token "$TOKEN"
docker compose exec -T api node dist/commands/cli.js db:verify --record delete --token "$TOKEN"
```

The read should return `present: true` after restart/re-init; delete removes only the matching verification record and returns `present: false`. If interrupted, retain the token and remove that one record after restoring the database.

### Explicit destructive reset

This deletes all data in the three configured project tables and recreates them. Use only when intentionally resetting this local dataset; it is never part of ordinary startup. Endpoint and prefix must exactly match the configured local target, with explicit confirmation. With defaults:

```sh
# DESTRUCTIVE: deletes only bid-identity, bid-publisher-data, bid-workflow.
docker compose run --rm --no-deps api node dist/commands/cli.js db:reset \
  --endpoint http://dynamodb:8000 --prefix bid --confirm 'DELETE bid'
```

If `TABLE_PREFIX` changed, replace both prefix occurrences. Missing confirmation, foreign prefixes and cloud endpoints fail before deletion. Reset does not delete the named volume or unrelated tables.

## Model compatibility: initial Llama, later OpenAI

The API uses the OpenAI SDK against a configurable OpenAI-compatible **Chat Completions** endpoint. Initial use is a Llama-based server; later OpenAI use should require only changing base URL/key/model. Configure `.env` privately, including `/v1` in `LLM_BASE_URL` if the provider requires it. An unauthenticated local server can use a nonempty dummy key if that server permits it.

The URL must be HTTP(S) without embedded credentials, query parameters or fragments. The probe makes three bounded streaming requests: text, a forced harmless `probe_echo` function call with validated arguments and actual local execution, then a tool-result continuation. It prints capability booleans or sanitized error codes, not tokens, raw prompts, provider errors or private reasoning. Support for plain non-streaming chat alone is insufficient.

```sh
# After privately configuring LLM_BASE_URL, LLM_API_KEY and LLM_MODEL in .env:
docker compose run --rm --no-deps api node dist/commands/cli.js model:probe
```

Expected successful result: `{"compatible":true,"streaming":true,"toolCalls":true,"continuation":true}`; enabled Langfuse tracing also returns a safe `traceId`. No model calls occur during startup or health checks. This diagnostic is not the product agent.

For optional server-side tracing to an existing Langfuse project, see [Langfuse tracing](TRACING.md). It covers private environment settings, named generation/tool observations, masking and bounded shutdown. An unauthenticated model can be probed with a command-local placeholder: `docker compose run --rm --no-deps -e LLM_API_KEY=local-no-auth api node dist/commands/cli.js model:probe`.

**Container-to-host networking:** `localhost`/`127.0.0.1` in the API container refers to that container, not your host. Use a reachable model-server address. Docker Desktop generally supplies `host.docker.internal`; this repository does **not** automatically map it on Linux. Linux users can use a reachable host/LAN address or create a private Compose override:

```yaml
# compose.model-host.yaml (optional user-created override)
services:
  api:
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

Then run the probe with `docker compose -f compose.yaml -f compose.model-host.yaml run --rm --no-deps api node dist/commands/cli.js model:probe` and set a matching `http://host.docker.internal:<port>/v1` URL privately. The model server must listen on an interface reachable from Docker, not only host loopback; restrict access with network/firewall/authentication settings. No local model container is added here.

**Pending acceptance gate:** real compatibility has not yet been verified against the user's Llama server because endpoint settings have not been supplied. Mock protocol tests are green, but do not substitute for this live exit check before accepting the complete foundation/Phase 1 handoff.

## Future command shells

`users:bootstrap`, `data:seed`, `data:reconcile`, and `data:generate` are wired through `node dist/commands/cli.js <command>` and root scripts. They currently return a nonzero `NOT_IMPLEMENTED` message naming their owning phase and write nothing. Use `--help`; no development users or historical dataset are created automatically.

## Diagnostics

- **Startup fails:** `docker compose ps --all` and `docker compose logs db-init api dynamodb`. Init errors block API startup; resolve configuration/schema mismatch rather than relying on automatic destructive repair. Logs are sanitized, but do not publish private environment files or interpolated Compose output.
- **Unavailable status:** check API readiness and the three database tables; the web retries every 15 seconds and offers an explicit retry. If API was recreated with a new address, restart `web`.
- **Port conflict:** adjust `WEB_PORT`/`API_PORT` in `.env` and recreate services. Defaults bind only to loopback.
- **Model probe fails:** check endpoint reachability from Docker, credentials, model name and provider streaming/function-call support. Codes distinguish authentication, network, unsupported tools/streaming, protocol, timeout and output-budget failures. Do not paste the real key into browser code or test fixtures.
- **WSL credential-helper failure on public image pull:** this environment encountered `UtilAcceptVsock` from the user's Docker credential helper. An optional isolated config avoids changing your normal Docker configuration: create `/tmp/bid-docker-config/config.json` containing `{"auths":{}}`, then prefix commands with `DOCKER_CONFIG=/tmp/bid-docker-config`. This workaround uses unauthenticated public registry pulls; use your normal authenticated config when needed.
