/**
 * Trace recorder — persists each iteration's data to disk.
 *
 * M3: Extended schema for UI and benchmark consumption.
 * M6: Run state persistence for session resume.
 *
 * Structure:
 *   .verdikt/<runId>/
 *     summary.json       — run-level summary with workspace, patch, integrity
 *     iterations.jsonl   — one JSON object per line, one per iteration
 *     evidence/          — per-iteration patches (managed by worktree module)
 *     state.json         — run state for resume (task, instruction, iteration)
 */

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { IterationRecord, RunResult, StopReason, TaskSpec } from "../types.js";

/**
 * Generate a short run ID from timestamp.
 */
export function createRunId(): string {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const rand = Math.random().toString(36).slice(2, 6);
  return `run-${ts}-${rand}`;
}

/**
 * Initialize the state directory for a run.
 */
export async function initRun(stateDir: string, runId: string): Promise<string> {
  const runDir = join(stateDir, runId);
  await mkdir(runDir, { recursive: true });
  return runDir;
}

/**
 * Append one iteration record to iterations.jsonl.
 */
export async function recordIteration(
  runDir: string,
  record: IterationRecord,
): Promise<void> {
  const line = JSON.stringify(record) + "\n";
  const filePath = join(runDir, "iterations.jsonl");
  await writeFile(filePath, line, { flag: "a" });
}

/**
 * Write the final summary at the end of a run.
 *
 * M3: Produces a rich summary.json consumable by UI and benchmark.
 */
export async function writeSummary(
  runDir: string,
  result: RunResult,
): Promise<void> {
  const summary = {
    // Run metadata
    runId: result.runId ?? null,
    taskId: result.taskId ?? null,
    timestamp: new Date().toISOString(),

    // Status
    status: result.reason,
    stopReason: result.reason,

    // Counts
    totalIterations: result.iterations.length,
    totalDurationMs: result.totalDurationMs,
    totalCostUsd: result.totalCostUsd,

    // Workspace (M3)
    workspace: result.workspace ?? null,

    // Final patch (M3)
    patch: result.patch ?? null,

    // Integrity summary (M3)
    integrity: result.integritySummary ?? null,

    // Apply status (M3)
    applyStatus: result.applyStatus ?? "pending",

    // Semantic risk (M4)
    semanticRisk: result.semanticRisk ?? null,

    // Per-iteration summary
    iterations: result.iterations.map((iter) => ({
      index: iter.index,
      durationMs: iter.durationMs,
      costUsd: iter.costUsd,

      // Judge
      judge: {
        passed: iter.judge.passed,
        exitCode: iter.judgeExitCode ?? iter.judge.checks[0]?.exitCode ?? null,
        failedChecks: iter.judge.checks.filter((c) => !c.passed).map((c) => c.name),
        summary: iter.judge.passed
          ? `${iter.judge.checks.length}/${iter.judge.checks.length} passed`
          : `${iter.judge.checks.filter((c) => !c.passed).length}/${iter.judge.checks.length} failed`,
      },

      // Verifier (M3)
      verifier: {
        done: iter.verifierVerdict.done,
        problems: iter.verifierVerdict.problems,
        nextInstruction: iter.verifierVerdict.nextInstruction,
      },

      // Patch (M3)
      patch: {
        path: iter.patchPath ?? null,
        filesChanged: iter.changedFiles,
        linesAdded: iter.linesAdded ?? null,
        linesDeleted: iter.linesDeleted ?? null,
      },

      // Integrity (M3)
      integrity: iter.integrity ?? { status: "ok", criticalCount: 0, warningCount: 0, issues: [] },
    })),
  };

  await writeFile(join(runDir, "summary.json"), JSON.stringify(summary, null, 2));
}

/**
 * M6: Run state for session resume.
 */
export interface RunState {
  /** The task spec */
  task: TaskSpec;
  /** Current instruction for the executor */
  instruction: string;
  /** Next iteration index (0-based) */
  nextIteration: number;
  /** Accumulated cost so far */
  totalCostUsd: number;
  /** Total duration so far */
  totalDurationMs: number;
  /** Timestamp of last save */
  lastSavedAt: string;
  /** Whether worktree was used */
  useWorktree: boolean;
  /** Whether integrity checks are enabled */
  useIntegrity: boolean;
}

/**
 * Save run state for resume capability.
 */
export async function saveRunState(runDir: string, state: RunState): Promise<void> {
  await writeFile(join(runDir, "state.json"), JSON.stringify(state, null, 2));
}

/**
 * Load run state for resume.
 * Returns null if no state file exists (run was completed or never started).
 */
export async function loadRunState(runDir: string): Promise<RunState | null> {
  const statePath = join(runDir, "state.json");
  if (!existsSync(statePath)) return null;
  try {
    const raw = await readFile(statePath, "utf-8");
    return JSON.parse(raw) as RunState;
  } catch {
    return null;
  }
}

/**
 * Check if a run is resumable (has state file and no summary).
 */
export async function isRunResumable(runDir: string): Promise<boolean> {
  const statePath = join(runDir, "state.json");
  const summaryPath = join(runDir, "summary.json");
  return existsSync(statePath) && !existsSync(summaryPath);
}

/**
 * Clean up state file after run completes.
 */
export async function clearRunState(runDir: string): Promise<void> {
  const statePath = join(runDir, "state.json");
  if (existsSync(statePath)) {
    const { unlink } = await import("node:fs/promises");
    await unlink(statePath).catch(() => {});
  }
}
