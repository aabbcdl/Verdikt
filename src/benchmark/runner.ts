/**
 * Benchmark runner: executes a suite of Verdikt tasks.
 *
 * Each task runs through the existing supervisor. One failed task does not stop
 * the benchmark, and each task preserves its normal run evidence when possible.
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { runSupervisorLoop } from "../loop/supervisor.js";
import { createRunId } from "../trace/recorder.js";
import type { TaskSpec } from "../types.js";
import { formatCost } from "../usage.js";
import { computeMetrics, computeTotals } from "./metrics.js";
import { aggregateTaskAttempts, collectBenchmarkEnvironment } from "./repeats.js";
import { writeBenchmarkJson, writeBenchmarkMd } from "./report.js";
import type {
  BenchmarkDefaults,
  BenchmarkResult,
  BenchmarkSuite,
  BenchmarkTaskAttemptResult,
  BenchmarkTaskResult,
  BenchmarkTaskSpec,
} from "./types.js";

const SAFE_FOLDER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const VALID_CATEGORIES = new Set(["small", "medium", "large", "negative", "regression"]);
const VALID_EXPECTED_OUTCOMES = new Set(["passed", "failed", "any"]);
const RUN_ARTIFACT_EXCLUDED_DIRS = new Set(["workspace"]);

/**
 * Parse and validate a benchmark suite file.
 */
export function loadSuite(suitePath: string): BenchmarkSuite {
  const absoluteSuitePath = resolve(suitePath);
  const raw = readFileSync(absoluteSuitePath, "utf-8");
  const parsed = JSON.parse(raw);
  return normalizeSuite(parsed, dirname(absoluteSuitePath));
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
  const normalizedSuite = normalizeSuite(suite, process.cwd());
  const benchmarkId = `benchmark-${createRunId().replace("run-", "")}`;
  const outDir = options.outDir ?? `.verdikt/${benchmarkId}`;
  const tasksDir = join(outDir, "tasks");
  const startedAt = new Date().toISOString();

  log("");
  log("=".repeat(60));
  log(`Benchmark: ${normalizedSuite.id} (${benchmarkId})`);
  log(`Tasks: ${normalizedSuite.tasks.length}`);
  log(`Output: ${outDir}`);
  log("=".repeat(60));
  log("");

  await mkdir(tasksDir, { recursive: true });

  await writeFile(join(outDir, "suite.json"), JSON.stringify(normalizedSuite, null, 2));

  const taskResults: BenchmarkTaskResult[] = [];
  const defaults = normalizedSuite.defaults ?? {};
  const repeats = normalizedSuite.repeats ?? 1;
  const warmups = normalizedSuite.warmups ?? 0;

  for (let i = 0; i < normalizedSuite.tasks.length; i++) {
    const taskSpec = normalizedSuite.tasks[i];
    log("");
    log(
      `-- Task ${i + 1}/${normalizedSuite.tasks.length}: ${taskSpec.id} (${taskSpec.category ?? "uncategorized"}) --`,
    );

    if (options.dryRun) {
      log(`  [DRY RUN] Would run: ${taskSpec.taskFile}`);
      taskResults.push(makeErrorResult(taskSpec, "dry-run"));
      continue;
    }

    try {
      for (let warmup = 0; warmup < warmups; warmup++) {
        log(`  Warmup ${warmup + 1}/${warmups}`);
        await runSingleAttempt(
          taskSpec,
          defaults,
          join(tasksDir, taskSpec.id, `warmup-${warmup + 1}`),
          warmup + 1,
        );
      }

      const attempts: BenchmarkTaskAttemptResult[] = [];
      for (let repeat = 0; repeat < repeats; repeat++) {
        log(`  Attempt ${repeat + 1}/${repeats}`);
        try {
          attempts.push(
            await runSingleAttempt(
              taskSpec,
              defaults,
              repeats === 1
                ? join(tasksDir, taskSpec.id)
                : join(tasksDir, taskSpec.id, `run-${repeat + 1}`),
              repeat + 1,
            ),
          );
        } catch (err) {
          attempts.push(
            makeErrorAttempt(
              taskSpec,
              repeat + 1,
              err instanceof Error ? err.message : String(err),
            ),
          );
        }
      }

      const result = aggregateTaskAttempts(taskSpec, attempts);
      taskResults.push(result);
      log(
        `  Result: ${result.actualStatus} | pass rate ${((result.passRate ?? 0) * 100).toFixed(1)}% | ${result.iterations} avg iter | ${formatCost({ status: result.usageStatus ?? "complete", costUsd: result.costUsd }, 2)} avg | match=${result.matchedExpectation}`,
      );
      if (normalizedSuite.failFast && !result.matchedExpectation) break;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log(`  ERROR: ${errorMsg}`);
      taskResults.push(makeErrorResult(taskSpec, errorMsg));
      if (normalizedSuite.failFast) break;
    }
  }

  const completedAt = new Date().toISOString();
  const totals = computeTotals(taskResults);
  const metrics = computeMetrics(taskResults);

  const result: BenchmarkResult = {
    benchmarkId,
    suiteId: normalizedSuite.id,
    startedAt,
    completedAt,
    status: taskResults.some((t) => t.actualStatus === "error") ? "partial" : "completed",
    totals,
    metrics,
    tasks: taskResults,
    environment: await collectBenchmarkEnvironment(),
    repeats,
    warmups,
  };

  const jsonPath = await writeBenchmarkJson(outDir, result);
  const mdPath = await writeBenchmarkMd(outDir, result);

  log("");
  log("=".repeat(60));
  log(`Benchmark complete: ${benchmarkId}`);
  log(`Expected outcome rate: ${(metrics.expectedOutcomeRate * 100).toFixed(1)}%`);
  log(`Success rate: ${(metrics.successRate * 100).toFixed(1)}%`);
  log(
    `Avg iterations: ${metrics.avgIterations} | Avg cost: ${formatCost({ status: metrics.avgCostStatus ?? "complete", costUsd: metrics.avgCostUsd }, 2)} (${metrics.costSampleCount ?? 0}/${taskResults.filter((task) => task.runId !== null).length} samples)`,
  );
  log(`Reports: ${jsonPath} | ${mdPath}`);
  log("=".repeat(60));
  log("");

  return result;
}

