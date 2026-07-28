/**
 * Benchmark suite types for Verdikt M3+.
 */

import type { UsageStatus, UsageSummary } from "../types.js";

export interface BenchmarkSuite {
  id: string;
  name?: string;
  description?: string;
  defaults?: BenchmarkDefaults;
  tasks: BenchmarkTaskSpec[];
  /** Measured attempts per task (default 1). */
  repeats?: number;
  /** Unmeasured warmup attempts per task (default 0). */
  warmups?: number;
  /** Stop the suite after the first unexpected aggregate result. */
  failFast?: boolean;
}

export interface BenchmarkTaskSpec {
  id: string;
  taskFile: string;
  category?: "small" | "medium" | "large" | "negative" | "regression";
  expectedOutcome?: "passed" | "failed" | "any";
  tags?: string[];
}

export interface BenchmarkDefaults {
  maxIterations?: number;
  budgetUsd?: number;
  worktree?: boolean;
  integrity?: boolean;
  autoApply?: boolean;
}

export interface BenchmarkEnvironment {
  node: string;
  platform: string;
  arch: string;
  model: string;
  verdiktVersion?: string;
  gitCommit?: string;
}

export interface BenchmarkResult {
  benchmarkId: string;
  suiteId: string;
  startedAt: string;
  completedAt: string;
  status: "completed" | "partial" | "error";
  totals: BenchmarkTotals;
  metrics: BenchmarkMetrics;
  tasks: BenchmarkTaskResult[];
  environment?: BenchmarkEnvironment;
  repeats?: number;
  warmups?: number;
}

export interface BenchmarkTotals {
  tasks: number;
  passed: number;
  failed: number;
  errors: number;
  expectedPassed: number;
  expectedFailed: number;
  unexpectedFailures: number;
  unexpectedPasses: number;
}

export interface BenchmarkMetrics {
  successRate: number;
  expectedOutcomeRate: number;
  avgIterations: number;
  avgCostUsd: number;
  /** Number of completed task samples with any reported spend. */
  costSampleCount?: number;
  /** Samples with a lower-bound spend but incomplete reporting. */
  partialCostSamples?: number;
  /** Samples with no trustworthy spend value. */
  unknownCostSamples?: number;
  /** Share of completed task samples included in avgCostUsd. */
  costCoverageRate?: number;
  /** Completeness of the aggregate cost metric. */
  avgCostStatus?: UsageStatus;
  avgDurationMs: number;
  firstTryPassRate: number;
  multiRoundRecoveryRate: number;
  recoverableFailureSampleCount: number;
  recoverableFailureRecoveryRate: number;
  expectedFailedStopRate: number;
  infrastructureErrorRate: number;
  failureReasons: Record<string, number>;
  integrityCriticalCount: number;
  integrityWarningCount: number;
  avgFilesChanged: number;
  avgPatchSize: number;
  attemptSuccessRate?: number;
  flakyTaskRate?: number;
  medianDurationMs?: number;
  worstDurationMs?: number;
}

export interface BenchmarkTaskAttemptResult {
  attempt: number;
  runId: string | null;
  summaryPath: string | null;
  actualStatus: "passed" | "failed" | "error";
  matchedExpectation: boolean;
  iterations: number;
  costUsd: number;
  usageStatus?: UsageStatus;
  usage?: UsageSummary;
  durationMs: number;
  stopReason: string | null;
  filesChanged: number;
  linesAdded: number;
  linesDeleted: number;
  integrityStatus: string;
  semanticRisk?: string;
  errorMessage?: string;
}

export interface BenchmarkTaskResult {
  taskId: string;
  category: string;
  expectedOutcome: string;
  actualStatus: "passed" | "failed" | "error";
  matchedExpectation: boolean;
  runId: string | null;
  summaryPath: string | null;
  iterations: number;
  costUsd: number;
  usageStatus?: UsageStatus;
  usage?: UsageSummary;
  durationMs: number;
  stopReason: string | null;
  filesChanged: number;
  linesAdded: number;
  linesDeleted: number;
  integrityStatus: string;
  semanticRisk?: string;
  errorMessage?: string;
  attempts?: BenchmarkTaskAttemptResult[];
  passRate?: number;
  medianDurationMs?: number;
  worstDurationMs?: number;
  durationStdDevMs?: number;
  flaky?: boolean;
  totalCostUsd?: number;
}
