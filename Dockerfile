# ExponetDB Control Plane image: one image, three process roles
# (`serve`, `worker`, `gateway`) and the operator commands
# (exponetdb-docs/12-operations/deployment.md).
#
# - Base images are pinned by digest; dependencies by the frozen lockfile.
# - Bun is build tooling only; the runtime is Node.js 24.
# - The program contains no build time; the commit comes from the build
#   argument EXPONETDB_BUILD_COMMIT (CI passes the commit being built).
# - Runs as the unprivileged `node` user; no shell is needed at runtime.
# - Node runs with --liftoff-only: V8 never recompiles the PostgreSQL parser's
#   WebAssembly with its optimizing compiler, which took hundreds of MiB of
#   memory outside the heap for a large legacy history and had a 512 MiB
#   container killed; parsing is as fast (deployment.md §2a).

FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS build
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile --ignore-scripts
ARG EXPONETDB_BUILD_COMMIT=unknown
RUN bun run --cwd apps/web build
RUN EXPONETDB_BUILD_COMMIT="${EXPONETDB_BUILD_COMMIT}" bun run --cwd apps/server bundle

FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS runtime
ARG EXPONETDB_BUILD_COMMIT=unknown
ARG EXPONETDB_VERSION=0.2.0
LABEL org.opencontainers.image.title="exponetdb" \
      org.opencontainers.image.description="ExponetDB Control Plane: serve, worker and gateway from one image" \
      org.opencontainers.image.version="${EXPONETDB_VERSION}" \
      org.opencontainers.image.revision="${EXPONETDB_BUILD_COMMIT}" \
      org.opencontainers.image.licenses="LicenseRef-Proprietary" \
      org.opencontainers.image.source="https://github.com/davdxpx/ExponetDB"
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=root:root --chmod=0755 /src/apps/server/dist/bundle/ /app/
USER node
EXPOSE 8080
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "--liftoff-only", "/app/bin/exponetdb.mjs", "healthcheck"]
ENTRYPOINT ["node", "--liftoff-only", "/app/bin/exponetdb.mjs"]
CMD ["help"]
