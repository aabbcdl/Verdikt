import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskSpec } from "../types.js";

const supervisorTasks: TaskSpec[] = [];

vi.mock("../loop/supervisor.js", () => ({
  runSupervisorLoop: vi.fn(async (task: TaskSpec) => {
    supervisorTasks.push(JSON.parse(JSON.stringify(task)));
    return {
      reason: "passed",
      runId: "run-batch-mock",
      iterations: [],
      totalCostUsd: 0,
      totalDurationMs: 0,
    };
  }),
}));

let tempDir: string;

beforeEach(async () => {
  supervisorTasks.length = 0;
  tempDir = await mkdtemp(join(tmpdir(), "verdikt-run-test-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tempDir, { recursive: true, force: true });
});

describe("run command", () => {
  it("fails batch mode when every task is invalid instead of reporting success", async () => {
    const tasksDir = join(tempDir, "tasks");
    const repoDir = join(tempDir, "repo");
    await mkdir(tasksDir, { recursive: true });
    await mkdir(join(repoDir, ".git"), { recursive: true });
    await writeFile(
      join(tasksDir, "invalid.json"),
      JSON.stringify({
        id: "invalid-task",
        goal: "Fix the broken behavior in this project",
        repoPath: repoDir,
        maxIterations: 5,
      }),
      "utf-8",
    );

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const { handleRun } = await import("./run.js");

    await expect(handleRun(["--tasks", tasksDir, "--json"])).rejects.toThrow("exit:1");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(supervisorTasks).toHaveLength(0);
  });
});
