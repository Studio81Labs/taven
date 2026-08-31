# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.29-alpine@sha256:0c79d56aee561a1d81c63f00eee5fb5fe29279560cdc55e91425133104c7fbe6

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
  pnpm --filter @taven/admin... install --frozen-lockfile

COPY . .
ARG VITE_API_BASE_URL=http://localhost:3001
ARG VITE_APP_ENV=local
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
ENV VITE_APP_ENV=${VITE_APP_ENV}
RUN pnpm --filter @taven/admin... build

FROM ${NGINX_IMAGE} AS runtime

COPY apps/admin/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /workspace/apps/admin/dist /usr/share/nginx/html

USER 101
EXPOSE 8080
