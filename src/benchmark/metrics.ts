/**
 * Benchmark metrics calculation.
 *
 * Computes aggregate metrics from per-task results.
 * All metrics are derived from benchmark task results, not raw logs.
 */

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

  // Average cost
  const avgCostUsd =
    completedTasks.length > 0
      ? completedTasks.reduce((sum, t) => sum + t.costUsd, 0) / completedTasks.length
      : 0;

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

  return {
    successRate: round(successRate),
    expectedOutcomeRate: round(expectedOutcomeRate),
    avgIterations: round(avgIterations),
    avgCostUsd: round(avgCostUsd, 4),
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
  };
}

function round(n: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}
