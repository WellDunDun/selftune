import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { searchForWorkspaceRoot } from "vite";
import { defineConfig } from "vitest/config";
import packageManifest from "../../package.json";

function resolvePort(rawValue: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(rawValue ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

const vitePort = resolvePort(process.env.VITE_PORT, 5199);
const dashboardPort = resolvePort(process.env.DASHBOARD_PORT, 7888);
const packageVersion = packageManifest.version;
const spaBuildId = process.env.SELFTUNE_SPA_BUILD_ID ?? packageVersion;
const geistPackageRoot = dirname(
  createRequire(import.meta.url).resolve("@fontsource-variable/geist/package.json"),
);

export default defineConfig({
  define: {
    __SELFTUNE_PACKAGE_VERSION__: JSON.stringify(packageVersion),
    __SELFTUNE_SPA_BUILD_ID__: JSON.stringify(spaBuildId),
  },
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: vitePort,
    fs: {
      allow: [searchForWorkspaceRoot(import.meta.dirname), geistPackageRoot],
    },
    hmr: {
      host: "localhost",
      protocol: "ws",
      port: vitePort,
      clientPort: vitePort,
    },
    proxy: {
      "/api": {
        target: `http://localhost:${dashboardPort}`,
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
    testTimeout: 10000,
  },
  build: {
    outDir: "dist",
    rolldownOptions: {
      output: {
        manualChunks(id) {
          if (
            id.includes("node_modules/react/") ||
            id.includes("node_modules/react-dom/") ||
            id.includes("node_modules/react-router")
          ) {
            return "vendor-react";
          }
          if (id.includes("@tanstack/react-table") || id.includes("@dnd-kit/")) {
            return "vendor-table";
          }
          if (
            id.includes("@base-ui/react") ||
            id.includes("class-variance-authority") ||
            id.includes("clsx") ||
            id.includes("tailwind-merge") ||
            id.includes("lucide-react")
          ) {
            return "vendor-ui";
          }
        },
      },
    },
  },
});
