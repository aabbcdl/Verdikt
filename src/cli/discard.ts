/**
 * CLI handler for `verdikt discard` command.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export async function handleDiscard(args: string[]): Promise<void> {
  const runId = args[0];
  if (!runId) {
    console.error("Error: run-id is required");
    console.error("Usage: verdikt discard <run-id>");
    process.exit(1);
  }

  const config = (await import("../config.js")).getConfig();
  const runDir = resolve(config.stateDir, runId);
  const worktreePath = join(runDir, "workspace");

  if (!existsSync(runDir)) {
    console.error(`\n❌ Run not found: ${runId}`);
    console.error('\nUse "verdikt list" to see available runs.');
    process.exit(1);
  }

  if (existsSync(worktreePath)) {
    const { discardRun } = await import("../workspace/worktree.js");

    // Try to get repoPath from task.json
    const taskPath = join(runDir, "task.json");
    let repoPath = process.cwd();
    if (existsSync(taskPath)) {
      const task = JSON.parse(readFileSync(taskPath, "utf-8"));
      repoPath = task.repoPath;
    }

    const branchName = `verdikt/${runId}`;
    await discardRun(repoPath, worktreePath, branchName);
    console.log(`✅ Workspace discarded for run ${runId}`);
  } else {
    console.log(`No workspace found for run ${runId} (already cleaned up)`);
  }
}
