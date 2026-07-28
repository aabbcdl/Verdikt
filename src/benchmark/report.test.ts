import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeBenchmarkMd } from "./report.js";
import type { BenchmarkResult } from "./types.js";

let tempDir = "";
afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

describe("benchmark markdown report", () => {
  it("shows repeat statistics, attempts, and environment", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "verdikt-report-"));
    const result = {
      benchmarkId: "bench-1",
      suiteId: "suite-1",
      startedAt: "2026-07-17T00:00:00.000Z",
      completedAt: "2026-07-17T00:01:00.000Z",
      status: "completed",
      repeats: 3,
      warmups: 1,
      environment: {
        node: "v22.0.0",
        platform: "win32",
        arch: "x64",
        model: "sonnet",
        verdiktVersion: "1.2.3",
        gitCommit: "abc123",
      },
      totals: {
        tasks: 1,
        passed: 1,
        failed: 0,
        errors: 0,
        expectedPassed: 1,
        expectedFailed: 0,
        unexpectedFailures: 0,
        unexpectedPasses: 0,
      },
      metrics: {
        successRate: 1,
        expectedOutcomeRate: 1,
        avgIterations: 1,
        avgCostUsd: 0.2,
        avgCostStatus: "partial",
        costSampleCount: 1,
        partialCostSamples: 1,
        unknownCostSamples: 0,
        costCoverageRate: 1,
        avgDurationMs: 1200,
        firstTryPassRate: 1,
        multiRoundRecoveryRate: 0,
        recoverableFailureSampleCount: 0,
        recoverableFailureRecoveryRate: 0,
        expectedFailedStopRate: -1,
        infrastructureErrorRate: 0,
        failureReasons: {},
        integrityCriticalCount: 0,
        integrityWarningCount: 0,
        avgFilesChanged: 1,
        avgPatchSize: 2,
        attemptSuccessRate: 2 / 3,
        flakyTaskRate: 1,
        medianDurationMs: 1200,
        worstDurationMs: 2400,
      },
      tasks: [
        {
          taskId: "task-1",
          category: "small",
          expectedOutcome: "passed",
          actualStatus: "passed",
          matchedExpectation: true,
          runId: "run-3",
          summaryPath: "summary.json",
          iterations: 1,
          costUsd: 0.2,
          durationMs: 1200,
          stopReason: "passed",
          filesChanged: 1,
          linesAdded: 2,
          linesDeleted: 0,
          integrityStatus: "ok",
          passRate: 2 / 3,
          medianDurationMs: 1200,
          worstDurationMs: 2400,
          durationStdDevMs: 500,
          flaky: true,
          totalCostUsd: 0.6,
          usageStatus: "partial",
          attempts: [
            {
              attempt: 1,
              runId: "run-1",
              summaryPath: "a",
              actualStatus: "passed",
              matchedExpectation: true,
              iterations: 1,
              costUsd: 0.2,
              durationMs: 1000,
              stopReason: "passed",
              filesChanged: 1,
              linesAdded: 2,
              linesDeleted: 0,
              integrityStatus: "ok",
            },
            {
              attempt: 2,
              runId: "run-2",
              summaryPath: "b",
              actualStatus: "failed",
              matchedExpectation: false,
              iterations: 2,
              costUsd: 0,
              usageStatus: "unknown",
              durationMs: 2400,
              stopReason: "no_progress",
              filesChanged: 1,
              linesAdded: 2,
              linesDeleted: 0,
              integrityStatus: "ok",
            },
            {
              attempt: 3,
              runId: "run-3",
              summaryPath: "c",
              actualStatus: "passed",
              matchedExpectation: true,
              iterations: 1,
              costUsd: 0.2,
              durationMs: 1200,
              stopReason: "passed",
              filesChanged: 1,
              linesAdded: 2,
              linesDeleted: 0,
              integrityStatus: "ok",
            },
          ],
        },
      ],
    } satisfies BenchmarkResult;

    const path = await writeBenchmarkMd(tempDir, result);
    const report = await readFile(path, "utf-8");
    expect(report).toContain("Repeats | 3");
    expect(report).toContain("Attempt Success Rate");
    expect(report).toContain("Flaky Task Rate");
    expect(report).toContain("## Environment");
    expect(report).toContain("sonnet");
    expect(report).toContain("### task-1 Attempts");
    expect(report).toContain("no_progress");
    expect(report).toContain("Avg Cost | $0.20+");
    expect(report).toContain("Cost Samples | 1/1");
    expect(report).toContain("$0.60+");
    expect(report).toContain("| unknown | no_progress");
  });
});
