# syntax=docker/dockerfile:1.7
# @starter/api container image.
#
# Build context: the REPOSITORY ROOT (pnpm workspace); ignore file: apps/api/.dockerignore
#   podman build  --ignorefile apps/api/.dockerignore -f apps/api/Dockerfile -t localhost/starter/api .
#   buildah build --ignorefile apps/api/.dockerignore -f apps/api/Dockerfile -t localhost/starter/api .
# CI builds it rootless with Buildah (tools/ci/scripts/container-build.sh) and passes
# VCS_REF / SOURCE_URL / BUILD_CREATED / VERSION for the OCI labels.
#
# build   : Node 24 LTS slim + pnpm pinned by package.json "packageManager"; install the
#           API's workspace closure from pnpm-lock.yaml, build it, `pnpm deploy --prod`.
# runtime : distroless Node 24 (no shell, no package manager), non-root uid 65532,
#           node is PID 1 and receives SIGTERM directly (exec-form ENTRYPOINT).
# Base images are pinned by version + multi-arch index digest (linux/arm64 + amd64);
# supply-chain:lint fails the pipeline if a FROM is not digest-pinned.

ARG NODE_BUILD_IMAGE=docker.io/library/node:24.21.0-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66
ARG NODE_RUNTIME_IMAGE=gcr.io/distroless/nodejs24-debian13:nonroot@sha256:9eeb7f5887d0e239e78264b06f7f11d2e14be534050481803a9e4728fcdd278e

FROM ${NODE_BUILD_IMAGE} AS build
ENV CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    LEFTHOOK=0
WORKDIR /repo
RUN corepack enable pnpm
COPY . .
# Lockfile-exact install of @starter/api and its workspace dependencies only, with NO
# lifecycle scripts (no root `prepare`/git hooks, no dependency install scripts:
# esbuild resolves its platform binary package without its postinstall); build them;
# then materialise a production-only deployment (dist, migrations, prod node_modules).
RUN --mount=type=cache,id=starter-pnpm-store,target=/var/cache/pnpm-store \
    pnpm install --frozen-lockfile --ignore-scripts --filter "@starter/api..." --store-dir /var/cache/pnpm-store \
    && pnpm --filter "@starter/api..." run build \
    && pnpm --filter @starter/api deploy --prod --ignore-scripts --store-dir /var/cache/pnpm-store /out \
    && test -f /out/dist/server.js && test -f /out/dist/healthcheck.js && test -f /out/dist/migrate.js \
    && test -f /out/dist/db-bootstrap.js && test -f /out/dist/retention.js \
    && test -s /repo/packages/db/certs/rds-global-bundle.pem

FROM ${NODE_RUNTIME_IMAGE} AS runtime
ARG NODE_RUNTIME_IMAGE
ARG VCS_REF=unknown
ARG SOURCE_URL=unknown
ARG BUILD_CREATED=1970-01-01T00:00:00Z
ARG VERSION=0.0.0-dev
LABEL org.opencontainers.image.title="starter-api" \
      org.opencontainers.image.description="AWS modernization starter REST API (Fastify on Node.js 24)" \
      org.opencontainers.image.source="${SOURCE_URL}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.created="${BUILD_CREATED}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.base.name="${NODE_RUNTIME_IMAGE}"
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app
# Root-owned, read-only for the runtime user: the process cannot modify its own code.
COPY --from=build /out/ /app/
# Amazon RDS CA bundle: the ONLY trust anchors for DB_SSL=verify-full on AWS
# (DB_SSL_ROOT_CERT=/app/certs/rds-global-bundle.pem; packages/db/certs/README.md, ADR 0222).
COPY --from=build /repo/packages/db/certs/rds-global-bundle.pem /app/certs/rds-global-bundle.pem
USER 65532:65532
EXPOSE 8080
STOPSIGNAL SIGTERM
# Docker-format images keep this; OCI-format builds (Podman/Buildah default) drop it,
# so ECS task definitions and compose declare the same check explicitly.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["/nodejs/bin/node", "dist/healthcheck.js"]
ENTRYPOINT ["/nodejs/bin/node"]
# One-off tasks, same image: ["dist/db-bootstrap.js"] (roles, break-glass), ["dist/migrate.js", "up"],
# ["dist/retention.js"] (disabled unless RETENTION_MODE is set)
CMD ["dist/server.js"]
