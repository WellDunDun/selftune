import { defineConfig, externalizeDepsPlugin } from "electron-vite";

const sentryDsn = process.env.SELFTUNE_DESKTOP_SENTRY_DSN ?? "";

export default defineConfig({
  main: {
    define: {
      __SELFTUNE_SENTRY_DSN__: JSON.stringify(sentryDsn),
    },
    plugins: [externalizeDepsPlugin({ exclude: ["@selftune/local", "@selftune/runtime"] })],
    build: {
      rollupOptions: {
        input: { index: "src/main/index.ts" },
        external: ["electron"],
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: "src/preload/index.ts" },
        external: ["electron"],
        output: { format: "cjs", entryFileNames: "[name].js" },
      },
    },
  },
  renderer: {
    root: "src/renderer",
    build: {
      rollupOptions: { input: { main: "src/renderer/index.html" } },
    },
  },
});
