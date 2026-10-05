# ExponetDB Control Plane image: one image, three process roles
# (`serve`, `worker`, `gateway`) and the operator commands
# (exponetdb-docs/12-operations/deployment.md).
#
# - Base images are pinned by digest; dependencies by the frozen lockfile.
# - Bun is build tooling only; the runtime is Node.js 24.
# - The program contains no build time; the commit comes from the build
#   argument EXPONETDB_BUILD_COMMIT (CI passes the commit being built).
# - Runs as the unprivileged `node` user; no shell is needed at runtime.

FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS build
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile --ignore-scripts
ARG EXPONETDB_BUILD_COMMIT=unknown
RUN EXPONETDB_BUILD_COMMIT="${EXPONETDB_BUILD_COMMIT}" bun run --cwd apps/server bundle

FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS runtime
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
  CMD ["node", "/app/bin/exponetdb.mjs", "healthcheck"]
ENTRYPOINT ["node", "/app/bin/exponetdb.mjs"]
CMD ["help"]
