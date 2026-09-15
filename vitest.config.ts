import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/ui-setup.ts"],
    include: ["tests/ui-*.test.tsx"],
    coverage: {
      provider: "v8",
      thresholds: { lines: 90 },
      include: ["app/**"],
      exclude: ["app/**/*.css", "app/layout.tsx", "app/github-issue-types.ts"],
      reporter: ["text", "lcov"],
      reportsDirectory: "coverage/ui",
    },
  },
});
