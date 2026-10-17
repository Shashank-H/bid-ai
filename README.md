# Bid Intelligence

A publisher ad-ops assistant for investigating auction performance with evidence-backed findings. Synthetic earnings are **estimated revenue**; configuration changes require explicit publisher approval.

## Current capabilities

Publisher login, publisher/bidder analytics dashboards and persistent streaming investigation chat are implemented. A compact navigation rail, main dashboard and collapsible right-side agent panel share the persistent light/dark theme. Charts and paginated daily metric records use the same calculations as investigation tools. Evidence summarizes what was examined and saves exact filters; **Show in dashboard** applies them only when clicked. Agent-panel openings start unsaved chats; previous conversations are available in its history menu. Closing the panel stops browser streaming, not accepted backend work. Explicit Stop/resume remains available. Investigation tools read either labelled fixtures or publisher-scoped DynamoDB datasets, including native Prebid configuration history and bidder evidence. An explicit, one-time generator creates deterministic eight-week synthetic auction data for two publishers with five bidders each. Historical datasets are ready in `bid-publisher-data`, using one uncompressed auction item with detailed bidder outcomes; fixture and persisted browser flows have been verified. The agent uses LangGraph with internal Read, Configuration and Analysis/response specialists. A generic decision model gates entry and handoffs; JEV uses its typed HTTP API while the specialists keep the OpenAI-compatible `LLM_*` settings. Model settings stay server-side. Configuration management provides one shared draft, structured/JSON editing with a global floor and optional per-slot overrides, and immutable timestamped publications with individual pages. The publishing person is the author; agent contributions are credited as coauthor. The agent can read/compare configurations and propose draft updates for explicit approval, but cannot publish. Publishing updates stored configuration only—not a live site or historical auctions. Backtesting is deferred.

React/Fastify plus **DynamoDB Local** for users/publisher records and **PostgreSQL** for conversations/LangGraph checkpoints. Drizzle manages application SQL migrations; LangGraph's official saver manages its own schema. Authentication is stateless signed cookies—**no session data is stored in any database**. Logout clears the cookie; a copied token remains valid until expiry.

## Run

Docker with Compose is the supported runtime. Preserve an existing private `.env`:

```sh
# Initial setup only; do not overwrite an existing .env.
cp .env.example .env
# Privately set DECISION_MODEL_API_KEY in .env before using chat.
# Specialist-model defaults work with local Ollama; first install the model:
ollama pull qwen3.5:9b
docker compose build api web
docker compose up -d --wait dynamodb postgres
docker compose run --rm --no-deps api node dist/commands/cli.js db:init
docker compose run --rm --no-deps api node dist/commands/cli.js postgres:init
docker compose run --rm --no-deps api node dist/commands/cli.js users:bootstrap
docker compose up -d --wait
```

Open [localhost:8080](http://localhost:8080). API/web/DynamoDB host bindings are loopback-only; Postgres has no host port. Local demo defaults include the existing demo passwords and a public signing key; do not use these for a shared deployment. Ollama defaults to `qwen3.5:9b` with no real API key. Docker Desktop's built-in `host.docker.internal:11434` bridge reaches your local Ollama without an extra proxy or system-service changes; the first model load can take about 70 seconds. Normal startup does not seed data, migrate SQL or contact either model. Decision credentials are read lazily for chat; an unavailable or invalid decision fails closed rather than bypassing the gate. The user workflow is unchanged: review a proposal, choose **Update draft**, then separately **Publish**. See [demo accounts](docs/requirements/phase%201/DEMO-ACCOUNTS.md) for this checkout's explicitly requested **demo-only** credentials/setup status; never reuse those passwords.

For historical data, follow the [dataset runbook](docs/requirements/phase%203/RUNBOOK.md). Generation runs in a separate command image, never during startup; use `REPOSITORY_MODE=database` with the seeded `TABLE_PREFIX` only after its datasets are ready. Interrupted loads are not automatically resumed or replaced.

## Check

```sh
docker compose -f compose.yaml -f compose.test.yaml build api web
docker compose -f compose.yaml -f compose.test.yaml run --rm --no-deps api sh -lc 'pnpm build && pnpm typecheck && pnpm test && pnpm test:integration'
# Isolated real API/database/browser flow with a deterministic fake HTTP model:
docker compose -f compose.yaml -f compose.test.yaml -f compose.e2e.yaml build agent-test-web
docker compose -f compose.yaml -f compose.test.yaml -f compose.e2e.yaml up -d --wait agent-test-api agent-test-web
docker compose -f compose.yaml -f compose.test.yaml -f compose.e2e.yaml run --rm --no-deps web pnpm test:e2e
docker compose -f compose.yaml -f compose.test.yaml -f compose.e2e.yaml stop agent-test-web agent-test-api
```

See the [runbook](docs/architecture-and-implementation/LOCAL-DEVELOPMENT.md), [verification](docs/requirements/phase%201/VERIFICATION.md) and [optional tracing](docs/architecture-and-implementation/TRACING.md).

## Documentation

- [Implementation roadmap](docs/architecture-and-implementation/IMPLEMENTATION-ROADMAP.md) · [Dashboard and evidence implementation](docs/architecture-and-implementation/EVIDENCE-UX-PLAN.md)
- [Requirements](docs/requirements/Full-Requirements.md) · [Exercise brief](docs/architecture-and-implementation/Full-Coding-Task.md)
- [Configuration management](docs/requirements/phase%202/CONFIGURATION-MANAGEMENT-PLAN.md) · [Configuration verification](docs/requirements/phase%202/CONFIGURATION-MANAGEMENT-VERIFICATION.md)
- [Read-only agent plan](docs/requirements/phase%201/PLAN.md) · [Foundation plan](docs/requirements/phase%200/PLAN.md) · [Initial foundation verification](docs/requirements/phase%200/VERIFICATION.md)
- [Historical dataset plan](docs/requirements/phase%203/PLAN.md) · [Data verification / load status](docs/requirements/phase%203/DATA-VERIFICATION.md) · [Persisted browser verification](docs/requirements/phase%203/BROWSER-VERIFICATION.md)
