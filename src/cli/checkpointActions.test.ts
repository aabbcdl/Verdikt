import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetConfig, setConfig } from "../config.js";
import { saveIterationCheckpoint } from "../trace/checkpoints.js";
import {
  initRun,
  loadRecordedIterations,
  loadRunState,
  recordIteration,
  saveRunState,
} from "../trace/recorder.js";
import type { IterationRecord, TaskSpec } from "../types.js";
import { checkpointIteration, createRunWorktree } from "../workspace/worktree.js";
import { forkRunFromIteration, rewindRunToIteration } from "./checkpointActions.js";

const exec = promisify(execFile);

describe("checkpoint actions", () => {
  let root: string;
  let repo: string;
  let stateDir: string;
  let runDir: string;
  const task = (): TaskSpec => ({
    id: "checkpoint-task",
    goal: "change value",
    repoPath: repo,
    acceptance: { steps: [{ id: "test", command: "node", args: ["--version"] }] },
    maxIterations: 3,
  });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "verdikt-checkpoint-actions-"));
    repo = join(root, "repo");
    stateDir = join(root, "state");
    await exec("git", ["init", repo]);
    await exec("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    await exec("git", ["-C", repo, "config", "user.name", "Test"]);
    await writeFile(join(repo, "value.txt"), "base", "utf-8");
    await exec("git", ["-C", repo, "add", "."]);
    await exec("git", ["-C", repo, "commit", "-m", "base"]);
    setConfig({ stateDir });
    runDir = await initRun(stateDir, "source-run");
  });

  afterEach(async () => {
    resetConfig();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  async function prepareCheckpoint() {
    const worktree = await createRunWorktree(repo, runDir, "source-run");
    await writeFile(join(worktree.worktreePath, "value.txt"), "iteration-1", "utf-8");
    const commit = await checkpointIteration(worktree.worktreePath, 0);
    const state = {
      task: task(),
      instruction: "continue",
      nextIteration: 1,
      totalCostUsd: 0.1,
      totalDurationMs: 10,
      lastSavedAt: new Date().toISOString(),
      useWorktree: true,
      useIntegrity: true,
      worktree,
      phase: "between_iterations" as const,
    };
    await saveRunState(runDir, state);
    await saveIterationCheckpoint(runDir, 0, commit, state);
    const iteration: IterationRecord = {
      index: 0,
      executorOutput: "changed",
      changedFiles: ["value.txt"],
      judge: { passed: false, checks: [] },
      verifierVerdict: { done: false, problems: [], nextInstruction: "continue" },
      durationMs: 10,
      checkpointCommit: commit,
    };
    await recordIteration(runDir, iteration);
    return { worktree, commit };
  }

  it("rewinds a resumable run to an exact iteration", async () => {
    const { worktree } = await prepareCheckpoint();
    await writeFile(join(worktree.worktreePath, "value.txt"), "later-bad-change", "utf-8");

    await rewindRunToIteration("source-run", 0);

    expect(await readFile(join(worktree.worktreePath, "value.txt"), "utf-8")).toBe("iteration-1");
    expect(await loadRecordedIterations(runDir)).toHaveLength(1);
    expect((await loadRunState(runDir))?.nextIteration).toBe(1);
  });

  it("rewinds a resumable cancelled run even when it has a summary", async () => {
    const { worktree } = await prepareCheckpoint();
    await writeFile(join(worktree.worktreePath, "value.txt"), "later-bad-change", "utf-8");
    await writeFile(
      join(runDir, "summary.json"),
      JSON.stringify({
        stopReason: "cancelled",
        applyStatus: "pending",
        resumable: true,
      }),
      "utf-8",
    );

    await rewindRunToIteration("source-run", 0);

    expect(await readFile(join(worktree.worktreePath, "value.txt"), "utf-8")).toBe("iteration-1");
    expect((await loadRunState(runDir))?.nextIteration).toBe(1);
  });

  it("forks a new isolated run from an iteration checkpoint", async () => {
    await prepareCheckpoint();

    const forked = await forkRunFromIteration("source-run", 0, "forked-run");
    const state = await loadRunState(forked.runDir);

    expect(forked.sourceRunId).toBe("source-run");
    const forkedWorktreePath = state?.worktree?.worktreePath;
    expect(forkedWorktreePath).toContain("forked-run");
    if (!forkedWorktreePath) throw new Error("Forked worktree path was not saved");
    expect(await readFile(join(forkedWorktreePath, "value.txt"), "utf-8")).toBe("iteration-1");
  });
});
