/**
 * Benchmark report generator.
 *
 * Produces benchmark.json and benchmark.md from task results.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { formatCost } from "../usage.js";
import type { BenchmarkResult } from "./types.js";

export async function writeBenchmarkJson(runDir: string, result: BenchmarkResult): Promise<string> {
  const path = join(runDir, "benchmark.json");
  await writeFile(path, JSON.stringify(result, null, 2));
  return path;
}

export async function writeBenchmarkMd(runDir: string, result: BenchmarkResult): Promise<string> {
  const path = join(runDir, "benchmark.md");
  await writeFile(path, renderMarkdown(result));
  return path;
}

function renderMarkdown(result: BenchmarkResult): string {
  const { totals, metrics, tasks } = result;
  const lines: string[] = [
    `# Benchmark: ${escapeCell(result.suiteId)}`,
    "",
    `**Status:** ${result.status}`,
    `**Started:** ${result.startedAt}`,
    `**Completed:** ${result.completedAt}`,
    "",
    "## Summary",
    "",
    "| Metric | Value |",
    "|--------|------:|",
    `| Tasks | ${totals.tasks} |`,
    `| Repeats | ${result.repeats ?? 1} |`,
    `| Warmups | ${result.warmups ?? 0} |`,
    `| Passed | ${totals.passed} |`,
    `| Failed | ${totals.failed} |`,
    `| Errors | ${totals.errors} |`,
    `| Success Rate | ${pct(metrics.successRate)} |`,
    `| Expected Outcome Rate | ${pct(metrics.expectedOutcomeRate)} |`,
    `| First Try Pass Rate | ${pct(metrics.firstTryPassRate)} |`,
    `| Multi-Round Recovery Rate | ${pct(metrics.multiRoundRecoveryRate)} |`,
    `| Recoverable Failure Samples | ${metrics.recoverableFailureSampleCount} |`,
  ];

  if (metrics.recoverableFailureSampleCount > 0) {
    lines.push(
      `| Recoverable Failure Recovery Rate | ${pct(metrics.recoverableFailureRecoveryRate)} |`,
    );
  }
  if (metrics.expectedFailedStopRate >= 0) {
    lines.push(`| Expected-Failed Stop Rate | ${pct(metrics.expectedFailedStopRate)} |`);
  }
  if (typeof metrics.attemptSuccessRate === "number") {
    lines.push(`| Attempt Success Rate | ${pct(metrics.attemptSuccessRate)} |`);
  }
  if (typeof metrics.flakyTaskRate === "number") {
    lines.push(`| Flaky Task Rate | ${pct(metrics.flakyTaskRate)} |`);
  }
  lines.push(`| Infrastructure Error Rate | ${pct(metrics.infrastructureErrorRate)} |`);
  lines.push(`| Avg Iterations | ${metrics.avgIterations} |`);
  lines.push(
    `| Avg Cost | ${formatCost({ status: metrics.avgCostStatus ?? "complete", costUsd: metrics.avgCostUsd }, 2)} |`,
  );
  if (typeof metrics.costSampleCount === "number") {
    lines.push(
      `| Cost Samples | ${metrics.costSampleCount}/${tasks.filter((task) => task.runId !== null).length} |`,
    );
  }
  if ((metrics.partialCostSamples ?? 0) > 0) {
    lines.push(`| Partial Cost Samples | ${metrics.partialCostSamples} |`);
  }
  if ((metrics.unknownCostSamples ?? 0) > 0) {
    lines.push(`| Unknown Cost Samples | ${metrics.unknownCostSamples} |`);
  }
  lines.push(`| Avg Duration | ${fmtDuration(metrics.avgDurationMs)} |`);
  if (typeof metrics.medianDurationMs === "number") {
    lines.push(`| Median Duration | ${fmtDuration(metrics.medianDurationMs)} |`);
  }
  if (typeof metrics.worstDurationMs === "number") {
    lines.push(`| Worst Duration | ${fmtDuration(metrics.worstDurationMs)} |`);
  }
  lines.push(`| Avg Files Changed | ${metrics.avgFilesChanged} |`);
  lines.push(`| Avg Patch Size (lines) | ${metrics.avgPatchSize} |`, "");

  if (result.environment) {
    const env = result.environment;
    lines.push(
      "## Environment",
      "",
      "| Item | Value |",
      "|------|-------|",
      `| Node | ${escapeCell(env.node)} |`,
      `| Platform | ${escapeCell(env.platform)} |`,
      `| Architecture | ${escapeCell(env.arch)} |`,
      `| Model | ${escapeCell(env.model)} |`,
      `| Verdikt | ${escapeCell(env.verdiktVersion ?? "-")} |`,
      `| Commit | ${escapeCell(env.gitCommit ?? "-")} |`,
      "",
    );
  }

  const reasons = Object.entries(metrics.failureReasons);
  if (reasons.length > 0) {
    lines.push("## Failure Reasons", "", "| Reason | Count |", "|--------|------:|");
    for (const [reason, count] of reasons) lines.push(`| ${escapeCell(reason)} | ${count} |`);
    lines.push("");
  }

  lines.push(
    "## Task Details",
    "",
    "| Task | Category | Expected | Actual | Match | Attempts | Pass Rate | Median | Worst | Variability | Total Cost | Flaky | Stop Reason |",
    "|------|----------|----------|--------|:-----:|---------:|----------:|-------:|------:|------------:|-----------:|:-----:|-------------|",
  );
  for (const task of tasks) {
    const match = task.matchedExpectation ? "\u2713" : "\u2717";
    const actual =
      task.actualStatus === "error"
        ? `warning: ${task.errorMessage || "error"}`
        : task.actualStatus;
    const attempts = task.attempts?.length ?? 1;
    lines.push(
      `| ${escapeCell(task.taskId)} | ${escapeCell(task.category)} | ${escapeCell(task.expectedOutcome)} | ${escapeCell(actual)} | ${match} | ${attempts} | ${pct(task.passRate ?? (task.actualStatus === "passed" ? 1 : 0))} | ${fmtDuration(task.medianDurationMs ?? task.durationMs)} | ${fmtDuration(task.worstDurationMs ?? task.durationMs)} | ${fmtDuration(task.durationStdDevMs ?? 0)} | ${formatCost({ status: task.usageStatus ?? "complete", costUsd: task.totalCostUsd ?? task.costUsd }, 2)} | ${task.flaky ? "yes" : "no"} | ${escapeCell(task.stopReason || "-")} |`,
    );
  }
  lines.push("");

  for (const task of tasks) {
    if (!task.attempts || task.attempts.length <= 1) continue;
    lines.push(
      `### ${escapeCell(task.taskId)} Attempts`,
      "",
      "| Attempt | Status | Match | Iterations | Duration | Cost | Stop Reason | Run |",
      "|--------:|--------|:-----:|-----------:|---------:|-----:|-------------|-----|",
    );
    for (const attempt of task.attempts) {
      lines.push(
        `| ${attempt.attempt} | ${escapeCell(attempt.actualStatus)} | ${attempt.matchedExpectation ? "\u2713" : "\u2717"} | ${attempt.iterations} | ${fmtDuration(attempt.durationMs)} | ${formatCost({ status: attempt.usageStatus ?? "complete", costUsd: attempt.costUsd }, 2)} | ${escapeCell(attempt.stopReason || "-")} | ${escapeCell(attempt.runId || "-")} |`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function fmtDuration(ms: number): string {
  if (ms <= 0) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function escapeCell(value: string): string {
  return String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
