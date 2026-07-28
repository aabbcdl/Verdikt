import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskSpec } from "../types.js";

const supervisorTasks: TaskSpec[] = [];
let supervisorResult = {
  reason: "passed",
  runId: "run-benchmark-mock",
  iterations: [],
  totalCostUsd: 0,
  totalDurationMs: 0,
  integritySummary: { status: "ok", criticalCount: 0, warningCount: 0, issues: [] },
};

vi.mock("../loop/supervisor.js", () => ({
  runSupervisorLoop: vi.fn(async (task: TaskSpec) => {
    supervisorTasks.push(JSON.parse(JSON.stringify(task)));
    return JSON.parse(JSON.stringify(supervisorResult));
  }),
}));

let tempDir: string;

beforeEach(async () => {
  supervisorTasks.length = 0;
  supervisorResult = {
    reason: "passed",
    runId: "run-benchmark-mock",
    iterations: [],
    totalCostUsd: 0,
    totalDurationMs: 0,
    integritySummary: { status: "ok", criticalCount: 0, warningCount: 0, issues: [] },
  };
  tempDir = await mkdtemp(join(tmpdir(), "verdikt-benchmark-runner-"));
});

afterEach(async () => {
  const { resetConfig } = await import("../config.js");
  resetConfig();
  await rm(tempDir, { recursive: true, force: true });
});

