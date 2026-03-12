import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
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
  },
});
