import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfig, setConfig } from "../config.js";
import { saveRunState } from "../trace/recorder.js";
import type { TaskSpec } from "../types.js";

vi.mock("../loop/supervisor.js", () => ({
  resumeSupervisorLoop: vi.fn().mockResolvedValue({
    reason: "passed",
    iterations: [],
    totalCostUsd: 0,
    totalDurationMs: 0,
    runId: "mock-run",
  }),
}));

describe("Resume command", () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = await mkdtemp(join(tmpdir(), "verdikt-resume-test-"));
    setConfig({ stateDir: tempDir });
  });

  afterEach(async () => {
    resetConfig();
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

  it("fails when run ID tries to leave the state directory", async () => {
    const { handleResume } = await import("./resume.js");
    const { resumeSupervisorLoop } = await import("../loop/supervisor.js");

    const outsideDir = join(tempDir, "..", "outside-run");
    await rm(outsideDir, { recursive: true, force: true });
    await mkdir(outsideDir, { recursive: true });
    await saveRunState(outsideDir, {
      task: {
        id: "outside-task",
        goal: "Do not resume this",
        repoPath: "/tmp/repo",
        acceptance: { testCommand: "npm test" },
        maxIterations: 1,
      },
      instruction: "continue",
      nextIteration: 0,
      totalCostUsd: 0,
      totalDurationMs: 0,
      lastSavedAt: "2026-01-01T00:00:00Z",
      useWorktree: false,
      useIntegrity: false,
    });

    const mockExit = (code: number) => {
      throw new Error(`Process exited with code ${code}`);
    };
    const originalExit = process.exit;
    process.exit = mockExit as typeof process.exit;

    try {
      await expect(handleResume(["../outside-run"])).rejects.toThrow("Process exited with code 1");
      expect(resumeSupervisorLoop).not.toHaveBeenCalled();
    } finally {
      process.exit = originalExit;
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("resumes a saved run end-to-end through handleResume (success path)", async () => {
    const runId = "resume-success-run";
    const runDir = join(tempDir, runId);
    await mkdir(runDir, { recursive: true });
    await saveRunState(runDir, {
      task: {
        id: "success-task",
        goal: "Finish the fix",
        repoPath: "/tmp/repo",
        acceptance: { testCommand: "npm test" },
        maxIterations: 3,
      },
      instruction: "continue",
      nextIteration: 1,
      totalCostUsd: 0.5,
      totalDurationMs: 1000,
      lastSavedAt: "2026-01-01T00:00:00Z",
      useWorktree: false,
      useIntegrity: false,
    });

    const { handleResume } = await import("./resume.js");
    const { resumeSupervisorLoop } = await import("../loop/supervisor.js");

    const originalExit = process.exit;
    process.exit = ((code?: number) => {
      throw new Error(`Process exited with code ${code}`);
    }) as typeof process.exit;

    try {
      // Mocked resumeSupervisorLoop returns "passed" → exit code 0.
      await expect(handleResume([runId, "--json"])).rejects.toThrow("Process exited with code 0");
      expect(resumeSupervisorLoop).toHaveBeenCalledTimes(1);
      expect(vi.mocked(resumeSupervisorLoop).mock.calls[0]?.[0]).toContain(runId);
    } finally {
      process.exit = originalExit;
    }
  });

  it("saveRunState/loadRunState round-trip the resume fixture (state file shape)", async () => {
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

  it("loadRunState returns the saved task (recorder round-trip)", async () => {
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
