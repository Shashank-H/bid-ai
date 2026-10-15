FROM node:24.18.0-bookworm-slim AS workspace
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@10.30.3 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm --filter @bid/shared build && pnpm --filter @bid/api build

FROM workspace AS test
CMD ["pnpm", "test"]

FROM workspace AS production-package
RUN pnpm --filter @bid/api deploy --legacy --prod /opt/api

# Command-only compilation: private simulation/scenarios never enter the API package.
FROM workspace AS generator-build
# The host build link is not a runtime dependency; deploy supplies production modules below.
RUN pnpm data:build && rm scripts/phase-3-data/dist/node_modules

FROM node:24.18.0-bookworm-slim AS data-generator
ENV NODE_ENV=production
WORKDIR /app
COPY --from=production-package --chown=node:node /opt/api/node_modules/ ./node_modules/
COPY --from=generator-build --chown=node:node /workspace/scripts/phase-3-data/dist/ ./
COPY package.json ./package.json
RUN mkdir /output && chown node:node /output
ENV PHASE3_OUTPUT_DIR=/output
USER node
ENTRYPOINT ["node", "scripts/phase-3-data/cli.js"]
CMD ["--help"]

FROM node:24.18.0-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=production-package --chown=node:node /opt/api/ ./

USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
