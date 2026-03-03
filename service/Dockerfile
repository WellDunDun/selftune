FROM oven/bun:1-alpine

WORKDIR /app

# Copy package files
COPY package.json bun.lock* ./

# Install dependencies (if any)
RUN bun install --production --frozen-lockfile 2>/dev/null || true

# Copy source
COPY cli/selftune/badge/ cli/selftune/badge/
COPY cli/selftune/types.ts cli/selftune/types.ts
COPY service/ service/

# Create data directory for SQLite
RUN mkdir -p /data

ENV PORT=8080
ENV DB_PATH=/data/selftune.db

EXPOSE 8080

CMD ["bun", "run", "service/server.ts"]
