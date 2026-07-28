import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IterationRecord, RunResult, TaskSpec } from "../types.js";
import {
  clearRunState,
  createRunId,
  initRun,
  isRunResumable,
  loadRecordedIterations,
  loadRunState,
  recordIteration,
  saveRunState,
  validateResumeState,
  writeSummary,
} from "./recorder.js";

describe("Trace Recorder", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "verdikt-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("createRunId", () => {
    it("generates ID with run- prefix", () => {
      const id = createRunId();
      expect(id).toMatch(/^run-\d{8}-\d{6}-[a-z0-9]{4}$/);
    });

    it("generates unique IDs", () => {
      const id1 = createRunId();
      const id2 = createRunId();
      // They should differ (at least in the random part)
      expect(id1).not.toBe(id2);
    });
  });

  describe("initRun", () => {
    it("creates run directory", async () => {
      const runId = "test-run-001";
      const runDir = await initRun(tempDir, runId);
      expect(runDir).toBe(join(tempDir, runId));
    });

    it("rejects nested run IDs", async () => {
      await expect(initRun(tempDir, "deep/nested/run")).rejects.toThrow("Invalid run ID");
    });

    it("rejects run IDs that try to leave the state directory", async () => {
      await expect(initRun(tempDir, "../outside-run")).rejects.toThrow("Invalid run ID");
    });
  });

  describe("recordIteration", () => {
    it("appends iteration to JSONL file", async () => {
      const runDir = await initRun(tempDir, "test-run");
      const record: IterationRecord = {
        index: 0,
        executorOutput: "Fixed the bug",
        changedFiles: ["src/app.ts"],
        judge: { passed: true, checks: [] },
        verifierVerdict: { done: true, problems: [], nextInstruction: "" },
        durationMs: 1000,
      };

      await recordIteration(runDir, record);

      const content = await readFile(join(runDir, "iterations.jsonl"), "utf-8");
      const parsed = JSON.parse(content.trim());
      expect(parsed.index).toBe(0);
      expect(parsed.executorOutput).toBe("Fixed the bug");
    });

    it("appends multiple iterations", async () => {
      const runDir = await initRun(tempDir, "test-run");

      for (let i = 0; i < 3; i++) {
        await recordIteration(runDir, {
          index: i,
          executorOutput: `Iteration ${i}`,
          changedFiles: [],
          judge: { passed: false, checks: [] },
          verifierVerdict: { done: false, problems: ["still broken"], nextInstruction: "fix it" },
          durationMs: 100 * i,
        });
      }

      const content = await readFile(join(runDir, "iterations.jsonl"), "utf-8");
      const lines = content.trim().split("\n");
      expect(lines).toHaveLength(3);
      expect(JSON.parse(lines[0]).index).toBe(0);
      expect(JSON.parse(lines[2]).index).toBe(2);
    });
  });

  describe("writeSummary", () => {
    it("writes summary.json with all fields", async () => {
      const runDir = await initRun(tempDir, "test-run");
      const result: RunResult = {
        reason: "passed",
        iterations: [
          {
            index: 0,
            executorOutput: "Done",
            changedFiles: ["src/app.ts"],
            judge: {
              passed: true,
              checks: [{ name: "test", passed: true, output: "", exitCode: 0, durationMs: 100 }],
            },
            verifierVerdict: { done: true, problems: [], nextInstruction: "" },
            durationMs: 5000,
          },
        ],
        totalDurationMs: 5000,
        totalCostUsd: 0.5,
        runId: "test-run",
        taskId: "my-task",
      };

      await writeSummary(runDir, result);

      const content = await readFile(join(runDir, "summary.json"), "utf-8");
      const summary = JSON.parse(content);
      const verdict = JSON.parse(await readFile(join(runDir, "verdict.json"), "utf-8"));

      expect(summary.runId).toBe("test-run");
      expect(summary.taskId).toBe("my-task");
      expect(summary.stopReason).toBe("passed");
      expect(summary.totalIterations).toBe(1);
      expect(summary.totalCostUsd).toBe(0.5);
      expect(verdict).toMatchObject({
        version: 1,
        status: "pass",
        recommendation: "accept_change",
        run: {
          runId: "test-run",
          taskId: "my-task",
          stopReason: "passed",
        },
      });
    });

    it("reads the legacy normalized task file when task.json is absent", async () => {
      const runDir = await initRun(tempDir, "legacy-task-run");
      const task: TaskSpec = {
        id: "legacy-task",
        goal: "Use the saved task",
        repoPath: "C:\\repo",
        acceptance: { testCommand: "node --version" },
        maxIterations: 1,
      };
      await writeFile(join(runDir, "normalizedTask.json"), JSON.stringify(task), "utf-8");

      await writeSummary(runDir, {
        reason: "passed",
        iterations: [],
        totalDurationMs: 1,
        totalCostUsd: 0,
        runId: "legacy-task-run",
        taskId: "legacy-task",
      });

      const summary = JSON.parse(await readFile(join(runDir, "summary.json"), "utf-8"));
      expect(summary.goal).toBe(task.goal);
      expect(summary.repoPath).toBe(task.repoPath);
    });

    it("persists structured provider failures for saved-run recovery", async () => {
      const runDir = await initRun(tempDir, "provider-error-run");
      await writeSummary(runDir, {
        reason: "provider_error",
        iterations: [],
        totalDurationMs: 25,
        totalCostUsd: 0,
        runId: "provider-error-run",
        taskId: "provider-error-task",
        resumable: true,
        providerError: {
          category: "insufficient_credit",
          statusCode: 402,
          message: "Insufficient credit",
          retryable: false,
        },
      });

      const summary = JSON.parse(await readFile(join(runDir, "summary.json"), "utf-8"));
      expect(summary.providerError).toEqual({
        category: "insufficient_credit",
        statusCode: 402,
        message: "Insufficient credit",
        retryable: false,
      });
    });

    it("does not report optional structured step failures as blocking summary failures", async () => {
      const runDir = await initRun(tempDir, "test-run");
      const result: RunResult = {
        reason: "passed",
        iterations: [
          {
            index: 0,
            executorOutput: "Done",
            changedFiles: ["src/app.ts"],
            judge: {
              passed: true,
              checks: [
                { name: "test", passed: true, output: "", exitCode: 0, durationMs: 100 },
                {
                  name: "diagnostics",
                  passed: false,
                  output: "optional diagnostic failed",
                  exitCode: 1,
                  durationMs: 100,
                },
              ],
              stepResults: [
                {
                  id: "test",
                  passed: true,
                  exitCode: 0,
                  stdout: "",
                  stderr: "",
                  durationMs: 100,
                  required: true,
                },
                {
                  id: "diagnostics",
                  passed: false,
                  exitCode: 1,
                  stdout: "",
                  stderr: "optional diagnostic failed",
                  durationMs: 100,
                  required: false,
                },
              ],
            },
            verifierVerdict: { done: true, problems: [], nextInstruction: "" },
            durationMs: 5000,
          },
        ],
        totalDurationMs: 5000,
        totalCostUsd: 0.5,
        runId: "test-run",
        taskId: "my-task",
      };

      await writeSummary(runDir, result);

      const content = await readFile(join(runDir, "summary.json"), "utf-8");
      const summary = JSON.parse(content);

      expect(summary.iterations[0].judge.failedChecks).toEqual([]);
      expect(summary.iterations[0].judge.summary).toBe("1/1 required passed");
    });
  });

  describe("RunState persistence", () => {
    const mockTask: TaskSpec = {
      id: "test-task",
      goal: "Fix the bug",
      repoPath: "/tmp/repo",
      acceptance: { testCommand: "npm test" },
      maxIterations: 5,
    };

    it("saves and loads run state", async () => {
      const runDir = await initRun(tempDir, "test-run");
      const state = {
        task: mockTask,
        instruction: "Fix the auth bug",
        nextIteration: 2,
        totalCostUsd: 1.5,
        totalDurationMs: 30000,
        lastSavedAt: "2026-01-01T00:00:00Z",
        useWorktree: true,
        useIntegrity: true,
        worktree: {
          worktreePath: "/tmp/verdikt-run/workspace",
          branchName: "verdikt/test-run",
          baseCommit: "abc123",
          evidenceDir: "/tmp/verdikt-run/evidence",
        },
      };

      await saveRunState(runDir, state);
      const loaded = await loadRunState(runDir);

      expect(loaded).not.toBeNull();
      expect(loaded?.task.id).toBe("test-task");
      expect(loaded?.nextIteration).toBe(2);
      expect(loaded?.totalCostUsd).toBe(1.5);
      expect(loaded?.worktree?.worktreePath).toBe("/tmp/verdikt-run/workspace");
      expect(loaded?.worktree?.baseCommit).toBe("abc123");
    });

    it("returns null when no state file exists", async () => {
      const runDir = await initRun(tempDir, "empty-run");
      const loaded = await loadRunState(runDir);
      expect(loaded).toBeNull();
    });

    it("returns null for malformed state file", async () => {
      const runDir = await initRun(tempDir, "bad-run");
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(runDir, "state.json"), "not valid json", "utf-8");
      const loaded = await loadRunState(runDir);
      expect(loaded).toBeNull();
    });
  });

  describe("isRunResumable", () => {
    it("returns true when state exists but no summary", async () => {
      const runDir = await initRun(tempDir, "resumable");
      await saveRunState(runDir, {
        task: { id: "t", goal: "g", repoPath: "/r", acceptance: {}, maxIterations: 1 },
        instruction: "do stuff",
        nextIteration: 0,
        totalCostUsd: 0,
        totalDurationMs: 0,
        lastSavedAt: "",
        useWorktree: false,
        useIntegrity: false,
      });

      expect(await isRunResumable(runDir)).toBe(true);
    });

    it("stays true when a summary coexists with valid state (interrupted runs)", async () => {
      const runDir = await initRun(tempDir, "completed");
      await saveRunState(runDir, {
        task: { id: "t", goal: "g", repoPath: "/r", acceptance: {}, maxIterations: 1 },
        instruction: "do stuff",
        nextIteration: 0,
        totalCostUsd: 0,
        totalDurationMs: 0,
        lastSavedAt: "",
        useWorktree: false,
        useIntegrity: false,
      });
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(runDir, "summary.json"), "{}", "utf-8");

      // Interrupted/provider_error runs write BOTH summary and state — the
      // summary must not disqualify resumption (see trace/lifecycle.ts).
      expect(await isRunResumable(runDir)).toBe(true);
    });

    it("returns false when no state file", async () => {
      const runDir = await initRun(tempDir, "no-state");
      expect(await isRunResumable(runDir)).toBe(false);
    });
  });

  describe("clearRunState", () => {
    it("removes state file", async () => {
      const runDir = await initRun(tempDir, "to-clear");
      await saveRunState(runDir, {
        task: { id: "t", goal: "g", repoPath: "/r", acceptance: {}, maxIterations: 1 },
        instruction: "do stuff",
        nextIteration: 0,
        totalCostUsd: 0,
        totalDurationMs: 0,
        lastSavedAt: "",
        useWorktree: false,
        useIntegrity: false,
      });

      await clearRunState(runDir);
      const loaded = await loadRunState(runDir);
      expect(loaded).toBeNull();
    });

    it("does not throw when no state file exists", async () => {
      const runDir = await initRun(tempDir, "already-clear");
      await expect(clearRunState(runDir)).resolves.not.toThrow();
    });
  });

  describe("resume history", () => {
    it("loads all valid recorded iterations and tolerates a partial final line", async () => {
      const runDir = await initRun(tempDir, "history-run");
      const baseRecord: IterationRecord = {
        index: 0,
        executorOutput: "first",
        changedFiles: ["src/a.ts"],
        judge: { passed: false, checks: [] },
        verifierVerdict: { done: false, problems: ["still failing"], nextInstruction: "fix it" },
        durationMs: 10,
      };
      await recordIteration(runDir, baseRecord);
      await recordIteration(runDir, { ...baseRecord, index: 1, executorOutput: "second" });
      const { appendFile } = await import("node:fs/promises");
      await appendFile(join(runDir, "iterations.jsonl"), "{partial", "utf-8");

      const iterations = await loadRecordedIterations(runDir);

      expect(iterations.map((iteration) => iteration.index)).toEqual([0, 1]);
      expect(iterations[1]?.executorOutput).toBe("second");
    });

    it("refuses to advertise an isolated run as resumable when its workspace is missing", async () => {
      const runDir = await initRun(tempDir, "missing-workspace");
      const state = {
        task: {
          id: "test-task",
          goal: "Fix the bug",
          repoPath: "/tmp/repo",
          acceptance: { testCommand: "npm test" },
          maxIterations: 5,
        },
        instruction: "continue",
        nextIteration: 1,
        totalCostUsd: 0,
        totalDurationMs: 0,
        lastSavedAt: new Date().toISOString(),
        useWorktree: true,
        useIntegrity: false,
        worktree: {
          worktreePath: join(runDir, "workspace"),
          branchName: "verdikt/missing-workspace",
          baseCommit: "abc123",
          evidenceDir: join(runDir, "evidence"),
        },
      };

      await expect(validateResumeState(runDir, state)).resolves.toEqual(
        expect.objectContaining({ valid: false, reason: expect.stringContaining("workspace") }),
      );

      const { mkdir } = await import("node:fs/promises");
      await mkdir(state.worktree.worktreePath, { recursive: true });
      await expect(validateResumeState(runDir, state)).resolves.toEqual({ valid: true });
    });
  });
});
