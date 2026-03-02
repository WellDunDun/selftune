FROM node:20-slim

# Install system deps + Bun
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip git ca-certificates && \
    curl -fsSL https://bun.sh/install | bash && \
    apt-get clean && rm -rf /var/lib/apt/lists/*
ENV PATH="/root/.bun/bin:$PATH"

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code@latest

WORKDIR /app

# Copy project
COPY . .

# Install selftune deps
RUN bun install

# Set sandbox HOME
ENV HOME=/sandbox

# Provision .claude with all 3 skills + fixture data
RUN bash tests/sandbox/provision-claude.sh /sandbox /app

RUN mkdir -p /app/tests/sandbox/results

CMD ["bun", "run", "tests/sandbox/docker/run-with-llm.ts"]
