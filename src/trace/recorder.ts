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

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { IterationRecord, RunResult, StopReason, TaskSpec } from "../types.js";
import { buildVerdictResult } from "../verdict/result.js";
import { readJsonFile, writeJsonAtomic } from "./atomicJson.js";

const RUN_ID_PATTERN = /^[a-zA-Z0-9\-_]{1,64}$/;

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
  const rootDir = resolve(stateDir);
  const runDir = resolve(rootDir, runId);
  if (!RUN_ID_PATTERN.test(runId) || !isPathInside(rootDir, runDir)) {
    throw new Error("Invalid run ID");
  }

  await mkdir(runDir, { recursive: true });
  return runDir;
}

/**
 * Append one iteration record to iterations.jsonl.
 */
export async function recordIteration(runDir: string, record: IterationRecord): Promise<void> {
  const line = `${JSON.stringify(record)}\n`;
  const filePath = join(runDir, "iterations.jsonl");
  await writeFile(filePath, line, { flag: "a" });
}

/**
 * Write the final summary at the end of a run.
 *
 * M3: Produces a rich summary.json consumable by UI and benchmark.
 */
export async function writeSummary(runDir: string, result: RunResult): Promise<void> {
  const task = await readSavedTask(runDir);
  const timestamp = new Date().toISOString();
  const summary = {
    // Run metadata
    runId: result.runId ?? null,
    taskId: result.taskId ?? null,
    goal: task?.goal ?? null,
    repoPath: task?.repoPath ?? null,
    runSource: task?.runSource ?? "unknown",
    stages: task?.stages ?? [],
    task: task ?? null,
    timestamp,

    // Status
    status: result.reason,
    stopReason: result.reason,

    // Counts
    totalIterations: result.iterations.length,
    totalDurationMs: result.totalDurationMs,
    totalCostUsd: result.totalCostUsd,
    usageStatus: result.usageStatus ?? result.usage?.status ?? "unknown",
    usage: result.usage ?? null,

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
    stageProgress: result.stageProgress ?? null,
    approvalRequest: result.approvalRequest ?? null,
    evidenceManifestPath: result.evidenceManifestPath ?? null,
    reviewOnly: result.reviewOnly ?? task?.taskMode === "review",
    reviewReport: result.reviewReport ?? null,
    partialIteration: result.partialIteration ?? null,
    providerError: result.providerError ?? null,
    resumable: result.resumable ?? false,
    currentPhase: result.currentPhase ?? null,

    // Per-iteration summary
    iterations: result.iterations.map((iter) => {
      const failedChecks = blockingFailedChecks(iter.judge);
      return {
        index: iter.index,
        stageId: iter.stageId ?? null,
        durationMs: iter.durationMs,
        costUsd: iter.costUsd ?? null,
        usageStatus: iter.usageStatus ?? iter.usage?.status ?? "unknown",
        usage: iter.usage ?? null,

        // Judge
        judge: {
          passed: iter.judge.passed,
          exitCode: iter.judgeExitCode ?? iter.judge.checks[0]?.exitCode ?? null,
          failedChecks: failedChecks.map((c) => c.name),
          summary: summarizeJudge(iter.judge, failedChecks.length),
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
        integrity: iter.integrity ?? {
          status: "ok",
          criticalCount: 0,
          warningCount: 0,
          issues: [],
        },
      };
    }),
  };

  const verdict = buildVerdictResult(result, task, { createdAt: timestamp });
  await Promise.all([
    writeJsonAtomic(join(runDir, "summary.json"), summary, { backup: true }),
    writeJsonAtomic(join(runDir, "verdict.json"), verdict, { backup: true }),
  ]);
}

async function readSavedTask(runDir: string): Promise<TaskSpec | null> {
  for (const fileName of ["task.json", "normalizedTask.json"]) {
    try {
      const raw = await readFile(join(runDir, fileName), "utf-8");
      return JSON.parse(raw) as TaskSpec;
    } catch {
      // Try the next compatible task file.
    }
  }
  return null;
}

function blockingFailedChecks(judge: RunResult["iterations"][number]["judge"]) {
  const optionalStepIds = new Set(
    judge.stepResults?.filter((step) => !step.required).map((step) => step.id) ?? [],
  );
  return judge.checks.filter((check) => !check.passed && !optionalStepIds.has(check.name));
}

function summarizeJudge(
  judge: RunResult["iterations"][number]["judge"],
  blockingFailureCount: number,
): string {
  if (judge.stepResults) {
    const requiredSteps = judge.stepResults.filter((step) => step.required);
    const requiredPassed = requiredSteps.filter((step) => step.passed).length;
    if (judge.passed) {
      return `${requiredPassed}/${requiredSteps.length} required passed`;
    }
    return `${blockingFailureCount}/${requiredSteps.length} required failed`;
  }

  return judge.passed
    ? `${judge.checks.length}/${judge.checks.length} passed`
    : `${blockingFailureCount}/${judge.checks.length} failed`;
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
  /** Whether cost/token accounting is complete so far. */
  usageStatus?: import("../types.js").UsageStatus;
  /** Aggregated usage so far. */
  usage?: import("../types.js").UsageSummary;
  /** Timestamp of last save */
  lastSavedAt: string;
  /** Whether worktree was used */
  useWorktree: boolean;
  /** Whether integrity checks are enabled */
  useIntegrity: boolean;
  phase?:
    | "ready"
    | "running"
    | "between_iterations"
    | "waiting_approval"
    | "stopped"
    | "interrupted"
    | "error";
  currentPhase?: import("../types.js").RunAgentPhase;
  partialIteration?: import("../types.js").PartialIterationRecord;
  currentStageId?: string;
  stageRuntime?: import("../types.js").StageRuntimeState;
  approvalRequest?: import("../types.js").ApprovalRequest;
  lastError?: string;
  /** Isolated workspace metadata needed to resume safely without touching the source repo */
  worktree?: {
    worktreePath: string;
    branchName: string;
    baseCommit: string;
    evidenceDir: string;
    setupDurationMs?: number;
    warmed?: boolean;
    repoPath?: string;
    repoHead?: string;
    repoStatus?: string;
    repoFingerprint?: string;
    originalRepoCleanBeforeApply?: boolean;
  };
}

/**
 * Save run state for resume capability.
 */
export async function saveRunState(runDir: string, state: RunState): Promise<void> {
  await writeJsonAtomic(join(runDir, "state.json"), state, { backup: true });
}

/**
 * Load run state for resume.
 * Returns null if no state file exists (run was completed or never started).
 */
export async function loadRunState(runDir: string): Promise<RunState | null> {
  return readJsonFile<RunState>(join(runDir, "state.json"));
}

export async function loadRecordedIterations(runDir: string): Promise<IterationRecord[]> {
  const filePath = join(runDir, "iterations.jsonl");
  if (!existsSync(filePath)) return [];
  const raw = await readFile(filePath, "utf-8").catch(() => "");
  const iterations: IterationRecord[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as IterationRecord;
      if (typeof parsed.index === "number") iterations.push(parsed);
    } catch {
      // A process can stop between append writes. Preserve all complete lines.
    }
  }
  return iterations.sort((a, b) => a.index - b.index);
}

