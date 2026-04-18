import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 8090,
    host: "0.0.0.0",
    proxy: {
      "/api": "http://localhost:8091",
    },
  },
  build: { outDir: "dist" },
});
