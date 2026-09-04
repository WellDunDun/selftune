import { expect, test } from "bun:test";

const { sanitizeRootManifest } = require("./sanitize-packed-package.cjs") as {
  sanitizeRootManifest: (manifest: Record<string, unknown>) => Record<string, unknown>;
};

test("removes registry-unresolvable bundled workspace dependencies from the final manifest", () => {
  expect(
    sanitizeRootManifest({
      name: "selftune",
      dependencies: {
        "@selftune/runtime": "1.0.0",
        effect: "4.0.0-beta.66",
      },
      bundledDependencies: ["@selftune/runtime"],
    }),
  ).toEqual({
    name: "selftune",
    dependencies: { effect: "4.0.0-beta.66" },
    bundledDependencies: ["@selftune/runtime"],
  });
});
