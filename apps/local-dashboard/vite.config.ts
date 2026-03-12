import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5199,
    proxy: {
      "/api": {
        target: "http://localhost:7888",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/react/") || id.includes("node_modules/react-dom/") || id.includes("node_modules/react-router")) {
            return "vendor-react";
          }
          if (id.includes("@tanstack/react-table") || id.includes("@dnd-kit/")) {
            return "vendor-table";
          }
          if (id.includes("@base-ui/react") || id.includes("class-variance-authority") || id.includes("clsx") || id.includes("tailwind-merge") || id.includes("lucide-react")) {
            return "vendor-ui";
          }
        },
      },
    },
  },
});
