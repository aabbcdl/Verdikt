import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  archiveRun,
  buildRunStats,
  listSavedRuns,
  readRunMetadata,
  readTaskForSavedRun,
  updateRunMetadata,
} from "./runStore.js";

let tempDir: string;
let stateDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "verdikt-run-store-test-"));
  stateDir = join(tempDir, ".verdikt");
  await mkdir(stateDir, { recursive: true });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("listSavedRuns", () => {
  it("lists completed and resumable runs from the state directory", async () => {
    await mkdir(join(stateDir, "run-complete-001"), { recursive: true });
    await writeFile(
      join(stateDir, "run-complete-001", "summary.json"),
      JSON.stringify({
        runId: "run-complete-001",
        taskId: "fix-sum",
        stopReason: "passed",
        totalIterations: 1,
        totalCostUsd: 0.2,
        totalDurationMs: 100,
        applyStatus: "pending",
        timestamp: "2026-06-18T00:00:00.000Z",
      }),
      "utf-8",
    );

    await mkdir(join(stateDir, "run-resume-001"), { recursive: true });
    await writeFile(
      join(stateDir, "run-resume-001", "state.json"),
      JSON.stringify({
        task: {
          id: "resume-task",
          goal: "Finish the interrupted task",
          repoPath: tempDir,
          acceptance: { steps: [{ id: "test", command: "node", args: ["--version"] }] },
          maxIterations: 3,
        },
        nextIteration: 2,
        totalCostUsd: 0.4,
        totalDurationMs: 200,
        lastSavedAt: "2026-06-18T00:01:00.000Z",
      }),
      "utf-8",
    );

    const runs = await listSavedRuns(stateDir);

    expect(runs.map((run) => run.runId)).toEqual(["run-resume-001", "run-complete-001"]);
    expect(runs[0].status).toBe("resumable");
    expect(runs[0].resumable).toBe(true);
    expect(runs[1].status).toBe("passed");
    expect(runs[1].advice.title).toContain("通过");
  });

  it("keeps missing spend unknown instead of treating it as zero", async () => {
    const runId = "run-unknown-cost";
    await mkdir(join(stateDir, runId), { recursive: true });
    await writeFile(
      join(stateDir, runId, "summary.json"),
      JSON.stringify({
        runId,
        taskId: "unknown-cost",
        stopReason: "passed",
        timestamp: "2026-07-17T00:00:00.000Z",
      }),
      "utf-8",
    );

    const runs = await listSavedRuns(stateDir);

    expect(runs[0].totalCostUsd).toBe(0);
    expect(runs[0].usageStatus).toBe("unknown");
  });

  it("stores run metadata used by the long-term workbench", async () => {
    const runId = "run-meta-001";
    await mkdir(join(stateDir, runId), { recursive: true });
    await writeFile(
      join(stateDir, runId, "summary.json"),
      JSON.stringify({
        runId,
        taskId: "fix-sum",
        goal: "Fix the broken sum function",
        repoPath: tempDir,
        stopReason: "passed",
        timestamp: "2026-06-18T00:00:00.000Z",
      }),
      "utf-8",
    );

    await updateRunMetadata(stateDir, runId, { pinned: true, tags: ["demo"], note: "reviewed" });

    const metadata = await readRunMetadata(stateDir, runId);
    const runs = await listSavedRuns(stateDir);

    expect(metadata).toEqual({ pinned: true, archived: false, tags: ["demo"], note: "reviewed" });
    expect(runs[0].pinned).toBe(true);
    expect(runs[0].tags).toEqual(["demo"]);
    expect(runs[0].note).toBe("reviewed");
  });

  it("archives runs so normal workbench views can hide old noise", async () => {
    const runId = "run-archive-001";
    await mkdir(join(stateDir, runId), { recursive: true });
    await writeFile(
      join(stateDir, runId, "summary.json"),
      JSON.stringify({
        runId,
        taskId: "old-task",
        goal: "Old task",
        repoPath: tempDir,
        stopReason: "passed",
        timestamp: "2026-06-18T00:00:00.000Z",
      }),
      "utf-8",
    );

    await archiveRun(stateDir, runId);

    const runs = await listSavedRuns(stateDir);
    expect(runs[0].archived).toBe(true);
  });

  it("reads a saved task so a failed run can be edited before retrying", async () => {
    const runId = "run-task-001";
    await mkdir(join(stateDir, runId), { recursive: true });
    await writeFile(
      join(stateDir, runId, "task.json"),
      JSON.stringify({
        id: "fix-sum",
        goal: "Fix sum",
        repoPath: tempDir,
        acceptance: { steps: [{ id: "test", command: "npm", args: ["test"] }] },
        maxIterations: 5,
      }),
      "utf-8",
    );

    const task = await readTaskForSavedRun(stateDir, runId);

    expect(task?.goal).toBe("Fix sum");
    expect(task?.acceptance.steps?.[0].id).toBe("test");
  });

  it("reads explicit and legacy run sources without deleting old records", async () => {
    const fixtures = [
      {
        runId: "run-demo-source",
        taskId: "demo-task",
        task: { id: "demo-task", runSource: "demo" },
        stopReason: "passed",
        timestamp: "2026-07-18T01:00:00.000Z",
      },
      {
        runId: "run-legacy-test",
        taskId: "mock-multi-round",
        goal: "Fix all tests in the calculator module",
        repoPath: "/tmp/mock-repo",
        stopReason: "passed",
        timestamp: "2026-07-18T00:00:00.000Z",
      },
    ];
    for (const fixture of fixtures) {
      await mkdir(join(stateDir, fixture.runId), { recursive: true });
      await writeFile(
        join(stateDir, fixture.runId, "summary.json"),
        JSON.stringify(fixture),
        "utf-8",
      );
    }

    const runs = await listSavedRuns(stateDir);

    expect(runs.find((run) => run.runId === "run-demo-source")?.runSource).toBe("demo");
    // Legacy records without an explicit runSource stay "unknown" — the old
    // fixture-string heuristic misclassified real user runs and was removed.
    expect(runs.find((run) => run.runId === "run-legacy-test")?.runSource).toBe("unknown");
  });

  it("keeps a stopped summary resumable when state.json is also present", async () => {
    const runId = "run-stopped-resumable";
    const runDir = join(stateDir, runId);
    const task = {
      id: "stopped-task",
      goal: "Continue safely",
      repoPath: tempDir,
      runSource: "user",
      acceptance: { steps: [{ id: "test", command: "node", args: ["--version"] }] },
      maxIterations: 3,
    };
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "summary.json"),
      JSON.stringify({
        runId,
        taskId: task.id,
        task,
        stopReason: "cancelled",
        applyStatus: "pending",
        totalIterations: 0,
        timestamp: "2026-07-18T00:00:00.000Z",
      }),
      "utf-8",
    );
    await writeFile(
      join(runDir, "state.json"),
      JSON.stringify({
        task,
        nextIteration: 0,
        totalCostUsd: 0.3,
        totalDurationMs: 500,
        lastSavedAt: "2026-07-18T00:01:00.000Z",
        phase: "stopped",
      }),
      "utf-8",
    );

    const run = (await listSavedRuns(stateDir))[0];

    expect(run.status).toBe("cancelled");
    expect(run.resumable).toBe(true);
    expect(run.runSource).toBe("user");
    expect(run.totalCostUsd).toBe(0.3);
  });

  it("does not offer resume for discarded runs with stale state", async () => {
    const runId = "run-discarded-stale";
    const runDir = join(stateDir, runId);
    const task = {
      id: "discarded-task",
      goal: "Already discarded",
      repoPath: tempDir,
      acceptance: { steps: [{ id: "test", command: "node", args: ["--version"] }] },
      maxIterations: 1,
    };
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "summary.json"),
      JSON.stringify({
        runId,
        taskId: task.id,
        task,
        stopReason: "cancelled",
        applyStatus: "discarded",
        timestamp: "2026-07-18T00:00:00.000Z",
      }),
      "utf-8",
    );
    await writeFile(
      join(runDir, "state.json"),
      JSON.stringify({ task, nextIteration: 0, phase: "stopped" }),
      "utf-8",
    );

    const run = (await listSavedRuns(stateDir))[0];

    expect(run.applyStatus).toBe("discarded");
    expect(run.resumable).toBe(false);
  });

  it("preserves the provider stop reason and actionable advice for resumable history", async () => {
    const runId = "run-provider-resumable";
    const runDir = join(stateDir, runId);
    const task = {
      id: "provider-task",
      goal: "Continue after funding the account",
      repoPath: tempDir,
      runSource: "user",
      acceptance: { steps: [{ id: "test", command: "node", args: ["--version"] }] },
      maxIterations: 3,
    };
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "summary.json"),
      JSON.stringify({
        runId,
        taskId: task.id,
        task,
        stopReason: "provider_error",
        resumable: true,
        providerError: {
          category: "insufficient_credit",
          statusCode: 402,
          message: "Insufficient credit",
          retryable: false,
        },
        totalIterations: 0,
        timestamp: "2026-07-19T00:00:00.000Z",
      }),
      "utf-8",
    );
    await writeFile(
      join(runDir, "state.json"),
      JSON.stringify({ task, nextIteration: 0, phase: "stopped" }),
      "utf-8",
    );

    const run = (await listSavedRuns(stateDir))[0];

    expect(run.status).toBe("provider_error");
    expect(run.stopReason).toBe("provider_error");
    expect(run.providerError).toEqual(
      expect.objectContaining({ category: "insufficient_credit", statusCode: 402 }),
    );
    expect(run.advice.title).toContain("\u4f59\u989d");
  });

  it("counts only unarchived user runs in formal task statistics", async () => {
    for (const { runId, runSource, archived = false } of [
      { runId: "run-user-stats", runSource: "user" },
      { runId: "run-demo-stats", runSource: "demo" },
      { runId: "run-test-stats", runSource: "test" },
      { runId: "run-benchmark-stats", runSource: "benchmark" },
      { runId: "run-unknown-stats", runSource: "unknown" },
      { runId: "run-archived-user-stats", runSource: "user", archived: true },
    ] as const) {
      const runDir = join(stateDir, runId);
      await mkdir(runDir, { recursive: true });
      await writeFile(
        join(runDir, "summary.json"),
        JSON.stringify({
          runId,
          taskId: runId,
          task: { id: runId, goal: runId, repoPath: tempDir, runSource },
          repoPath: tempDir,
          stopReason: "passed",
          totalCostUsd: 1,
          totalDurationMs: 100,
          timestamp: "2026-07-18T00:00:00.000Z",
        }),
        "utf-8",
      );
      if (archived) {
        await writeFile(
          join(runDir, "metadata.json"),
          JSON.stringify({ pinned: false, archived: true, tags: [], note: "" }),
          "utf-8",
        );
      }
    }

    const stats = await buildRunStats(stateDir);

    expect(stats.totals.runs).toBe(1);
    expect(stats.totals.totalCostUsd).toBe(1);
  });
});
