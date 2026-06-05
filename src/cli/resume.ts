/**
 * CLI handler for `verdikt resume` command.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { resumeSupervisorLoop } from "../loop/supervisor.js";
import { cliSuccess, cliWarning, notFoundError } from "./errors.js";
import { EXIT_CODES } from "./errors.js";

export async function handleResume(args: string[]): Promise<void> {
  const runId = args[0];
  if (!runId) {
    notFoundError(
      "Run ID",
      "",
      'Usage: verdikt resume <run-id>\nUse "verdikt list" to see available runs.',
    );
  }

  const config = (await import("../config.js")).getConfig();
  const runDir = resolve(config.stateDir, runId);
  const statePath = join(runDir, "state.json");
  const summaryPath = join(runDir, "summary.json");

  if (!existsSync(statePath)) {
    if (existsSync(summaryPath)) {
      notFoundError(
        "Resumable run",
        runId,
        `Run ${runId} already completed (has summary.json). Cannot resume.`,
      );
    } else {
      notFoundError(
        "Run",
        runId,
        'Run not found or has no saved state. Use "verdikt list" to see available runs.',
      );
    }
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

  // Resume uses resumeSupervisorLoop directly (no placeholderTask needed)
  const result = await resumeSupervisorLoop(runDir, { stream: !jsonOutput });

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
    if (!jsonOutput) cliSuccess("Task completed successfully!");
    process.exit(EXIT_CODES.SUCCESS);
  } else {
    if (!jsonOutput) cliWarning(`Task stopped: ${result.reason}`);
    process.exit(EXIT_CODES.TASK_FAILED);
  }
}
