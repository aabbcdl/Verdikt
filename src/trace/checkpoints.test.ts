import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listIterationCheckpoints,
  loadIterationCheckpoint,
  saveIterationCheckpoint,
  truncateIterationCheckpointsAfter,
} from "./checkpoints.js";
import type { RunState } from "./recorder.js";

describe("iteration checkpoints", () => {
  let runDir: string;
  const state = {
    task: {
      id: "task",
      goal: "goal",
      repoPath: "/repo",
      acceptance: { steps: [{ id: "test", command: "node", args: ["--version"] }] },
      maxIterations: 3,
    },
    instruction: "next",
    nextIteration: 1,
    totalCostUsd: 0.1,
    totalDurationMs: 100,
    lastSavedAt: "2026-07-17T00:00:00.000Z",
    useWorktree: true,
    useIntegrity: true,
  } satisfies RunState;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), "verdikt-checkpoints-"));
  });
  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it("saves and loads an exact per-iteration state", async () => {
    await saveIterationCheckpoint(runDir, 0, "abc123", state);
    expect(await loadIterationCheckpoint(runDir, 0)).toEqual({
      version: 1,
      iteration: 0,
      commit: "abc123",
      state,
    });
  });

  it("lists checkpoints and truncates later attempts", async () => {
    await saveIterationCheckpoint(runDir, 0, "a", state);
    await saveIterationCheckpoint(runDir, 1, "b", { ...state, nextIteration: 2 });
    expect((await listIterationCheckpoints(runDir)).map((item) => item.iteration)).toEqual([0, 1]);
    await truncateIterationCheckpointsAfter(runDir, 0);
    expect((await listIterationCheckpoints(runDir)).map((item) => item.iteration)).toEqual([0]);
  });
});
