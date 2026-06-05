import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("List command", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "verdikt-list-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("displays runs when they exist", async () => {
    // Create a mock run directory with summary.json
    const runDir = join(tempDir, "run-20260101-120000-abcd");
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "summary.json"),
      JSON.stringify({
        runId: "run-20260101-120000-abcd",
        taskId: "test-task",
        stopReason: "passed",
        timestamp: "2026-01-01T12:00:00Z",
        totalIterations: 2,
        totalCostUsd: 0.5,
        totalDurationMs: 10000,
      }),
    );

    // Mock config to use our temp directory
    const { setConfig } = await import("../config.js");
    setConfig({ stateDir: tempDir });

    // Capture console output
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      const { handleList } = await import("./list.js");
      await handleList();

      // Should have printed run info
      const output = logs.join("\n");
      expect(output).toContain("run-20260101-120000-abcd");
      expect(output).toContain("test-task");
      expect(output).toContain("passed");
    } finally {
      console.log = originalLog;
    }
  });

  it("displays benchmarks when they exist", async () => {
    // Create a mock benchmark directory
    const benchDir = join(tempDir, "benchmark-20260101-120000-abcd");
    await mkdir(benchDir, { recursive: true });
    await writeFile(
      join(benchDir, "benchmark.json"),
      JSON.stringify({
        benchmarkId: "benchmark-20260101-120000-abcd",
        suiteId: "test-suite",
        startedAt: "2026-01-01T12:00:00Z",
        completedAt: "2026-01-01T12:05:00Z",
        status: "completed",
        totals: { tasks: 3, passed: 2, failed: 1 },
        metrics: { successRate: 0.67 },
      }),
    );

    // Mock config
    const { setConfig } = await import("../config.js");
    setConfig({ stateDir: tempDir });

    // Capture console output
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      const { handleList } = await import("./list.js");
      await handleList();

      const output = logs.join("\n");
      expect(output).toContain("Benchmarks");
      expect(output).toContain("benchmark-20260101-120000-abcd");
    } finally {
      console.log = originalLog;
    }
  });

  it("shows message when no runs exist", async () => {
    // Mock config with empty directory
    const { setConfig } = await import("../config.js");
    setConfig({ stateDir: join(tempDir, "empty") });

    // Capture console output
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      const { handleList } = await import("./list.js");
      await handleList();

      const output = logs.join("\n");
      expect(output).toContain("No runs found");
    } finally {
      console.log = originalLog;
    }
  });
});
