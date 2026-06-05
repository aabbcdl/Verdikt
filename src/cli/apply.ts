/**
 * CLI handler for `verdikt apply` command.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export async function handleApply(args: string[]): Promise<void> {
  const runId = args[0];
  if (!runId) {
    console.error("Error: run-id is required");
    console.error("Usage: verdikt apply <run-id>");
    process.exit(1);
  }

  const config = (await import("../config.js")).getConfig();
  const runDir = resolve(config.stateDir, runId);
  const summaryPath = join(runDir, "summary.json");
  const patchPath = join(runDir, "evidence", "final.patch");

  if (!existsSync(summaryPath)) {
    console.error(`\n❌ Run not found: ${runId}`);
    console.error('\nUse "verdikt list" to see available runs.');
    process.exit(1);
  }

  const summary = JSON.parse(readFileSync(summaryPath, "utf-8"));
  if (summary.stopReason !== "passed") {
    console.error(
      `\n❌ Cannot apply: run stopped with reason "${summary.stopReason}", not "passed".`,
    );
    console.error(`Only passing runs can be applied. Use "verdikt view ${runId}" to see details.`);
    process.exit(1);
  }

  if (!existsSync(patchPath)) {
    console.error(`\n❌ No final patch found for run ${runId}.`);
    console.error(
      "This run may have used --auto-apply or --no-worktree (changes applied immediately).",
    );
    process.exit(1);
  }

  // Read the task to get the repo path
  const taskPath = join(runDir, "task.json");
  let repoPath: string;
  if (existsSync(taskPath)) {
    const task = JSON.parse(readFileSync(taskPath, "utf-8"));
    repoPath = task.repoPath;
  } else {
    // Fallback: try to find repoPath from the summary
    console.error("Warning: task.json not found, patch will be applied to current directory");
    repoPath = process.cwd();
  }

  // Apply the patch using git apply
  const { exec } = await import("node:child_process");
  await new Promise<void>((resolve, reject) => {
    exec(`git apply "${patchPath}"`, { cwd: repoPath }, (err, _s, stderr) => {
      if (err) {
        reject(new Error(`Failed to apply patch: ${stderr || err.message}`));
      } else {
        resolve();
      }
    });
  });

  console.log(`✅ Patch applied from run ${runId}`);
  console.log(`   Repo: ${repoPath}`);
  console.log(`   Patch: ${patchPath}`);
}
