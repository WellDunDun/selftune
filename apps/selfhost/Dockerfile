# syntax=docker/dockerfile:1.7
FROM oven/bun:1.3.11 AS build

WORKDIR /build
COPY . .
RUN bun install --frozen-lockfile --ignore-scripts
RUN bun run build:dashboard
RUN mkdir -p /out && \
    bun build apps/selfhost/src/server.ts \
      --compile \
      --minify \
      --outfile /out/selftune-selfhost

FROM debian:bookworm-slim AS runtime

ARG TARGETARCH
ARG VERSION=dev
LABEL org.opencontainers.image.title="SelfTune Self-Host" \
      org.opencontainers.image.description="Local-first skill library, backup, and private sharing" \
      org.opencontainers.image.source="https://github.com/selftune-dev/selftune" \
      org.opencontainers.image.version="${VERSION}"

RUN apt-get update && \
    apt-get install --yes --no-install-recommends ca-certificates && \
    rm -rf /var/lib/apt/lists/* && \
    groupadd --gid 10001 selftune && \
    useradd --uid 10001 --gid selftune --home-dir /data --no-create-home --shell /usr/sbin/nologin selftune && \
    mkdir -p /app/dashboard /data && \
    chown -R selftune:selftune /app /data

COPY --from=build --chown=selftune:selftune /out/selftune-selfhost /usr/local/bin/selftune-selfhost
COPY --from=build --chown=selftune:selftune /build/apps/local-dashboard/dist /app/dashboard

ENV HOME=/data \
    SELFTUNE_CONFIG_DIR=/data/runtime \
    SELFTUNE_DATA_DIR=/data \
    SELFTUNE_HOST=0.0.0.0 \
    SELFTUNE_PORT=8787 \
    SELFTUNE_SPA_DIR=/app/dashboard \
    SELFTUNE_VERSION=${VERSION}

USER 10001:10001
WORKDIR /data
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=20s --timeout=5s --start-period=15s --retries=3 \
  CMD ["/usr/local/bin/selftune-selfhost", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/selftune-selfhost"]
