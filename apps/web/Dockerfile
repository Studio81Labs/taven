# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e

FROM ${NODE_IMAGE} AS build

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
  pnpm --filter @taven/web... install --frozen-lockfile

COPY . .
RUN pnpm --filter @taven/web... build

FROM ${NODE_IMAGE} AS runtime

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
WORKDIR /opt/taven/web

COPY --from=build --chown=node:node /workspace/apps/web/.output ./

USER node
EXPOSE 3000
CMD ["node", "server/index.mjs"]
