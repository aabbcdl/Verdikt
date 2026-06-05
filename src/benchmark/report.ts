/**
 * Benchmark report generator.
 *
 * Produces benchmark.json and benchmark.md from task results.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BenchmarkResult, BenchmarkTaskResult } from "./types.js";

/**
 * Write benchmark.json (machine-readable).
 */
export async function writeBenchmarkJson(
  runDir: string,
  result: BenchmarkResult,
): Promise<string> {
  const path = join(runDir, "benchmark.json");
  await writeFile(path, JSON.stringify(result, null, 2));
  return path;
}

/**
 * Write benchmark.md (human-readable).
 */
export async function writeBenchmarkMd(
  runDir: string,
  result: BenchmarkResult,
): Promise<string> {
  const path = join(runDir, "benchmark.md");
  const md = renderMarkdown(result);
  await writeFile(path, md);
  return path;
}

function renderMarkdown(result: BenchmarkResult): string {
  const { totals, metrics, tasks } = result;
  const lines: string[] = [];

  lines.push(`# Benchmark: ${result.suiteId}`);
  lines.push("");
  lines.push(`**Status:** ${result.status}`);
  lines.push(`**Started:** ${result.startedAt}`);
  lines.push(`**Completed:** ${result.completedAt}`);
  lines.push("");

  // Summary metrics
  lines.push("## Summary");
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|------:|`);
  lines.push(`| Tasks | ${totals.tasks} |`);
  lines.push(`| Passed | ${totals.passed} |`);
  lines.push(`| Failed | ${totals.failed} |`);
  lines.push(`| Errors | ${totals.errors} |`);
  lines.push(`| Success Rate | ${pct(metrics.successRate)} |`);
  lines.push(`| Expected Outcome Rate | ${pct(metrics.expectedOutcomeRate)} |`);
  lines.push(`| First Try Pass Rate | ${pct(metrics.firstTryPassRate)} |`);
  lines.push(`| Multi-Round Recovery Rate | ${pct(metrics.multiRoundRecoveryRate)} |`);
  lines.push(`| Recoverable Failure Samples | ${metrics.recoverableFailureSampleCount} |`);
  if (metrics.recoverableFailureSampleCount > 0) {
    lines.push(`| Recoverable Failure Recovery Rate | ${pct(metrics.recoverableFailureRecoveryRate)} |`);
  }
  if (metrics.expectedFailedStopRate >= 0) {
    lines.push(`| Expected-Failed Stop Rate | ${pct(metrics.expectedFailedStopRate)} |`);
  }
  lines.push(`| Infrastructure Error Rate | ${pct(metrics.infrastructureErrorRate)} |`);
  lines.push(`| Avg Iterations | ${metrics.avgIterations} |`);
  lines.push(`| Avg Cost | \\$${metrics.avgCostUsd.toFixed(2)} |`);
  lines.push(`| Avg Duration | ${fmtDuration(metrics.avgDurationMs)} |`);
  lines.push(`| Avg Files Changed | ${metrics.avgFilesChanged} |`);
  lines.push(`| Avg Patch Size (lines) | ${metrics.avgPatchSize} |`);
  lines.push("");

  // Failure reasons
  const reasons = Object.entries(metrics.failureReasons);
  if (reasons.length > 0) {
    lines.push("## Failure Reasons");
    lines.push("");
    lines.push(`| Reason | Count |`);
    lines.push(`|--------|------:|`);
    for (const [reason, count] of reasons) {
      lines.push(`| ${reason} | ${count} |`);
    }
    lines.push("");
  }

  // Task details
  lines.push("## Task Details");
  lines.push("");
  lines.push(`| Task | Category | Expected | Actual | Match | Iter | Cost | Risk | Stop Reason |`);
  lines.push(`|------|----------|----------|--------|:-----:|-----:|-----:|------|-------------|`);
  for (const t of tasks) {
    const match = t.matchedExpectation ? "✅" : "❌";
    const actual = t.actualStatus === "error" ? `⚠️ ${t.errorMessage || "error"}` : t.actualStatus;
    const risk = t.semanticRisk && t.semanticRisk !== "none" ? `⚠️ ${t.semanticRisk}` : "—";
    lines.push(
      `| ${t.taskId} | ${t.category} | ${t.expectedOutcome} | ${actual} | ${match} | ${t.iterations} | \\$${t.costUsd.toFixed(2)} | ${risk} | ${t.stopReason || "—"} |`,
    );
  }
  lines.push("");

  return lines.join("\n");
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}
