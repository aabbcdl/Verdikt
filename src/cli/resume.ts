/**
 * CLI handler for `verdikt resume` command.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { runSupervisorLoop } from "../loop/supervisor.js";
import type { TaskSpec } from "../types.js";

export async function handleResume(args: string[]): Promise<void> {
  const runId = args[0];
  if (!runId) {
    console.error("\n❌ Run ID is required");
    console.error("Usage: verdikt resume <run-id>");
    console.error('\nUse "verdikt list" to see available runs.');
    process.exit(1);
  }

  const config = (await import("../config.js")).getConfig();
  const runDir = resolve(config.stateDir, runId);
  const statePath = join(runDir, "state.json");
  const summaryPath = join(runDir, "summary.json");

  if (!existsSync(statePath)) {
    if (existsSync(summaryPath)) {
      console.error(`\n❌ Run ${runId} already completed (has summary.json). Cannot resume.`);
    } else {
      console.error(`\n❌ Run ${runId} not found or has no saved state.`);
    }
    console.error('\nUse "verdikt list" to see available runs.');
    process.exit(1);
  }

  const jsonOutput = args.includes("--json");

  if (!jsonOutput) {
    const { loadRunState } = await import("../trace/recorder.js");
    const state = await loadRunState(runDir);
    if (state) {
      console.log(`\n🔄 Resuming run ${runId}`);
      console.log(`   Task: ${state.task.id}`);
      console.log(`   From iteration: ${state.nextIteration + 1}`);
      console.log(`   Cost so far: $${state.totalCostUsd.toFixed(4)}`);
      console.log(`   Last saved: ${state.lastSavedAt}\n`);
    }
  }

  // Resume mode: task will be loaded from saved state inside runSupervisorLoop
  const placeholderTask: TaskSpec = {
    id: "",
    goal: "",
    repoPath: "",
    acceptance: {},
    maxIterations: 0,
  };
  const result = await runSupervisorLoop(placeholderTask, {
    resumeFrom: runDir,
    stream: !jsonOutput,
  });

  if (jsonOutput) {
    const output = {
      taskId: result.taskId,
      passed: result.reason === "passed",
      stopReason: result.reason,
      iterations: result.iterations.length,
      totalCostUsd: result.totalCostUsd,
      totalDurationMs: result.totalDurationMs,
      runId: result.runId ?? null,
    };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  }

  if (result.reason === "passed") {
    if (!jsonOutput) console.log("✅ Task completed successfully!");
    process.exit(0);
  } else {
    if (!jsonOutput) console.log(`⚠️  Task stopped: ${result.reason}`);
    process.exit(1);
  }
}
