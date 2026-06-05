/**
 * Benchmark runner — executes a suite of Verdikt tasks.
 *
 * Each task runs through the existing supervisor with M2 safe defaults.
 * One failed task does not stop the benchmark.
 * Each task preserves its normal run evidence.
 */

import { readFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { runSupervisorLoop } from "../loop/supervisor.js";
import type { TaskSpec } from "../types.js";
import { createRunId } from "../trace/recorder.js";
import type {
  BenchmarkSuite,
  BenchmarkTaskSpec,
  BenchmarkTaskResult,
  BenchmarkResult,
  BenchmarkDefaults,
} from "./types.js";
import { computeTotals, computeMetrics } from "./metrics.js";
import { writeBenchmarkJson, writeBenchmarkMd } from "./report.js";

/**
 * Parse a benchmark suite file (JSON).
 */
export function loadSuite(suitePath: string): BenchmarkSuite {
  const raw = readFileSync(resolve(suitePath), "utf-8");
  const suite = JSON.parse(raw) as BenchmarkSuite;

  // Validate
  if (!suite.id) throw new Error("Suite must have an 'id' field");
  if (!suite.tasks || suite.tasks.length === 0) throw new Error("Suite must have at least one task");

  return suite;
}

/**
 * Run a full benchmark suite.
 *
 * Returns the benchmark result with aggregate metrics.
 */
export async function runBenchmark(
  suite: BenchmarkSuite,
  options: { outDir?: string; dryRun?: boolean } = {},
): Promise<BenchmarkResult> {
  const benchmarkId = `benchmark-${createRunId().replace("run-", "")}`;
  const outDir = options.outDir ?? `.verdikt/${benchmarkId}`;
  const tasksDir = join(outDir, "tasks");
  const startedAt = new Date().toISOString();

  log(`\n${"═".repeat(60)}`);
  log(`Benchmark: ${suite.id} (${benchmarkId})`);
  log(`Tasks: ${suite.tasks.length}`);
  log(`Output: ${outDir}`);
  log(`${"═".repeat(60)}\n`);

  await mkdir(tasksDir, { recursive: true });

  // Save suite config for reference
  await writeFile(join(outDir, "suite.json"), JSON.stringify(suite, null, 2));

  const taskResults: BenchmarkTaskResult[] = [];
  const defaults = suite.defaults ?? {};

  for (let i = 0; i < suite.tasks.length; i++) {
    const taskSpec = suite.tasks[i];
    log(`\n── Task ${i + 1}/${suite.tasks.length}: ${taskSpec.id} (${taskSpec.category ?? "uncategorized"}) ──`);

    if (options.dryRun) {
      log(`  [DRY RUN] Would run: ${taskSpec.taskFile}`);
      taskResults.push(makeErrorResult(taskSpec, "dry-run"));
      continue;
    }

    try {
      const result = await runSingleTask(taskSpec, defaults, tasksDir);
      taskResults.push(result);

      log(`  ▸ Result: ${result.actualStatus} | ${result.iterations} iter | $${result.costUsd.toFixed(2)} | ${result.stopReason ?? "—"} | match=${result.matchedExpectation}`);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log(`  ▸ ERROR: ${errorMsg}`);
      taskResults.push(makeErrorResult(taskSpec, errorMsg));
    }
  }

  const completedAt = new Date().toISOString();
  const totals = computeTotals(taskResults);
  const metrics = computeMetrics(taskResults);

  const result: BenchmarkResult = {
    benchmarkId,
    suiteId: suite.id,
    startedAt,
    completedAt,
    status: taskResults.some((t) => t.actualStatus === "error") ? "partial" : "completed",
    totals,
    metrics,
    tasks: taskResults,
  };

  // Write reports
  const jsonPath = await writeBenchmarkJson(outDir, result);
  const mdPath = await writeBenchmarkMd(outDir, result);

  log(`\n${"═".repeat(60)}`);
  log(`Benchmark complete: ${benchmarkId}`);
  log(`Expected outcome rate: ${(metrics.expectedOutcomeRate * 100).toFixed(1)}%`);
  log(`Success rate: ${(metrics.successRate * 100).toFixed(1)}%`);
  log(`Avg iterations: ${metrics.avgIterations} | Avg cost: $${metrics.avgCostUsd.toFixed(2)}`);
  log(`Reports: ${jsonPath} | ${mdPath}`);
  log(`${"═".repeat(60)}\n`);

  return result;
}

/**
 * Run a single benchmark task through the supervisor.
 */
async function runSingleTask(
  taskSpec: BenchmarkTaskSpec,
  defaults: BenchmarkDefaults,
  tasksDir: string,
): Promise<BenchmarkTaskResult> {
  // Load task file
  const taskPath = resolve(taskSpec.taskFile);
  const task: TaskSpec = JSON.parse(readFileSync(taskPath, "utf-8"));

  // Resolve relative repoPath against the task file's directory
  if (task.repoPath && !task.repoPath.startsWith("/") && !task.repoPath.match(/^[A-Z]:\\/i)) {
    task.repoPath = resolve(dirname(taskPath), task.repoPath);
  }

  // Apply defaults
  if (defaults.maxIterations !== undefined && !task.maxIterations) {
    task.maxIterations = defaults.maxIterations;
  }
  task.maxIterations = task.maxIterations ?? defaults.maxIterations ?? 5;

  // Run through supervisor with safe defaults
  const supervisorResult = await runSupervisorLoop(task, {
    skipWorktree: defaults.worktree === false,
    skipIntegrity: defaults.integrity === false,
    autoApply: defaults.autoApply ?? false,
  });

  // Copy run evidence to benchmark directory
  const config = (await import("../config.js")).getConfig();
  const sourceRunDir = resolve(config.stateDir, supervisorResult.runId ?? "");
  const targetRunDir = join(tasksDir, taskSpec.id);

  // Copy evidence (summary.json, iterations.jsonl, patches)
  try {
    await copyDir(sourceRunDir, targetRunDir);
  } catch {
    // Best effort — evidence may still be in the original location
  }

  // Determine actual status
  const actualStatus = supervisorResult.reason === "passed" ? "passed" : "failed";

  // Check if result matches expectation
  const expected = taskSpec.expectedOutcome ?? "any";
  const matchedExpectation = expected === "any" || expected === actualStatus;

  // Extract integrity status from summary
  const integrityStatus = supervisorResult.integritySummary?.status ?? "ok";

  // Extract semantic risk (M4)
  const semanticRisk = supervisorResult.semanticRisk?.level ?? "none";

  // Count files changed across all iterations
  const allFiles = new Set(supervisorResult.iterations.flatMap((it) => it.changedFiles));

  return {
    taskId: taskSpec.id,
    category: taskSpec.category ?? "uncategorized",
    expectedOutcome: expected,
    actualStatus,
    matchedExpectation,
    runId: supervisorResult.runId ?? null,
    summaryPath: supervisorResult.runId ? join(targetRunDir, "summary.json") : null,
    iterations: supervisorResult.iterations.length,
    costUsd: supervisorResult.totalCostUsd,
    durationMs: supervisorResult.totalDurationMs,
    stopReason: supervisorResult.reason,
    filesChanged: allFiles.size,
    linesAdded: supervisorResult.patch?.linesAdded ?? 0,
    linesDeleted: supervisorResult.patch?.linesDeleted ?? 0,
    integrityStatus,
    semanticRisk,
  };
}

function makeErrorResult(taskSpec: BenchmarkTaskSpec, error: string): BenchmarkTaskResult {
  return {
    taskId: taskSpec.id,
    category: taskSpec.category ?? "uncategorized",
    expectedOutcome: taskSpec.expectedOutcome ?? "any",
    actualStatus: "error",
    matchedExpectation: false,
    runId: null,
    summaryPath: null,
    iterations: 0,
    costUsd: 0,
    durationMs: 0,
    stopReason: null,
    filesChanged: 0,
    linesAdded: 0,
    linesDeleted: 0,
    integrityStatus: "unknown",
    errorMessage: error,
  };
}

async function copyDir(src: string, dest: string): Promise<void> {
  const { readdir, stat, mkdir: mk } = await import("node:fs/promises");
  const { join: j } = await import("node:path");
  await mk(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = j(src, entry.name);
    const destPath = j(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      const content = readFileSync(srcPath);
      await writeFile(destPath, content);
    }
  }
}

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(msg);
}
