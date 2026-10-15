# Command build and serving-image boundary

## Build and invocation

```sh
docker compose --profile data build api web data-generator
docker compose --profile data run --rm --no-deps data-generator --help
```

The `data-generator` target in `docker/api.Dockerfile` compiles only the TypeScript command dependency graph. It reuses existing deployed API production dependencies; it does not add Prebid.js, browser tooling, or new randomness dependencies. Its entrypoint accepts `data:generate [--seed <value>]` or offline `data:verify [--seed <value>]`. Use `--no-deps` for offline verification against an already-built image.

For a host workspace with the pinned pnpm available:

```sh
pnpm data:build
pnpm data:verify
# Only after explicit resource/identity initialization and empty-data preflight:
TABLE_PREFIX=<chosen-prefix> DYNAMODB_ENDPOINT=http://localhost:8000 pnpm data:generate
```

The host command build emits into `scripts/phase-3-data/dist` and links its module resolution to the existing API workspace dependencies. The Docker build removes that host-only link and supplies deployed production modules instead. Generator output is not an API package dependency: the API package's `files: ["dist"]` deployment remains unchanged.

The Compose service belongs only to profile `data`, defaults to help, and never runs at normal startup. Its environment contains only `DYNAMODB_ENDPOINT`, `TABLE_PREFIX`, local AWS SDK settings, and `PHASE3_OUTPUT_DIR`; it has no `.env` forwarding, model keys, PostgreSQL settings, or auth secrets. Override the table prefix explicitly for isolated verification:

```sh
docker compose --profile data run --rm --no-deps \
  -e TABLE_PREFIX=bid-test-phase3-<token> data-generator data:generate
```

This is a one-time write operation, not a reset/resume command. Initialize resources and existing demo identities separately first. The command-only `phase3-output` named volume stores `/output/private-scenario-manifest-<prefix>.json`; neither API nor web mounts it. `.dockerignore` excludes these private manifests even if an operator directs output into the checkout. Do not remove the output volume as part of ordinary startup or failure handling.

Running `data:generate` in the serving API returns `GENERATOR_REQUIRED` with dedicated-image guidance and writes nothing. Public `data:reconcile` remains in the API.

## Checks executed

On 2026-10-14:

- Host shared and generator compilation plus generator/API `--noEmit` checks passed. Generator help and strict invalid-flag refusal ran successfully using the permanent output layout.
- `docker compose --profile data build api web data-generator` passed with the frozen lockfile; build context was approximately 1.02 MB.
- Resolved Compose configuration confirmed the six generator environment keys above, the `data` profile, and no private-output mount in either serving service.
- `docker compose --profile data run --rm --no-deps data-generator --help` passed and created only the empty command-output volume. No database writes occurred.
- API `data:generate` ran with `--network none`, returned status 1 and `GENERATOR_REQUIRED`.
- Both serving images passed whole-filesystem path checks for the private generator directory, manifest filename, browser harness, and pinned reference artifact (excluding virtual `/proc`, `/sys`, `/dev`).
- API `/app` inspection checked **25,737 regular files**, including **15,448 JavaScript/source-map files**. No private generator/scenario paths or `SCENARIO_MANIFEST`, `verifyScenarios`, `function generateDay`, or private-manifest markers were found. The web serving directory's six files also had no such paths/content.
- Generator-only checks confirmed compiled `cli.js` and `scenarios.js`, writable `/output`, and no copied `.env` or browser harness.
- Existing CLI regression tests passed: six tests. The parent updated obsolete placeholder expectations for implemented reconciliation and the dedicated-image redirect.

Inspected image IDs (mutable tags identify this build, not a release):

| Image                                    | ID                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------- |
| `bid-intelligence-api:latest`            | `sha256:ab8720447d62fe679cc672c6a0b0e63eef00b32a17872abfa203b34e77c680aa` |
| `bid-intelligence-web:latest`            | `sha256:10e1edddd527872e5f47f5dc54fce66ac313b96b03ab6269ff8eaef710cc90ce` |
| `bid-intelligence-data-generator:latest` | `sha256:234b73d92147f7e6c5732e762f612acc705e871da8924cbb8db83bc9575819d9` |

These are packaging/code checks, not a full database load, persisted reconciliation, browser render, or live-model verification. Those checks belong to the isolated dataset verification step.