async function runSingleAttempt(
  taskSpec: BenchmarkTaskSpec,
  defaults: BenchmarkDefaults,
  targetRunDir: string,
  attempt: number,
): Promise<BenchmarkTaskAttemptResult> {
  const taskPath = resolve(taskSpec.taskFile);
  const task: TaskSpec = JSON.parse(readFileSync(taskPath, "utf-8"));
  task.runSource = "benchmark";

  if (task.repoPath && !isAbsolute(task.repoPath)) {
    task.repoPath = resolve(dirname(taskPath), task.repoPath);
  }

  if (defaults.maxIterations !== undefined && task.maxIterations === undefined) {
    task.maxIterations = defaults.maxIterations;
  }
  task.maxIterations = task.maxIterations ?? defaults.maxIterations ?? 5;

  if (defaults.budgetUsd !== undefined && task.maxBudgetUsd === undefined) {
    task.maxBudgetUsd = defaults.budgetUsd;
  }

  const supervisorResult = await runSupervisorLoop(task, {
    skipWorktree: defaults.worktree === false,
    skipIntegrity: defaults.integrity === false,
    autoApply: defaults.autoApply ?? false,
  });

  const config = (await import("../config.js")).getConfig();
  const sourceRunDir = resolve(config.stateDir, supervisorResult.runId ?? "");
  try {
    await copyRunArtifacts(sourceRunDir, targetRunDir);
  } catch {
    // Best effort: evidence may still be in the original run directory.
  }

  const actualStatus =
    supervisorResult.reason === "passed"
      ? "passed"
      : supervisorResult.reason === "provider_error"
        ? "error"
        : "failed";
  const expected = taskSpec.expectedOutcome ?? "any";
  const matchedExpectation = expected === "any" || expected === actualStatus;
  const integrityStatus = supervisorResult.integritySummary?.status ?? "ok";
  const semanticRisk = supervisorResult.semanticRisk?.level ?? "none";
  const allFiles = new Set(
    supervisorResult.iterations.flatMap((iteration) => iteration.changedFiles),
  );

  return {
    attempt,
    actualStatus,
    matchedExpectation,
    runId: supervisorResult.runId ?? null,
    summaryPath: supervisorResult.runId ? join(targetRunDir, "summary.json") : null,
    iterations: supervisorResult.iterations.length,
    costUsd: supervisorResult.totalCostUsd,
    usageStatus: supervisorResult.usageStatus ?? supervisorResult.usage?.status ?? "complete",
    usage: supervisorResult.usage,
    durationMs: supervisorResult.totalDurationMs,
    stopReason: supervisorResult.reason,
    filesChanged: allFiles.size,
    linesAdded: supervisorResult.patch?.linesAdded ?? 0,
    linesDeleted: supervisorResult.patch?.linesDeleted ?? 0,
    integrityStatus,
    semanticRisk,
  };
}

function normalizeSuite(input: unknown, relativeBaseDir: string): BenchmarkSuite {
  if (!isRecord(input)) {
    throw new Error("Suite file must contain a JSON object");
  }

  if (!isSafeId(input.id)) {
    throw new Error("Suite id must be a safe identifier");
  }

  if (!Array.isArray(input.tasks)) {
    throw new Error("Suite tasks must be an array");
  }

  if (input.tasks.length === 0) {
    throw new Error("Suite must have at least one task");
  }

  const defaults = normalizeDefaults(input.defaults);
  const repeats = optionalPositiveInteger(input.repeats, "repeats") ?? 1;
  const warmups = optionalNonNegativeInteger(input.warmups, "warmups") ?? 0;
  if (repeats > 1 && (defaults?.worktree === false || defaults?.autoApply === true)) {
    throw new Error("Repeated benchmarks require isolated worktrees and autoApply=false");
  }

  return {
    id: input.id,
    name: optionalString(input.name),
    description: optionalString(input.description),
    defaults,
    repeats,
    warmups,
    failFast: optionalBoolean(input.failFast, "failFast"),
    tasks: input.tasks.map((task, index) => normalizeTaskSpec(task, index, relativeBaseDir)),
  };
}

