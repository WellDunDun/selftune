.PHONY: all clean lint lint-fix format format-check test test-fast test-slow check typecheck-dashboard dev dev-server dev-dashboard sandbox sandbox-install sandbox-llm sandbox-shell sandbox-shell-empty sandbox-shell-empty-workspace sandbox-reset sandbox-reset-state sandbox-openclaw sandbox-openclaw-keep sandbox-openclaw-clean clean-branches

SANDBOX_CLI_VERSION := $(subst .,-,$(shell node -p "require('./package.json').version"))
SANDBOX_DATE_STAMP := $(shell date +%Y-%m-%d-%H%M%S)

# ── Slow tests that must run in isolation ──────────────────────────────
# evolve.test.ts: mock.module() pollutes global module registry
# integration.test.ts: LLM-dependent, long-running
# dashboard-server.test.ts: spins up real HTTP server
# blog-proof/*: content validation, not unit tests
SLOW_TESTS := tests/evolution/evolve.test.ts tests/evolution/integration.test.ts tests/monitoring/integration.test.ts tests/dashboard/dashboard-server.test.ts

all: check

clean: sandbox-openclaw-clean

# ── Lint & Format ──────────────────────────────────────────────────────

lint:
	bunx oxlint
	bunx oxfmt --check
	bun run lint-architecture.ts

lint-fix:
	bunx oxlint --fix
	bunx oxfmt

format:
	bunx oxfmt

format-check:
	bunx oxfmt --check

# ── Tests ──────────────────────────────────────────────────────────────

test:
	@# Run evolve.test.ts separately: its mock.module() pollutes the global module registry
	bun test $$(find tests -name '*.test.ts' ! -name 'evolve.test.ts')
	bun test tests/evolution/evolve.test.ts

test-fast:
	@# Fast unit tests only (~10s) — excludes mock.module(), integration, and blog-proof tests
	bun test $$(find tests -name '*.test.ts' ! -name 'evolve.test.ts' ! -name 'integration.test.ts' ! -name 'dashboard-server.test.ts' ! -path '*/blog-proof/*')

test-slow:
	@# Integration and mock.module() tests only (~80s)
	bun test $(SLOW_TESTS)

# ── Typecheck & Full Check ─────────────────────────────────────────────

typecheck-dashboard:
	cd apps/local-dashboard && bunx tsc --noEmit

check: lint typecheck-dashboard test sandbox

# ── Development ────────────────────────────────────────────────────────

dev:
	@trap 'kill 0' EXIT; \
	bun --watch run cli/selftune/dashboard-server.ts --port 7888 --runtime-mode dev-server & \
	sleep 1 && cd apps/local-dashboard && bunx vite --strictPort

dev-server:
	bun --watch run cli/selftune/dashboard-server.ts --port 7888 --runtime-mode dev-server

dev-dashboard:
	bun run cli/selftune/index.ts dashboard --port 7888 --no-open

# ── Sandbox ────────────────────────────────────────────────────────────

sandbox:
	bun run tests/sandbox/run-sandbox.ts

sandbox-install:
	bun run tests/sandbox/run-install-sandbox.ts

sandbox-llm:
	docker compose -f tests/sandbox/docker/docker-compose.yml up --build

sandbox-shell:
	docker compose -f tests/sandbox/docker/docker-compose.yml run --build --name selftune-sandbox-v$(SANDBOX_CLI_VERSION)-$(SANDBOX_DATE_STAMP)-shell selftune-sandbox bash

sandbox-shell-empty:
	docker compose -f tests/sandbox/docker/docker-compose.yml run --build --name selftune-sandbox-v$(SANDBOX_CLI_VERSION)-$(SANDBOX_DATE_STAMP)-empty -e SKIP_PROVISION=1 selftune-sandbox bash

sandbox-shell-empty-workspace:
	docker compose -f tests/sandbox/docker/docker-compose.yml run --build --name selftune-sandbox-v$(SANDBOX_CLI_VERSION)-$(SANDBOX_DATE_STAMP)-workspace -e SKIP_PROVISION=1 selftune-sandbox bash /app/tests/sandbox/docker/prepare-workspace-selftune.sh

sandbox-reset:
	-docker ps -aq --filter label=com.docker.compose.project=docker --filter label=com.docker.compose.service=selftune-sandbox | xargs docker rm -f
	docker compose -f tests/sandbox/docker/docker-compose.yml down -v

sandbox-reset-state:
	docker compose -f tests/sandbox/docker/docker-compose.yml run --name selftune-sandbox-v$(SANDBOX_CLI_VERSION)-$(SANDBOX_DATE_STAMP)-reset-state -e SKIP_PROVISION=1 selftune-sandbox bash /app/tests/sandbox/docker/reset-sandbox-state.sh

sandbox-openclaw:
	docker compose -f tests/sandbox/docker/docker-compose.openclaw.yml up --build

sandbox-openclaw-keep:
	KEEP_DATA=1 docker compose -f tests/sandbox/docker/docker-compose.openclaw.yml up --build

sandbox-openclaw-clean:
	docker compose -f tests/sandbox/docker/docker-compose.openclaw.yml down -v

# ── Cleanup ────────────────────────────────────────────────────────────

clean-branches:
	@echo "Pruning remote tracking refs..."
	git fetch --prune
	@echo "Deleting local custom/prefix/router-* branches..."
	-git branch --list 'custom/prefix/router-*' | xargs git branch -D 2>/dev/null
	@echo "Deleting local selftune/evolve/test-skill-* branches..."
	-git branch --list 'selftune/evolve/test-skill-*' | xargs git branch -D 2>/dev/null
	@echo "Deleting local worktree-agent-* branches..."
	-git branch --list 'worktree-agent-*' | xargs git branch -D 2>/dev/null
	@echo "Branch cleanup complete."
	@git branch | wc -l | xargs -I{} echo "{} branches remaining"
