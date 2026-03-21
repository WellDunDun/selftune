.PHONY: all clean lint test test-fast test-slow check typecheck-dashboard sandbox sandbox-install sandbox-llm sandbox-shell sandbox-shell-empty sandbox-reset sandbox-openclaw sandbox-openclaw-keep sandbox-openclaw-clean clean-branches

all: check

clean: sandbox-openclaw-clean

lint:
	bunx biome check .
	bun run lint-architecture.ts

test:
	@# Run evolve.test.ts separately: its mock.module() pollutes the global module registry
	bun test $$(find tests -name '*.test.ts' ! -name 'evolve.test.ts')
	bun test tests/evolution/evolve.test.ts

test-fast:
	@# Fast unit tests only — excludes mock.module() tests and integration tests (~10s vs ~80s)
	bun test $$(find tests -name '*.test.ts' ! -name 'evolve.test.ts' ! -name 'integration.test.ts' ! -name 'dashboard-server.test.ts' ! -path '*/blog-proof/*')

test-slow:
	@# Integration and mock.module() tests only
	bun test tests/evolution/evolve.test.ts tests/evolution/integration.test.ts tests/monitoring/integration.test.ts tests/dashboard/dashboard-server.test.ts

sandbox:
	bun run tests/sandbox/run-sandbox.ts

sandbox-install:
	bun run tests/sandbox/run-install-sandbox.ts

sandbox-llm:
	docker compose -f tests/sandbox/docker/docker-compose.yml up --build

sandbox-shell:
	docker compose -f tests/sandbox/docker/docker-compose.yml run --build selftune-sandbox bash

sandbox-shell-empty:
	docker compose -f tests/sandbox/docker/docker-compose.yml run --build -e SKIP_PROVISION=1 selftune-sandbox bash

sandbox-reset:
	-docker ps -aq --filter label=com.docker.compose.project=docker --filter label=com.docker.compose.service=selftune-sandbox | xargs docker rm -f
	docker compose -f tests/sandbox/docker/docker-compose.yml down -v

sandbox-openclaw:
	docker compose -f tests/sandbox/docker/docker-compose.openclaw.yml up --build

sandbox-openclaw-keep:
	KEEP_DATA=1 docker compose -f tests/sandbox/docker/docker-compose.openclaw.yml up --build

sandbox-openclaw-clean:
	docker compose -f tests/sandbox/docker/docker-compose.openclaw.yml down -v

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

typecheck-dashboard:
	cd apps/local-dashboard && bunx tsc --noEmit

check: lint typecheck-dashboard test sandbox
