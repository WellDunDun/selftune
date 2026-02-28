.PHONY: lint test check

lint:
	bunx biome check .
	bun run lint-architecture.ts

test:
	@# Run evolve.test.ts separately: its mock.module() pollutes the global module registry
	bun test $$(find tests -name '*.test.ts' ! -name 'evolve.test.ts')
	bun test tests/evolution/evolve.test.ts

check: lint test
