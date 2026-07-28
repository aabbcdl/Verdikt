import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.test.ts"],
    maxWorkers: 2,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      reporter: ["text-summary", "json-summary"],
      // Floor set from the measured baseline at introduction time — ratchet
      // up as coverage grows; never lower to make a change pass.
      thresholds: {
        lines: 72,
        functions: 80,
        statements: 72,
        branches: 72,
      },
    },
  },
});
