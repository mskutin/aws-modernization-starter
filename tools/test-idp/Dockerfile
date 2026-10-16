# syntax=docker/dockerfile:1.7
# TEST ONLY identity provider (tools/test-idp) for local compose and CI — never deployed.
#
# Build context: the REPOSITORY ROOT (pnpm workspace); ignore file: tools/test-idp/.dockerignore
#   podman build --ignorefile tools/test-idp/.dockerignore -f tools/test-idp/Dockerfile \
#     -t localhost/starter-app/test-idp:local .
#
# build   : the pinned CI Node image (IMG_NODE in .gitlab/ci/images.yml); lockfile-exact install of
#           the IdP's PRODUCTION workspace closure (--filter-prod: the @starter/api devDependency of
#           the sandbox compatibility test is not built) WITHOUT lifecycle scripts; build + bundle.
# runtime : distroless Node 24 (no shell, no package manager), non-root uid 65532, only the
#           self-contained bundle (no node_modules). APP_RUNTIME is deliberately NOT set here:
#           the IdP refuses to start unless the runner sets APP_RUNTIME=local or ci.

ARG NODE_BUILD_IMAGE=docker.io/library/node:24.21.0-trixie@sha256:1278a37eb510ec1606fba0e80f554bcc941ae0b44f35ae373c4822ae7717c64d
ARG NODE_RUNTIME_IMAGE=gcr.io/distroless/nodejs24-debian13:nonroot@sha256:9eeb7f5887d0e239e78264b06f7f11d2e14be534050481803a9e4728fcdd278e

FROM ${NODE_BUILD_IMAGE} AS build
ENV CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    LEFTHOOK=0
WORKDIR /repo
RUN corepack enable pnpm
COPY . .
RUN --mount=type=cache,id=starter-pnpm-store,target=/var/cache/pnpm-store \
    pnpm install --frozen-lockfile --ignore-scripts --filter-prod "@starter/tool-test-idp..." --store-dir /var/cache/pnpm-store \
    && pnpm --filter-prod "@starter/tool-test-idp..." run build \
    && test -f tools/test-idp/dist/bundle/server.mjs && test -f tools/test-idp/dist/bundle/healthcheck.mjs

FROM ${NODE_RUNTIME_IMAGE} AS runtime
ARG VCS_REF=unknown
ARG SOURCE_URL=unknown
ARG BUILD_CREATED=1970-01-01T00:00:00Z
ARG VERSION=0.0.0-dev
LABEL org.opencontainers.image.title="starter-test-idp" \
      org.opencontainers.image.description="TEST ONLY OpenID Connect provider for local development and CI. Never deploy." \
      org.opencontainers.image.source="${SOURCE_URL}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.created="${BUILD_CREATED}" \
      org.opencontainers.image.version="${VERSION}"
ENV TEST_IDP_HOST=0.0.0.0 \
    TEST_IDP_PORT=9400
WORKDIR /app
# Root-owned, read-only for the runtime user.
COPY --from=build /repo/tools/test-idp/dist/bundle/ /app/
USER 65532:65532
EXPOSE 9400
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=10 \
  CMD ["/nodejs/bin/node", "/app/healthcheck.mjs"]
ENTRYPOINT ["/nodejs/bin/node"]
CMD ["/app/server.mjs"]
