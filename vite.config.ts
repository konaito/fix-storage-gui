import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// https://v2.tauri.app/start/frontend/vite/
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    target: "safari15",
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
