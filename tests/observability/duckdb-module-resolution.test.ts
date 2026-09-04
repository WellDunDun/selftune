import { expect, test } from "bun:test";

import {
  resolvePackagedDuckDbModule,
  resolvePackagedDuckDbModulePath,
} from "@selftune/observability/duckdb-module-resolution";

const suffix = "node_modules/@duckdb/node-api/lib/index.js";

test("prefers the explicit Desktop resource directory", () => {
  expect(
    resolvePackagedDuckDbModulePath({
      desktopResourceDirectory: "/app/resources/selftune",
      executablePath: "/managed/runtime/selftune",
      pathExists: (path) => path === `/app/resources/selftune/${suffix}`,
    }),
  ).toBe(`/app/resources/selftune/${suffix}`);
});

test("discovers DuckDB beside a packaged CLI executable without Desktop environment variables", () => {
  expect(
    resolvePackagedDuckDbModulePath({
      executablePath: "/managed/runtime/selftune",
      pathExists: (path) => path === `/managed/runtime/${suffix}`,
    }),
  ).toBe(`/managed/runtime/${suffix}`);
  expect(
    resolvePackagedDuckDbModule({
      executablePath: "/managed/runtime/selftune",
      pathExists: (path) => path === `/managed/runtime/${suffix}`,
    }),
  ).toEqual({
    modulePath: `/managed/runtime/${suffix}`,
    resourceDirectory: "/managed/runtime",
  });
});

test("falls back to normal package resolution for a source CLI", () => {
  expect(
    resolvePackagedDuckDbModulePath({
      executablePath: "/usr/local/bin/bun",
      pathExists: () => false,
    }),
  ).toBeUndefined();
});