export async function truncateRecordedIterations(
  runDir: string,
  maxIteration: number,
): Promise<IterationRecord[]> {
  const kept = (await loadRecordedIterations(runDir)).filter(
    (record) => record.index <= maxIteration,
  );
  const content = kept.map((record) => JSON.stringify(record)).join("\n");
  // Atomic replace: a crash mid-rewind must not destroy the iteration history.
  const { writeTextAtomic } = await import("./atomicJson.js");
  await writeTextAtomic(join(runDir, "iterations.jsonl"), content ? `${content}\n` : "");
  return kept;
}

export async function validateResumeState(
  runDir: string,
  state: RunState,
): Promise<{ valid: true } | { valid: false; reason: string }> {
  if (!state.useWorktree) return { valid: true };
  if (!state.worktree) return { valid: false, reason: "saved workspace metadata is missing" };
  const stateRoot = resolve(runDir, "..");
  const worktreePath = resolve(state.worktree.worktreePath);
  if (!isPathInside(stateRoot, worktreePath)) {
    return { valid: false, reason: "saved workspace is outside the Verdikt state directory" };
  }
  if (!existsSync(worktreePath)) {
    return { valid: false, reason: "saved workspace no longer exists" };
  }
  return { valid: true };
}

/**
 * Check if a run is resumable: a valid state.json is the single criterion.
 *
 * A summary.json does NOT disqualify a run — interrupted and provider_error
 * runs intentionally write both a summary (for history) and state (for
 * continuation). See trace/lifecycle.ts for the full status derivation.
 */
export async function isRunResumable(runDir: string): Promise<boolean> {
  const state = await loadRunState(runDir);
  if (!state) return false;
  return (await validateResumeState(runDir, state)).valid;
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

function isPathInside(basePath: string, targetPath: string): boolean {
  const relativePath = relative(resolve(basePath), resolve(targetPath));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}
