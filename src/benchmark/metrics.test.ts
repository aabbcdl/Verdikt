/**
 * Tests for benchmark metrics and suite parsing.
 */

import { describe, it, expect } from "vitest";
import { computeTotals, computeMetrics } from "./metrics.js";
import type { BenchmarkTaskResult } from "./types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTaskResult(overrides: Partial<BenchmarkTaskResult> = {}): BenchmarkTaskResult {
  return {
    taskId: "test-task",
    category: "small",
    expectedOutcome: "passed",
    actualStatus: "passed",
    matchedExpectation: true,
    runId: "run-001",
    summaryPath: "/tmp/summary.json",
    iterations: 1,
    costUsd: 0.5,
    durationMs: 10000,
    stopReason: "passed",
    filesChanged: 1,
    linesAdded: 5,
    linesDeleted: 3,
    integrityStatus: "ok",
    ...overrides,
  };
}

// ── computeTotals ────────────────────────────────────────────────────────────

describe("computeTotals", () => {
  it("counts passed and failed tasks", () => {
    const tasks = [
      makeTaskResult({ actualStatus: "passed" }),
      makeTaskResult({ actualStatus: "failed" }),
      makeTaskResult({ actualStatus: "passed" }),
    ];
    const totals = computeTotals(tasks);
    expect(totals.tasks).toBe(3);
    expect(totals.passed).toBe(2);
    expect(totals.failed).toBe(1);
    expect(totals.errors).toBe(0);
  });

  it("counts errors separately", () => {
    const tasks = [
      makeTaskResult({ actualStatus: "passed" }),
      makeTaskResult({ actualStatus: "error" }),
    ];
    const totals = computeTotals(tasks);
    expect(totals.errors).toBe(1);
    expect(totals.passed).toBe(1);
  });

  it("detects unexpected failures", () => {
    const tasks = [
      makeTaskResult({ expectedOutcome: "passed", actualStatus: "failed" }),
    ];
    const totals = computeTotals(tasks);
    expect(totals.unexpectedFailures).toBe(1);
    expect(totals.unexpectedPasses).toBe(0);
  });

  it("detects unexpected passes", () => {
    const tasks = [
      makeTaskResult({ expectedOutcome: "failed", actualStatus: "passed" }),
    ];
    const totals = computeTotals(tasks);
    expect(totals.unexpectedPasses).toBe(1);
    expect(totals.unexpectedFailures).toBe(0);
  });

  it("expected failed that fails = matched, not unexpected", () => {
    const tasks = [
      makeTaskResult({ expectedOutcome: "failed", actualStatus: "failed", matchedExpectation: true }),
    ];
    const totals = computeTotals(tasks);
    expect(totals.unexpectedFailures).toBe(0);
    expect(totals.unexpectedPasses).toBe(0);
  });
});

// ── computeMetrics ───────────────────────────────────────────────────────────

describe("computeMetrics", () => {
  it("calculates success rate", () => {
    const tasks = [
      makeTaskResult({ actualStatus: "passed" }),
      makeTaskResult({ actualStatus: "failed" }),
    ];
    const metrics = computeMetrics(tasks);
    expect(metrics.successRate).toBe(0.5);
  });

  it("calculates expected outcome rate", () => {
    const tasks = [
      makeTaskResult({ matchedExpectation: true }),
      makeTaskResult({ matchedExpectation: true }),
      makeTaskResult({ matchedExpectation: false }),
    ];
    const metrics = computeMetrics(tasks);
    expect(metrics.expectedOutcomeRate).toBeCloseTo(2 / 3);
  });

  it("calculates average iterations", () => {
    const tasks = [
      makeTaskResult({ iterations: 1 }),
      makeTaskResult({ iterations: 3 }),
    ];
    const metrics = computeMetrics(tasks);
    expect(metrics.avgIterations).toBe(2);
  });

  it("calculates first try pass rate", () => {
    const tasks = [
      makeTaskResult({ actualStatus: "passed", iterations: 1 }),
      makeTaskResult({ actualStatus: "passed", iterations: 1 }),
      makeTaskResult({ actualStatus: "passed", iterations: 3 }), // multi-round pass
      makeTaskResult({ actualStatus: "failed", iterations: 2 }),
    ];
    const metrics = computeMetrics(tasks);
    expect(metrics.firstTryPassRate).toBe(0.5); // 2 out of 4 completed in 1 try
  });

  it("calculates multi-round recovery rate", () => {
    const tasks = [
      makeTaskResult({ actualStatus: "passed", iterations: 1 }), // not counted (1 round)
      makeTaskResult({ actualStatus: "passed", iterations: 3 }), // recovered
      makeTaskResult({ actualStatus: "failed", iterations: 3 }), // not recovered
    ];
    const metrics = computeMetrics(tasks);
    // 2 tasks had multi-round, 1 recovered
    expect(metrics.multiRoundRecoveryRate).toBe(0.5);
  });

  it("records failure reasons", () => {
    const tasks = [
      makeTaskResult({ stopReason: "max_iterations", actualStatus: "failed" }),
      makeTaskResult({ stopReason: "no_progress", actualStatus: "failed" }),
      makeTaskResult({ stopReason: "max_iterations", actualStatus: "failed" }),
    ];
    const metrics = computeMetrics(tasks);
    expect(metrics.failureReasons).toEqual({
      max_iterations: 2,
      no_progress: 1,
    });
  });

  it("handles empty task list gracefully", () => {
    const metrics = computeMetrics([]);
    expect(metrics.successRate).toBe(0);
    expect(metrics.expectedOutcomeRate).toBe(0);
    expect(metrics.avgIterations).toBe(0);
  });

  it("excludes error tasks from success rate", () => {
    const tasks = [
      makeTaskResult({ actualStatus: "passed" }),
      makeTaskResult({ actualStatus: "error" }),
    ];
    const metrics = computeMetrics(tasks);
    // successRate = 1 passed / 1 valid (excluding error) = 1.0
    expect(metrics.successRate).toBe(1);
  });
});
