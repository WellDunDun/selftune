import { defineConfig } from "vitest/config";

/** Package tests are node-only and must not initialize the root Storybook/Next plugin. */
export default defineConfig({
  test: {
    environment: "node",
  },
});
