/**
 * Benchmark metrics calculation.
 *
 * Computes aggregate metrics from per-task results.
 * All metrics are derived from benchmark task results, not raw logs.
 */

import { coerceUsageSummary } from "../usage.js";
import type { BenchmarkMetrics, BenchmarkTaskResult, BenchmarkTotals } from "./types.js";

/**
 * Compute totals from task results.
 */
export function computeTotals(tasks: BenchmarkTaskResult[]): BenchmarkTotals {
  const passed = tasks.filter((t) => t.actualStatus === "passed").length;
  const failed = tasks.filter((t) => t.actualStatus === "failed").length;
  const errors = tasks.filter((t) => t.actualStatus === "error").length;

  const expectedPassed = tasks.filter((t) => t.expectedOutcome === "passed").length;
  const expectedFailed = tasks.filter((t) => t.expectedOutcome === "failed").length;

  // unexpected: expected passed but got failed/error, or expected failed but got passed
  const unexpectedFailures = tasks.filter(
    (t) => t.expectedOutcome === "passed" && t.actualStatus !== "passed",
  ).length;
  const unexpectedPasses = tasks.filter(
    (t) => t.expectedOutcome === "failed" && t.actualStatus === "passed",
  ).length;

  return {
    tasks: tasks.length,
    passed,
    failed,
    errors,
    expectedPassed,
    expectedFailed,
    unexpectedFailures,
    unexpectedPasses,
  };
}

/**
 * Compute aggregate metrics from task results.
 */
