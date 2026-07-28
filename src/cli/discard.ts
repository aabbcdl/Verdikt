/**
 * CLI handler for `verdikt discard` command.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { refreshEvidenceManifest } from "../evidence/manifest.js";
import { clearRunState } from "../trace/recorder.js";
import { isPathInside, isValidRunId } from "./localServer.js";
import { parseArgs } from "./parseArgs.js";
import { readSavedRunRepoPath } from "./savedRun.js";

export interface DiscardRunResult {
  runId: string;
  repoPath?: string;
  worktreePath: string;
  discarded: boolean;
}

export async function discardSavedRun(runId: string): Promise<DiscardRunResult> {
  if (!isValidRunId(runId)) throw new Error("Invalid run ID");

  const config = (await import("../config.js")).getConfig();
  const stateDir = resolve(config.stateDir);
  const runDir = resolve(stateDir, runId);
  if (!isPathInside(stateDir, runDir)) throw new Error("Access denied");
  if (!existsSync(runDir)) throw new Error(`Run not found: ${runId}`);

  const summary = readSummary(stateDir, runDir);
  if (summary?.applyStatus === "applied") {
    throw new Error(`Cannot discard: run ${runId} was already applied.`);
  }
  const workspace = isRecord(summary?.workspace) ? summary.workspace : undefined;
  const worktreePath =
    typeof workspace?.path === "string" ? resolve(workspace.path) : join(runDir, "workspace");
  const branchName =
    typeof workspace?.branchName === "string" ? workspace.branchName : `verdikt/${runId}`;
  if (!isPathInside(stateDir, worktreePath)) throw new Error("Access denied");

  if (!existsSync(worktreePath)) {
    markRunDiscarded(stateDir, runDir);
    await clearRunState(runDir);
    if (existsSync(join(runDir, "evidence", "manifest.json"))) {
      await refreshEvidenceManifest(runDir);
    }
    return { runId, worktreePath, discarded: false };
  }

  const repoPath = readSavedRunRepoPath({ stateDir, runDir, runId, action: "discard" });
  const { discardRun } = await import("../workspace/worktree.js");
  await discardRun(repoPath, worktreePath, branchName);
  const { releaseLock } = await import("../workspace/lock.js");
  releaseLock(stateDir, repoPath, runId);

  markRunDiscarded(stateDir, runDir);
  await clearRunState(runDir);
  await refreshEvidenceManifest(runDir);
  return { runId, repoPath, worktreePath, discarded: true };
}

function readSummary(stateDir: string, runDir: string): Record<string, unknown> | null {
  const summaryPath = join(runDir, "summary.json");
  if (!isPathInside(stateDir, summaryPath) || !existsSync(summaryPath)) return null;
  return JSON.parse(readFileSync(summaryPath, "utf-8")) as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function markRunDiscarded(stateDir: string, runDir: string): void {
  const summaryPath = join(runDir, "summary.json");
  if (isPathInside(stateDir, summaryPath) && existsSync(summaryPath)) {
    const summary = JSON.parse(readFileSync(summaryPath, "utf-8"));
    if (summary.applyStatus === "applied") return;
    writeFileSync(
      summaryPath,
      JSON.stringify(
        { ...summary, applyStatus: "discarded", discardedAt: new Date().toISOString() },
        null,
        2,
      ),
    );
  }
}

export async function handleDiscard(args: string[]): Promise<void> {
  const { positional } = parseArgs(args, {
    positional: { min: 1, max: 1, names: ["run-id"] },
  });
  const runId = positional[0];

  try {
    const result = await discardSavedRun(runId);
    if (result.discarded) console.log(`Workspace discarded for run ${runId}`);
    else console.log(`No workspace found for run ${runId} (already cleaned up)`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
