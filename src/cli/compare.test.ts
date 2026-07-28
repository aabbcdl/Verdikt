import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetConfig, setConfig } from "../config.js";

describe("Compare command", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "verdikt-compare-test-"));
    setConfig({ stateDir: join(tempDir, ".verdikt") });
  });

  afterEach(async () => {
    resetConfig();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("fails when no run IDs provided", async () => {
    const { handleCompare } = await import("./compare.js");

    const mockExit = (code: number) => {
      throw new Error(`Process exited with code ${code}`);
    };
    const originalExit = process.exit;
    process.exit = mockExit as typeof process.exit;

    try {
      await expect(handleCompare([])).rejects.toThrow("Process exited with code 1");
    } finally {
      process.exit = originalExit;
    }
  });

  it("fails when only one run ID provided", async () => {
    const { handleCompare } = await import("./compare.js");

    const mockExit = (code: number) => {
      throw new Error(`Process exited with code ${code}`);
    };
    const originalExit = process.exit;
    process.exit = mockExit as typeof process.exit;

    try {
      await expect(handleCompare(["run-001"])).rejects.toThrow("Process exited with code 1");
    } finally {
      process.exit = originalExit;
    }
  });

  it("fails when first run not found", async () => {
    const { handleCompare } = await import("./compare.js");

    const mockExit = (code: number) => {
      throw new Error(`Process exited with code ${code}`);
    };
    const originalExit = process.exit;
    process.exit = mockExit as typeof process.exit;

    try {
      await expect(handleCompare(["nonexistent-1", "nonexistent-2"])).rejects.toThrow(
        "Process exited with code 1",
      );
    } finally {
      process.exit = originalExit;
    }
  });

  it("compares saved run summaries using total iteration counts", async () => {
    const stateDir = join(tempDir, ".verdikt");
    const run1Dir = join(stateDir, "run-compare-001");
    const run2Dir = join(stateDir, "run-compare-002");
    await mkdir(run1Dir, { recursive: true });
    await mkdir(run2Dir, { recursive: true });
    await writeFile(
      join(run1Dir, "summary.json"),
      JSON.stringify({
        taskId: "task-a",
        stopReason: "max_iterations",
        totalIterations: 1,
        totalCostUsd: 0.1,
        totalDurationMs: 1000,
      }),
      "utf-8",
    );
    await writeFile(
      join(run2Dir, "summary.json"),
      JSON.stringify({
        taskId: "task-a",
        stopReason: "passed",
        totalIterations: 3,
        totalCostUsd: 0.3,
        totalDurationMs: 2000,
      }),
      "utf-8",
    );

    const { handleCompare } = await import("./compare.js");
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    try {
      await handleCompare(["run-compare-001", "run-compare-002"]);
    } finally {
      console.log = originalLog;
    }

    const output = logs.join("\n");
    expect(output).toContain("Iterations");
    expect(output).toContain("1");
    expect(output).toContain("3");
    expect(output).toContain("+2");
    expect(output).not.toContain("undefined");
    expect(output).not.toContain("NaN");
  });

  it("shows unknown and partial costs without claiming zero", async () => {
    const stateDir = join(tempDir, ".verdikt");
    const run1Dir = join(stateDir, "run-cost-unknown");
    const run2Dir = join(stateDir, "run-cost-partial");
    await mkdir(run1Dir, { recursive: true });
    await mkdir(run2Dir, { recursive: true });
    await writeFile(
      join(run1Dir, "summary.json"),
      JSON.stringify({ taskId: "task", stopReason: "passed" }),
      "utf-8",
    );
    await writeFile(
      join(run2Dir, "summary.json"),
      JSON.stringify({
        taskId: "task",
        stopReason: "passed",
        totalCostUsd: 0.25,
        usageStatus: "partial",
      }),
      "utf-8",
    );

    const { handleCompare } = await import("./compare.js");
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      await handleCompare(["run-cost-unknown", "run-cost-partial"]);
    } finally {
      console.log = originalLog;
    }

    const output = logs.join("\n");
    expect(output).toContain("unknown");
    expect(output).toContain("$0.2500+");
    expect(output).toContain("n/a");
    expect(output).not.toContain("$0.0000");
  });

  it("rejects run IDs that try to read summaries outside the state directory", async () => {
    const outsideRun1 = join(tempDir, "outside-1");
    const outsideRun2 = join(tempDir, "outside-2");
    await mkdir(outsideRun1, { recursive: true });
    await mkdir(outsideRun2, { recursive: true });
    await writeFile(
      join(outsideRun1, "summary.json"),
      JSON.stringify({ stopReason: "passed", totalIterations: 1, totalDurationMs: 1 }),
      "utf-8",
    );
    await writeFile(
      join(outsideRun2, "summary.json"),
      JSON.stringify({ stopReason: "passed", totalIterations: 1, totalDurationMs: 1 }),
      "utf-8",
    );

    const { handleCompare } = await import("./compare.js");

    const mockExit = (code: number) => {
      throw new Error(`Process exited with code ${code}`);
    };
    const originalExit = process.exit;
    process.exit = mockExit as typeof process.exit;

    try {
      await expect(handleCompare(["../outside-1", "../outside-2"])).rejects.toThrow(
        "Process exited with code 1",
      );
    } finally {
      process.exit = originalExit;
    }
  });
});