export function computeMetrics(tasks: BenchmarkTaskResult[]): BenchmarkMetrics {
  const validTasks = tasks.filter((t) => t.actualStatus !== "error");
  const completedTasks = tasks.filter((t) => t.runId !== null);
  const passedTasks = tasks.filter((t) => t.actualStatus === "passed");

  // Success rate: passed / total (excluding errors)
  const successRate = validTasks.length > 0 ? passedTasks.length / validTasks.length : 0;

  // Expected outcome rate: matched expectations / total
  const matchedCount = tasks.filter((t) => t.matchedExpectation).length;
  const expectedOutcomeRate = tasks.length > 0 ? matchedCount / tasks.length : 0;

  // Average iterations (only for completed tasks)
  const avgIterations =
    completedTasks.length > 0
      ? completedTasks.reduce((sum, t) => sum + t.iterations, 0) / completedTasks.length
      : 0;

  // Average cost is calculated only from samples with a reported value.
  const costSamples = completedTasks.map((task) => ({
    task,
    usage: coerceUsageSummary(
      task.usage ?? { status: task.usageStatus, costUsd: task.costUsd },
      task.usageStatus === "unknown" ? undefined : task.costUsd,
    ),
  }));
  const knownCostSamples = costSamples.filter(
    ({ usage }) => usage.status !== "unknown" && usage.costUsd !== undefined,
  );
  const partialCostSamples = costSamples.filter(({ usage }) => usage.status === "partial").length;
  const unknownCostSamples = costSamples.filter(({ usage }) => usage.status === "unknown").length;
  const avgCostUsd =
    knownCostSamples.length > 0
      ? knownCostSamples.reduce((sum, { task }) => sum + task.costUsd, 0) / knownCostSamples.length
      : 0;
  const avgCostStatus =
    knownCostSamples.length === 0
      ? "unknown"
      : partialCostSamples > 0 || unknownCostSamples > 0
        ? "partial"
        : "complete";

  // Average duration
  const avgDurationMs =
    completedTasks.length > 0
      ? completedTasks.reduce((sum, t) => sum + t.durationMs, 0) / completedTasks.length
      : 0;

  // First try pass rate: passed in exactly 1 iteration / total
  const firstTryPass = completedTasks.filter(
    (t) => t.actualStatus === "passed" && t.iterations === 1,
  ).length;
  const firstTryPassRate = completedTasks.length > 0 ? firstTryPass / completedTasks.length : 0;

  // Multi-round recovery rate: first failed then passed / all first failed
  const firstRoundFailed = completedTasks.filter((t) => t.iterations > 1);
  const recoveredPassed = firstRoundFailed.filter((t) => t.actualStatus === "passed").length;
  const multiRoundRecoveryRate =
    firstRoundFailed.length > 0 ? recoveredPassed / firstRoundFailed.length : 0;

  // Failure reasons distribution
  const failureReasons: Record<string, number> = {};
  for (const t of completedTasks) {
    if (t.stopReason && t.stopReason !== "passed") {
      failureReasons[t.stopReason] = (failureReasons[t.stopReason] || 0) + 1;
    }
  }

  // Integrity issues
  const integrityCriticalCount = tasks.filter((t) => t.integrityStatus === "violations").length;
  const integrityWarningCount = 0; // Could be extracted from summary if needed

  // M4.2: Refined recovery metrics
  // Recoverable failures: expected-passed tasks that failed first iteration
  const recoverableFailures = completedTasks.filter(
    (t) => t.expectedOutcome === "passed" && t.iterations > 1 && t.actualStatus !== "error",
  );
  const recoverableRecoveries = recoverableFailures.filter(
    (t) => t.actualStatus === "passed",
  ).length;

  // Expected-failed tasks that correctly stopped
  const expectedFailed = completedTasks.filter((t) => t.expectedOutcome === "failed");
  const expectedFailedStopped = expectedFailed.filter((t) => t.actualStatus === "failed").length;

  // Average files changed and patch size
  const tasksWithChanges = completedTasks.filter((t) => t.filesChanged > 0);
  const avgFilesChanged =
    tasksWithChanges.length > 0
      ? tasksWithChanges.reduce((sum, t) => sum + t.filesChanged, 0) / tasksWithChanges.length
      : 0;
  const avgPatchSize =
    tasksWithChanges.length > 0
      ? tasksWithChanges.reduce((sum, t) => sum + t.linesAdded + t.linesDeleted, 0) /
        tasksWithChanges.length
      : 0;

  const measuredTasks = completedTasks.filter((task) => typeof task.passRate === "number");
  const attemptSuccessRate =
    measuredTasks.length > 0
      ? measuredTasks.reduce((sum, task) => sum + (task.passRate ?? 0), 0) / measuredTasks.length
      : successRate;
  const flakyTaskRate =
    completedTasks.length > 0
      ? completedTasks.filter((task) => task.flaky === true).length / completedTasks.length
      : 0;
  const medianDurations = completedTasks
    .map((task) => task.medianDurationMs)
    .filter((value): value is number => typeof value === "number")
    .sort((a, b) => a - b);
  const medianDurationMs =
    medianDurations.length > 0
      ? (medianDurations[Math.floor((medianDurations.length - 1) / 2)] +
          medianDurations[Math.ceil((medianDurations.length - 1) / 2)]) /
        2
      : avgDurationMs;
  const worstDurationMs = Math.max(
    0,
    ...completedTasks.map((task) => task.worstDurationMs ?? task.durationMs),
  );

  return {
    successRate: round(successRate),
    expectedOutcomeRate: round(expectedOutcomeRate),
    avgIterations: round(avgIterations),
    avgCostUsd: round(avgCostUsd, 4),
    costSampleCount: knownCostSamples.length,
    partialCostSamples,
    unknownCostSamples,
    costCoverageRate:
      completedTasks.length > 0 ? round(knownCostSamples.length / completedTasks.length, 4) : 0,
    avgCostStatus,
    avgDurationMs: round(avgDurationMs),
    firstTryPassRate: round(firstTryPassRate),
    multiRoundRecoveryRate: round(multiRoundRecoveryRate),
    // M4.2: Refined recovery metrics
    recoverableFailureSampleCount: recoverableFailures.length,
    recoverableFailureRecoveryRate:
      recoverableFailures.length > 0
        ? round(recoverableRecoveries / recoverableFailures.length)
        : -1, // -1 = N/A (no samples)
    expectedFailedStopRate:
      expectedFailed.length > 0 ? round(expectedFailedStopped / expectedFailed.length) : -1,
    infrastructureErrorRate:
      tasks.length > 0
        ? round(tasks.filter((t) => t.actualStatus === "error").length / tasks.length)
        : 0,
    failureReasons,
    integrityCriticalCount,
    integrityWarningCount,
    avgFilesChanged: round(avgFilesChanged),
    avgPatchSize: round(avgPatchSize),
    attemptSuccessRate: round(attemptSuccessRate, 4),
    flakyTaskRate: round(flakyTaskRate, 4),
    medianDurationMs: round(medianDurationMs),
    worstDurationMs: round(worstDurationMs),
  };
}

function round(n: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}
