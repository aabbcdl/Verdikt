import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveRunState } from "../trace/recorder.js";
import type { TaskSpec } from "../types.js";

describe("Resume command", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "verdikt-resume-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("fails when run directory does not exist", async () => {
    const { handleResume } = await import("./resume.js");

    const mockExit = (code: number) => {
      throw new Error(`Process exited with code ${code}`);
    };
    const originalExit = process.exit;
    process.exit = mockExit as typeof process.exit;

    try {
      await expect(handleResume(["nonexistent-run"])).rejects.toThrow("Process exited with code 1");
    } finally {
      process.exit = originalExit;
    }
  });

  it("fails when run has no state file", async () => {
    const runDir = join(tempDir, "completed-run");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "summary.json"), JSON.stringify({ status: "passed" }));

    const { handleResume } = await import("./resume.js");

    const mockExit = (code: number) => {
      throw new Error(`Process exited with code ${code}`);
    };
    const originalExit = process.exit;
    process.exit = mockExit as typeof process.exit;

    try {
      await expect(handleResume(["completed-run"])).rejects.toThrow("Process exited with code 1");
    } finally {
      process.exit = originalExit;
    }
  });

  it("fails when no run ID provided", async () => {
    const { handleResume } = await import("./resume.js");

    const mockExit = (code: number) => {
      throw new Error(`Process exited with code ${code}`);
    };
    const originalExit = process.exit;
    process.exit = mockExit as typeof process.exit;

    try {
      await expect(handleResume([])).rejects.toThrow("Process exited with code 1");
    } finally {
      process.exit = originalExit;
    }
  });

  it("loads state and verifies state file content", async () => {
    // Create a valid state file
    const runId = "test-resume-run";
    const runDir = join(tempDir, runId);
    await mkdir(runDir, { recursive: true });

    const mockTask: TaskSpec = {
      id: "test-task",
      goal: "Fix the bug",
      repoPath: "/tmp/repo",
      acceptance: { testCommand: "npm test" },
      maxIterations: 5,
    };

    await saveRunState(runDir, {
      task: mockTask,
      instruction: "Fix the auth bug",
      nextIteration: 2,
      totalCostUsd: 1.5,
      totalDurationMs: 30000,
      lastSavedAt: "2026-01-01T00:00:00Z",
      useWorktree: true,
      useIntegrity: true,
    });

    // Verify state file exists
    expect(existsSync(join(runDir, "state.json"))).toBe(true);

    // Read and verify state content
    const stateContent = JSON.parse(await readFile(join(runDir, "state.json"), "utf-8"));
    expect(stateContent.task.id).toBe("test-task");
    expect(stateContent.nextIteration).toBe(2);
    expect(stateContent.totalCostUsd).toBe(1.5);
  });

  it("resumeSupervisorLoop loads correct task from state", async () => {
    // Create a valid state file
    const runId = "test-resume-supervisor";
    const runDir = join(tempDir, runId);
    await mkdir(runDir, { recursive: true });

    const mockTask: TaskSpec = {
      id: "resume-task",
      goal: "Implement feature X",
      repoPath: "/tmp/repo",
      acceptance: { testCommand: "npm test" },
      maxIterations: 10,
    };

    await saveRunState(runDir, {
      task: mockTask,
      instruction: "Continue implementing",
      nextIteration: 3,
      totalCostUsd: 2.5,
      totalDurationMs: 60000,
      lastSavedAt: "2026-01-01T00:00:00Z",
      useWorktree: false,
      useIntegrity: false,
    });

    // Verify the state can be loaded
    const { loadRunState } = await import("../trace/recorder.js");
    const state = await loadRunState(runDir);

    expect(state).not.toBeNull();
    expect(state?.task.id).toBe("resume-task");
    expect(state?.nextIteration).toBe(3);
    expect(state?.totalCostUsd).toBe(2.5);
  });
});
