import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { readJsonFile, writeJsonAtomic } from "./atomicJson.js";
import type { RunState } from "./recorder.js";

export interface IterationCheckpoint {
  version: 1;
  iteration: number;
  commit: string;
  state: RunState;
}

export async function saveIterationCheckpoint(
  runDir: string,
  iteration: number,
  commit: string,
  state: RunState,
): Promise<IterationCheckpoint> {
  if (!Number.isInteger(iteration) || iteration < 0)
    throw new Error("Invalid iteration checkpoint");
  if (!commit.trim()) throw new Error("Checkpoint commit is required");
  const checkpoint: IterationCheckpoint = { version: 1, iteration, commit, state };
  await mkdir(checkpointDir(runDir), { recursive: true });
  await writeJsonAtomic(checkpointPath(runDir, iteration), checkpoint, { backup: true });
  return checkpoint;
}

export async function loadIterationCheckpoint(
  runDir: string,
  iteration: number,
): Promise<IterationCheckpoint | null> {
  const loaded = await readJsonFile<IterationCheckpoint>(checkpointPath(runDir, iteration));
  return loaded?.version === 1 && loaded.iteration === iteration ? loaded : null;
}

export async function listIterationCheckpoints(runDir: string): Promise<IterationCheckpoint[]> {
  const files = await readdir(checkpointDir(runDir)).catch(() => []);
  const checkpoints: IterationCheckpoint[] = [];
  for (const file of files) {
    const match = /^iteration-(\d+)\.json$/.exec(file);
    if (!match) continue;
    const checkpoint = await loadIterationCheckpoint(runDir, Number(match[1]));
    if (checkpoint) checkpoints.push(checkpoint);
  }
  return checkpoints.sort((a, b) => a.iteration - b.iteration);
}

export async function truncateIterationCheckpointsAfter(
  runDir: string,
  iteration: number,
): Promise<void> {
  const checkpoints = await listIterationCheckpoints(runDir);
  await Promise.all(
    checkpoints
      .filter((checkpoint) => checkpoint.iteration > iteration)
      .map((checkpoint) => rm(checkpointPath(runDir, checkpoint.iteration), { force: true })),
  );
}

function checkpointDir(runDir: string): string {
  return join(runDir, "checkpoints");
}

function checkpointPath(runDir: string, iteration: number): string {
  return join(checkpointDir(runDir), `iteration-${iteration}.json`);
}
