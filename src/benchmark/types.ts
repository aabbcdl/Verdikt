/**
 * Benchmark suite types for Verdikt M3.
 */

export interface BenchmarkSuite {
  id: string;
  name?: string;
  description?: string;
  defaults?: BenchmarkDefaults;
  tasks: BenchmarkTaskSpec[];
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

export interface BenchmarkResult {
  benchmarkId: string;
  suiteId: string;
  startedAt: string;
  completedAt: string;
  status: "completed" | "partial" | "error";
  totals: BenchmarkTotals;
  metrics: BenchmarkMetrics;
  tasks: BenchmarkTaskResult[];
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
  avgDurationMs: number;
  firstTryPassRate: number;
  multiRoundRecoveryRate: number;
  // M4.2: Refined recovery metrics
  recoverableFailureSampleCount: number;
  recoverableFailureRecoveryRate: number;
  expectedFailedStopRate: number;
  infrastructureErrorRate: number;
  failureReasons: Record<string, number>;
  integrityCriticalCount: number;
  integrityWarningCount: number;
  avgFilesChanged: number;
  avgPatchSize: number;
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
  durationMs: number;
  stopReason: string | null;
  filesChanged: number;
  linesAdded: number;
  linesDeleted: number;
  integrityStatus: string;
  semanticRisk?: string;
  errorMessage?: string;
}
