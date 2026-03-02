.PHONY: lint test check sandbox sandbox-llm sandbox-openclaw sandbox-openclaw-keep sandbox-openclaw-clean

lint:
	bunx biome check .
	bun run lint-architecture.ts

test:
	@# Run evolve.test.ts separately: its mock.module() pollutes the global module registry
	bun test $$(find tests -name '*.test.ts' ! -name 'evolve.test.ts')
	bun test tests/evolution/evolve.test.ts

sandbox:
	bun run tests/sandbox/run-sandbox.ts

sandbox-llm:
	docker compose -f tests/sandbox/docker/docker-compose.yml up --build

sandbox-openclaw:
	docker compose -f tests/sandbox/docker/docker-compose.openclaw.yml up --build

sandbox-openclaw-keep:
	KEEP_DATA=1 docker compose -f tests/sandbox/docker/docker-compose.openclaw.yml up --build

sandbox-openclaw-clean:
	docker compose -f tests/sandbox/docker/docker-compose.openclaw.yml down -v

check: lint test sandbox
