import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getConfig } from "../config.js";
import {
  loadIterationCheckpoint,
  saveIterationCheckpoint,
  truncateIterationCheckpointsAfter,
} from "../trace/checkpoints.js";
import { appendRunEvent } from "../trace/events.js";
import { deriveRunLifecycle } from "../trace/lifecycle.js";
import {
  createRunId,
  initRun,
  saveRunState,
  truncateRecordedIterations,
} from "../trace/recorder.js";
import { createRunWorktreeAtCommit, resetRunWorktreeToCommit } from "../workspace/worktree.js";
import { isPathInside, isValidRunId } from "./localServer.js";

export interface CheckpointActionResult {
  runId: string;
  runDir: string;
  iteration: number;
}

export async function rewindRunToIteration(
  runId: string,
  iteration: number,
): Promise<CheckpointActionResult> {
  const { stateDir, runDir } = resolveRun(runId);
  const lifecycle = await deriveRunLifecycle(runDir);
  if (!lifecycle.resumable) {
    throw new Error("Only resumable runs can be rewound in place.");
  }
  const current = lifecycle.state;
  if (!current?.worktree) throw new Error("Run has no isolated resumable workspace.");
  const checkpoint = await loadIterationCheckpoint(runDir, iteration);
  if (!checkpoint) throw new Error(`Iteration checkpoint ${iteration + 1} was not found.`);
  if (!isPathInside(stateDir, current.worktree.worktreePath)) {
    throw new Error("Saved workspace is outside the Verdikt state directory.");
  }

  await resetRunWorktreeToCommit(current.worktree.worktreePath, checkpoint.commit);
  await truncateRecordedIterations(runDir, iteration);
  await truncateIterationCheckpointsAfter(runDir, iteration);
  await saveRunState(runDir, {
    ...checkpoint.state,
    lastSavedAt: new Date().toISOString(),
    phase: "between_iterations",
  });
  await appendRunEvent(runDir, {
    type: "checkpoint_rewound",
    runId,
    iteration,
    data: { commit: checkpoint.commit },
  });
  return { runId, runDir, iteration };
}

export async function forkRunFromIteration(
  sourceRunId: string,
  iteration: number,
  requestedRunId?: string,
): Promise<CheckpointActionResult & { sourceRunId: string }> {
  const source = resolveRun(sourceRunId);
  const checkpoint = await loadIterationCheckpoint(source.runDir, iteration);
  if (!checkpoint?.state.worktree) {
    throw new Error(`Iteration checkpoint ${iteration + 1} has no isolated workspace state.`);
  }
  const newRunId = requestedRunId ?? createRunId();
  if (!isValidRunId(newRunId)) throw new Error("Invalid new run ID");
  const newRunDir = await initRun(source.stateDir, newRunId);
  const task = checkpoint.state.task;
  const worktree = await createRunWorktreeAtCommit(
    task.repoPath,
    newRunDir,
    newRunId,
    checkpoint.commit,
    checkpoint.state.worktree.baseCommit,
  );
  await writeFile(join(newRunDir, "task.json"), JSON.stringify(task, null, 2), "utf-8");
  const sourceIterations = await truncateSourceIterations(source.runDir, iteration);
  await writeFile(
    join(newRunDir, "iterations.jsonl"),
    sourceIterations
      .map((record) => JSON.stringify({ ...record, patchPath: undefined }))
      .join("\n") + (sourceIterations.length ? "\n" : ""),
    "utf-8",
  );
  const nextState = {
    ...checkpoint.state,
    task,
    worktree,
    lastSavedAt: new Date().toISOString(),
    phase: "between_iterations" as const,
  };
  await saveRunState(newRunDir, nextState);
  await saveIterationCheckpoint(newRunDir, iteration, checkpoint.commit, nextState);
  await appendRunEvent(newRunDir, {
    type: "checkpoint_forked",
    runId: newRunId,
    iteration,
    data: { sourceRunId, commit: checkpoint.commit },
  });
  return { runId: newRunId, runDir: newRunDir, iteration, sourceRunId };
}

async function truncateSourceIterations(runDir: string, iteration: number) {
  const raw = await readFile(join(runDir, "iterations.jsonl"), "utf-8").catch(() => "");
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const record = JSON.parse(line) as { index?: unknown };
        return typeof record.index === "number" && record.index <= iteration ? [record] : [];
      } catch {
        return [];
      }
    });
}

function resolveRun(runId: string): { stateDir: string; runDir: string } {
  const stateDir = resolve(getConfig().stateDir);
  const runDir = resolve(stateDir, runId);
  if (!isValidRunId(runId) || !isPathInside(stateDir, runDir) || !existsSync(runDir)) {
    throw new Error("Run not found or invalid run ID");
  }
  return { stateDir, runDir };
}
