FROM node:24.18.0-bookworm-slim AS workspace
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@10.30.3 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm --filter @bid/shared build && pnpm --filter @bid/web build

FROM workspace AS test
# The installed CLI selects browser binaries matching the pinned @playwright/test version.
RUN pnpm exec playwright install --with-deps chromium
CMD ["pnpm", "test:e2e"]

FROM nginx:1.28.0-alpine AS runtime
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=workspace /workspace/apps/web/dist/ /usr/share/nginx/html/

EXPOSE 80
