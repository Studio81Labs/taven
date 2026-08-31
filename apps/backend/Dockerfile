# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e

FROM ${NODE_IMAGE} AS node-base

RUN apt-get update && \
  apt-get install -y --no-install-recommends openssl && \
  rm -rf /var/lib/apt/lists/*

FROM node-base AS workspace

ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:${PATH}
WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@11.22.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/backend/package.json apps/backend/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/admin/package.json apps/admin/package.json
COPY apps/slicer-worker/package.json apps/slicer-worker/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/openapi/package.json packages/openapi/package.json
COPY packages/openapi-client/package.json packages/openapi-client/package.json
COPY packages/slicer-contracts/package.json packages/slicer-contracts/package.json
COPY packages/ui-web/package.json packages/ui-web/package.json

RUN --mount=type=cache,id=taven-pnpm-store,target=/pnpm/store \
  pnpm --filter @taven/backend... install --frozen-lockfile

COPY . .

FROM workspace AS build

RUN pnpm --filter @taven/backend... build
RUN --mount=type=cache,id=taven-pnpm-store,target=/pnpm/store \
  pnpm --config.inject-workspace-packages=true \
  --filter @taven/backend deploy --prod /opt/taven/backend && \
  source_client="$(readlink -f apps/backend/node_modules/@prisma/client)" && \
  target_client="$(readlink -f /opt/taven/backend/node_modules/@prisma/client)" && \
  cp -a \
    "$(dirname "$(dirname "${source_client}")")/.prisma" \
    "$(dirname "$(dirname "${target_client}")")/"

FROM build AS migration

WORKDIR /workspace/apps/backend
USER node
CMD ["node", "node_modules/prisma/build/index.js", "migrate", "deploy"]

FROM build AS test

CMD ["pnpm", "-C", "apps/backend", "exec", "vitest", "run"]

FROM node-base AS runtime

ENV NODE_ENV=production
WORKDIR /opt/taven/backend

COPY --from=build --chown=node:node /opt/taven/backend ./

USER node
EXPOSE 3001
CMD ["node", "dist/main.js"]
