/**
 * CLI handler for `verdikt resume` command.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { resumeSupervisorLoop } from "../loop/supervisor.js";
import { coerceUsageSummary, formatCost } from "../usage.js";
import { cliSuccess, cliWarning, notFoundError } from "./errors.js";
import { EXIT_CODES } from "./errors.js";
import { isPathInside, isValidRunId } from "./localServer.js";
import { hasFlag, parseArgs } from "./parseArgs.js";

export async function handleResume(args: string[]): Promise<void> {
  if (args.length === 0) {
    notFoundError(
      "Run ID",
      "",
      'Usage: verdikt resume <run-id>\nUse "verdikt list" to see available runs.',
    );
  }
  const parsed = parseArgs(args, {
    boolean: ["json"],
    positional: { min: 1, max: 1, names: ["run-id"] },
  });
  const runId = parsed.positional[0];

  const config = (await import("../config.js")).getConfig();
  const stateDir = resolve(config.stateDir);
  const runDir = resolve(stateDir, runId);
  if (!isValidRunId(runId) || !isPathInside(stateDir, runDir)) {
    notFoundError("Run", runId, "Invalid run ID.");
  }

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

  const jsonOutput = hasFlag(parsed, "json");

  if (!jsonOutput) {
    const { loadRunState } = await import("../trace/recorder.js");
    const state = await loadRunState(runDir);
    if (state) {
      console.log(`\n🔄 Resuming run ${runId}`);
      console.log(`   Task: ${state.task.id}`);
      console.log(`   From iteration: ${state.nextIteration + 1}`);
      const usage = coerceUsageSummary(
        state.usage ?? { status: state.usageStatus, costUsd: state.totalCostUsd },
        state.totalCostUsd,
      );
      console.log(`   Cost so far: ${formatCost(usage, 4)}`);
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
      usageStatus: result.usageStatus ?? result.usage?.status ?? "complete",
      usage: result.usage ?? null,
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
