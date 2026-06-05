import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IterationRecord, RunResult, TaskSpec } from "../types.js";
import {
  clearRunState,
  createRunId,
  initRun,
  isRunResumable,
  loadRunState,
  recordIteration,
  saveRunState,
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

    it("creates nested directories if needed", async () => {
      const runId = "deep/nested/run";
      const runDir = await initRun(tempDir, runId);
      expect(runDir).toBe(join(tempDir, runId));
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

      expect(summary.runId).toBe("test-run");
      expect(summary.taskId).toBe("my-task");
      expect(summary.stopReason).toBe("passed");
      expect(summary.totalIterations).toBe(1);
      expect(summary.totalCostUsd).toBe(0.5);
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
      };

      await saveRunState(runDir, state);
      const loaded = await loadRunState(runDir);

      expect(loaded).not.toBeNull();
      expect(loaded?.task.id).toBe("test-task");
      expect(loaded?.nextIteration).toBe(2);
      expect(loaded?.totalCostUsd).toBe(1.5);
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

    it("returns false when summary exists (completed)", async () => {
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

      expect(await isRunResumable(runDir)).toBe(false);
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
});