describe("benchmark runner", () => {
  it("rejects benchmark suites whose tasks field is not an array", async () => {
    const suitePath = join(tempDir, "bad-suite.json");
    await writeFile(
      suitePath,
      JSON.stringify({
        id: "bad-suite",
        tasks: { id: "task-1", taskFile: "task.json" },
      }),
      "utf-8",
    );

    const { loadSuite } = await import("./runner.js");

    expect(() => loadSuite(suitePath)).toThrow("Suite tasks must be an array");
  });

  it("rejects benchmark task IDs that could escape the evidence output folder", async () => {
    const suitePath = join(tempDir, "bad-task-id.json");
    await writeFile(
      suitePath,
      JSON.stringify({
        id: "bad-suite",
        tasks: [{ id: "../outside", taskFile: "task.json" }],
      }),
      "utf-8",
    );

    const { loadSuite } = await import("./runner.js");

    expect(() => loadSuite(suitePath)).toThrow("Task 1 id must be a safe folder name");
  });

  it("resolves suite-local relative task files before running", async () => {
    const taskPath = join(tempDir, "task.json");
    const suitePath = join(tempDir, "suite.json");
    await writeTask(taskPath);
    await writeFile(
      suitePath,
      JSON.stringify({
        id: "suite-local",
        tasks: [{ id: "task-1", taskFile: "task.json" }],
      }),
      "utf-8",
    );

    const { loadSuite, runBenchmark } = await import("./runner.js");
    const suite = loadSuite(suitePath);

    await runBenchmark(suite, { outDir: join(tempDir, "out") });

    expect(supervisorTasks[0].id).toBe("task-1");
  });

  it("applies benchmark max iteration and budget defaults to task files", async () => {
    const taskPath = join(tempDir, "task-with-defaults.json");
    await writeTask(taskPath, { maxIterations: undefined, maxBudgetUsd: undefined });

    const { runBenchmark } = await import("./runner.js");

    await runBenchmark(
      {
        id: "defaults-suite",
        defaults: { maxIterations: 3, budgetUsd: 1.25 },
        tasks: [{ id: "task-1", taskFile: taskPath }],
      },
      { outDir: join(tempDir, "out") },
    );

    expect(supervisorTasks[0].maxIterations).toBe(3);
    expect(supervisorTasks[0].maxBudgetUsd).toBe(1.25);
  });

  it("copies saved run artifacts without copying the isolated workspace", async () => {
    const stateDir = join(tempDir, "state");
    const sourceRunDir = join(stateDir, "run-benchmark-mock");
    const outDir = join(tempDir, "out");
    const taskPath = join(tempDir, "task.json");
    await mkdir(join(sourceRunDir, "workspace", "src"), { recursive: true });
    await mkdir(join(sourceRunDir, "evidence"), { recursive: true });
    await writeFile(join(sourceRunDir, "summary.json"), JSON.stringify({ stopReason: "passed" }));
    await writeFile(join(sourceRunDir, "evidence", "iteration-0.patch"), "diff --git\n");
    await writeFile(join(sourceRunDir, "workspace", "src", "large.ts"), "export const x = 1;\n");
    await writeTask(taskPath);

    const { setConfig } = await import("../config.js");
    setConfig({ stateDir });

    const { runBenchmark } = await import("./runner.js");
    await runBenchmark(
      {
        id: "artifact-suite",
        tasks: [{ id: "task-1", taskFile: taskPath }],
      },
      { outDir },
    );

    const copiedRunDir = join(outDir, "tasks", "task-1");
    expect(existsSync(join(copiedRunDir, "summary.json"))).toBe(true);
    expect(existsSync(join(copiedRunDir, "evidence", "iteration-0.patch"))).toBe(true);
    expect(existsSync(join(copiedRunDir, "workspace"))).toBe(false);
  });

  it("runs configured warmups and repeats while preserving each measured attempt", async () => {
    const taskPath = join(tempDir, "repeat-task.json");
    const suitePath = join(tempDir, "repeat-suite.json");
    await writeTask(taskPath);
    await writeFile(
      suitePath,
      JSON.stringify({
        id: "repeat-suite",
        repeats: 3,
        warmups: 1,
        tasks: [{ id: "task-1", taskFile: "repeat-task.json" }],
      }),
      "utf-8",
    );
    const { loadSuite, runBenchmark } = await import("./runner.js");

    const result = await runBenchmark(loadSuite(suitePath), {
      outDir: join(tempDir, "repeat-out"),
    });

    expect(supervisorTasks).toHaveLength(4);
    expect(result.tasks[0]?.attempts).toHaveLength(3);
    expect(result.tasks[0]?.passRate).toBe(1);
    expect(result.tasks[0]?.medianDurationMs).toBe(0);
    expect(result.environment.node).toBe(process.version);
    expect(result.environment.platform).toBe(process.platform);
  });

  it("rejects repeated suites that disable isolation or auto-apply changes", async () => {
    const suitePath = join(tempDir, "unsafe-repeat.json");
    await writeFile(
      suitePath,
      JSON.stringify({
        id: "unsafe-repeat",
        repeats: 2,
        defaults: { worktree: false, autoApply: true },
        tasks: [{ id: "task-1", taskFile: "task.json" }],
      }),
      "utf-8",
    );
    const { loadSuite } = await import("./runner.js");
    expect(() => loadSuite(suitePath)).toThrow("Repeated benchmarks require isolated worktrees");
  });

  it("classifies provider failures as infrastructure errors", async () => {
    const taskPath = join(tempDir, "provider-task.json");
    await writeTask(taskPath);
    supervisorResult = {
      reason: "provider_error",
      runId: "run-provider-error",
      iterations: [],
      totalCostUsd: 0,
      totalDurationMs: 10,
      integritySummary: { status: "ok", criticalCount: 0, warningCount: 0, issues: [] },
    };
    const { runBenchmark } = await import("./runner.js");

    const result = await runBenchmark(
      {
        id: "provider-suite",
        tasks: [{ id: "task-1", taskFile: taskPath, expectedOutcome: "passed" }],
      },
      { outDir: join(tempDir, "provider-out") },
    );

    expect(result.status).toBe("partial");
    expect(result.tasks[0]?.actualStatus).toBe("error");
    expect(result.tasks[0]?.stopReason).toBe("provider_error");
    expect(result.metrics.infrastructureErrorRate).toBe(1);
    expect(result.metrics.successRate).toBe(0);
  });
});

async function writeTask(path: string, overrides: Partial<TaskSpec> = {}): Promise<void> {
  await writeFile(
    path,
    JSON.stringify({
      id: "task-1",
      goal: "Fix the task",
      repoPath: tempDir,
      acceptance: { steps: [{ id: "test", command: "npm", args: ["test"] }] },
      maxIterations: 5,
      ...overrides,
    }),
    "utf-8",
  );
}