function normalizeTaskSpec(
  input: unknown,
  index: number,
  relativeBaseDir: string,
): BenchmarkTaskSpec {
  if (!isRecord(input)) {
    throw new Error(`Task ${index + 1} must be an object`);
  }

  if (!isSafeId(input.id)) {
    throw new Error(`Task ${index + 1} id must be a safe folder name`);
  }

  if (!isNonEmptyString(input.taskFile)) {
    throw new Error(`Task ${index + 1} taskFile must be a non-empty string`);
  }

  const category = optionalString(input.category);
  if (category !== undefined && !VALID_CATEGORIES.has(category)) {
    throw new Error(`Task ${index + 1} category is invalid`);
  }

  const expectedOutcome = optionalString(input.expectedOutcome);
  if (expectedOutcome !== undefined && !VALID_EXPECTED_OUTCOMES.has(expectedOutcome)) {
    throw new Error(`Task ${index + 1} expectedOutcome is invalid`);
  }

  if (input.tags !== undefined) {
    if (!Array.isArray(input.tags) || input.tags.some((tag) => typeof tag !== "string")) {
      throw new Error(`Task ${index + 1} tags must be an array of strings`);
    }
  }

  return {
    id: input.id,
    taskFile: resolveTaskFile(input.taskFile, relativeBaseDir),
    category: category as BenchmarkTaskSpec["category"],
    expectedOutcome: expectedOutcome as BenchmarkTaskSpec["expectedOutcome"],
    tags: input.tags as string[] | undefined,
  };
}

function normalizeDefaults(input: unknown): BenchmarkDefaults | undefined {
  if (input === undefined) return undefined;
  if (!isRecord(input)) {
    throw new Error("Suite defaults must be an object");
  }

  return {
    maxIterations: optionalPositiveInteger(input.maxIterations, "defaults.maxIterations"),
    budgetUsd: optionalPositiveNumber(input.budgetUsd, "defaults.budgetUsd"),
    worktree: optionalBoolean(input.worktree, "defaults.worktree"),
    integrity: optionalBoolean(input.integrity, "defaults.integrity"),
    autoApply: optionalBoolean(input.autoApply, "defaults.autoApply"),
  };
}

function resolveTaskFile(taskFile: string, relativeBaseDir: string): string {
  if (isAbsolute(taskFile)) {
    return resolve(taskFile);
  }

  const suiteRelativePath = resolve(relativeBaseDir, taskFile);
  if (existsSync(suiteRelativePath)) {
    return suiteRelativePath;
  }

  return resolve(taskFile);
}

function makeErrorAttempt(
  _taskSpec: BenchmarkTaskSpec,
  attempt: number,
  error: string,
): BenchmarkTaskAttemptResult {
  return {
    attempt,
    actualStatus: "error",
    matchedExpectation: false,
    runId: null,
    summaryPath: null,
    iterations: 0,
    costUsd: 0,
    usageStatus: "unknown",
    usage: { status: "unknown" },
    durationMs: 0,
    stopReason: null,
    filesChanged: 0,
    linesAdded: 0,
    linesDeleted: 0,
    integrityStatus: "unknown",
    errorMessage: error,
  };
}

function makeErrorResult(taskSpec: BenchmarkTaskSpec, error: string): BenchmarkTaskResult {
  return aggregateTaskAttempts(taskSpec, [makeErrorAttempt(taskSpec, 1, error)]);
}

async function copyRunArtifacts(src: string, dest: string): Promise<void> {
  await copyDir(src, dest, RUN_ARTIFACT_EXCLUDED_DIRS);
}

async function copyDir(src: string, dest: string, excludedDirs: Set<string>): Promise<void> {
  const { readdir, mkdir: mk } = await import("node:fs/promises");
  const { join: j } = await import("node:path");
  await mk(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && excludedDirs.has(entry.name)) {
      continue;
    }
    const srcPath = j(src, entry.name);
    const destPath = j(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath, excludedDirs);
    } else {
      const content = readFileSync(srcPath);
      await writeFile(destPath, content);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSafeId(value: unknown): value is string {
  return isNonEmptyString(value) && SAFE_FOLDER_NAME.test(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`${field} must be a boolean`);
  }
  return value;
}

function optionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function optionalNonNegativeInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
}

function optionalPositiveNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be a positive number`);
  }
  return value;
}

function log(msg: string): void {
  console.log(msg);
}
