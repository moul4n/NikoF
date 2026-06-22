import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Test-only config (the app build is plain `vite build` against the HTML
// entry points and needs no vite config). Unit tests for the speech playback
// bridge seams run under jsdom.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"]
  }
});
