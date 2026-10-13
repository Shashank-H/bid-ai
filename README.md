# Bid Intelligence

A publisher ad-ops assistant for investigating auction performance with evidence-backed findings. Synthetic earnings are **estimated revenue**; configuration changes require explicit publisher approval.

## Current capabilities

The local foundation is implemented: a React status page, Fastify health/readiness API, persistent DynamoDB Local with repeat-safe empty-table initialization, shared TypeScript contracts, and a server-only model compatibility probe with optional Langfuse tracing. Login, chat, datasets and configuration changes are not implemented yet. The configured local model passed the live streaming/tool-call probe; [tracing verification](docs/architecture-and-implementation/TRACING-VERIFICATION.md) records the audited observations and runtime requirements.

Three pnpm workspaces: `apps/web`, `apps/api` (including domain/tools/database/commands), and `packages/shared` (browser-safe contracts). Docker Compose runs `web`, `api`, `dynamodb`, and a one-shot `db-init` job. No cloud resources or model hosting are required.

## Run

Requires Docker with Compose; no host Node/pnpm installation needed.

```sh
# Initial setup only: do not overwrite an existing private .env.
cp .env.example .env
# Keep .env private; model settings may remain blank for foundation startup.
docker compose config --quiet
docker compose up --build -d --wait
```

Open [localhost:8080](http://localhost:8080). Web/API host ports bind to loopback and can be changed in `.env`; DynamoDB is available at [localhost:8000](http://localhost:8000), also loopback-only. Ordinary startup does not load data or contact a model.

## Check

```sh
docker compose -f compose.yaml -f compose.test.yaml build api web
docker compose -f compose.yaml -f compose.test.yaml run --rm --no-deps api sh -lc 'pnpm build && pnpm typecheck && pnpm test && pnpm test:integration'
docker compose -f compose.yaml -f compose.test.yaml run --rm --no-deps web pnpm test:e2e
```

See the [local runbook](docs/architecture-and-implementation/LOCAL-DEVELOPMENT.md) for database checks, persistence, model settings, diagnostics and explicitly destructive resets. [Langfuse tracing](docs/architecture-and-implementation/TRACING.md) documents opt-in configuration, privacy controls and live trace verification.

## Documentation

- [Implementation roadmap](docs/architecture-and-implementation/IMPLEMENTATION-ROADMAP.md)
- [Requirements](docs/requirements/Full-Requirements.md) · [Exercise brief](docs/architecture-and-implementation/Full-Coding-Task.md)
- [Foundation plan](docs/requirements/phase%200/PLAN.md) · [Initial foundation verification](docs/requirements/phase%200/VERIFICATION.md)
