/**
 * CLI handler for `verdikt apply` command.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { refreshEvidenceManifest } from "../evidence/manifest.js";
import { appendRunEvent } from "../trace/events.js";
import { applyProtectedPatch } from "../workspace/applyPatch.js";
import { isPathInside } from "./localServer.js";
import { parseArgs } from "./parseArgs.js";
import { readTaskForSavedRun } from "./runStore.js";
import { readSavedRunRepoPath } from "./savedRun.js";

export { RevalidationRequiredError } from "../workspace/applyPatch.js";

function isValidRunId(runId: string): boolean {
  return /^[a-zA-Z0-9\-_]{1,64}$/.test(runId);
}

export interface ApplyRunResult {
  runId: string;
  repoPath: string;
  patchPath: string;
}

export async function applyPassedRun(runId: string): Promise<ApplyRunResult> {
  if (!isValidRunId(runId)) throw new Error("Invalid run ID");

  const config = (await import("../config.js")).getConfig();
  const stateDir = resolve(config.stateDir);
  const runDir = resolve(stateDir, runId);
  const summaryPath = join(runDir, "summary.json");
  const patchPath = join(runDir, "evidence", "final.patch");

  if (!isPathInside(stateDir, runDir) || !isPathInside(stateDir, summaryPath)) {
    throw new Error("Access denied");
  }
  if (!existsSync(summaryPath)) throw new Error(`Run not found: ${runId}`);

  const summary = JSON.parse(readFileSync(summaryPath, "utf-8")) as Record<string, unknown>;
  const savedWorkspace = isRecord(summary.workspace) ? summary.workspace : undefined;
  const worktreePath =
    typeof savedWorkspace?.path === "string"
      ? resolve(savedWorkspace.path)
      : join(runDir, "workspace");
  const branchName =
    typeof savedWorkspace?.branchName === "string" ? savedWorkspace.branchName : `verdikt/${runId}`;
  if (!isPathInside(stateDir, worktreePath)) throw new Error("Access denied");

  if (summary.stopReason !== "passed") {
    throw new Error(`Cannot apply: run stopped with reason "${summary.stopReason}", not "passed".`);
  }
  if (summary.applyStatus === "discarded") {
    throw new Error(`Cannot apply: run ${runId} was already discarded.`);
  }

  const repoPath = readSavedRunRepoPath({ stateDir, runDir, runId, action: "apply" });
  if (summary.applyStatus === "applied") {
    await cleanupAppliedRun(stateDir, runId, repoPath, worktreePath, branchName);
    return { runId, repoPath, patchPath };
  }

  if (!isPathInside(stateDir, patchPath)) throw new Error("Access denied");
  if (!existsSync(patchPath)) {
    throw new Error(
      `No final patch found for run ${runId}. This run may have used --auto-apply or --no-worktree.`,
    );
  }

  const task = await readTaskForSavedRun(stateDir, runId);
  const manualApplyHint =
    task?.allowDirtyRepo === true
      ? `该任务以 allowDirtyRepo 启动,通过后的补丁需要手动应用: ${patchPath}`
      : undefined;
  await applyProtectedPatch({
    stateDir,
    runDir,
    runId,
    repoPath,
    patchPath,
    task,
    savedWorkspace,
    worktreePath,
    branchName,
    revalidationHint: manualApplyHint,
  });

  const updatedSummary = {
    ...summary,
    applyStatus: "applied",
    appliedAt: new Date().toISOString(),
  };
  writeFileSync(summaryPath, JSON.stringify(updatedSummary, null, 2));
  await appendRunEvent(runDir, {
    type: "patch_applied",
    runId,
    data: { repoPath, patchPath },
  });
  await refreshEvidenceManifest(runDir);

  return { runId, repoPath, patchPath };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function cleanupAppliedRun(
  stateDir: string,
  runId: string,
  repoPath: string,
  worktreePath: string,
  branchName: string,
): Promise<void> {
  if (existsSync(worktreePath)) {
    const { discardRun } = await import("../workspace/worktree.js");
    await discardRun(repoPath, worktreePath, branchName);
  }
  const { releaseLock } = await import("../workspace/lock.js");
  releaseLock(stateDir, repoPath, runId);
}

export async function handleApply(args: string[]): Promise<void> {
  const { positional } = parseArgs(args, {
    positional: { min: 1, max: 1, names: ["run-id"] },
  });
  const runId = positional[0];

  try {
    const result = await applyPassedRun(runId);
    console.log(`Patch applied from run ${runId}`);
    console.log(`   Repo: ${result.repoPath}`);
    console.log(`   Patch: ${result.patchPath}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
