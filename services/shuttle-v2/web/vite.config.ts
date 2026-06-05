import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@shuttle/schema": path.resolve(__dirname, "../src/schema/api.ts"),
    },
  },
  server: {
    port: 8090,
    host: "0.0.0.0",
    // Allow Vite's dev server to serve files outside the web/ root (the
    // shared schema files live in ../src/schema/).
    fs: { allow: [path.resolve(__dirname, "..")] },
    proxy: {
      "/api": "http://localhost:8092",
      "/healthz": "http://localhost:8092",
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
