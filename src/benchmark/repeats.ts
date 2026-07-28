import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { getConfig } from "../config.js";
import { coerceUsageSummary, mergeUsage } from "../usage.js";
import type {
  BenchmarkEnvironment,
  BenchmarkTaskAttemptResult,
  BenchmarkTaskResult,
  BenchmarkTaskSpec,
} from "./types.js";

export function aggregateTaskAttempts(
  taskSpec: BenchmarkTaskSpec,
  attempts: BenchmarkTaskAttemptResult[],
): BenchmarkTaskResult {
  if (attempts.length === 0) {
    throw new Error(`Benchmark task ${taskSpec.id} has no measured attempts`);
  }
  const passed = attempts.filter((attempt) => attempt.actualStatus === "passed").length;
  const errors = attempts.filter((attempt) => attempt.actualStatus === "error").length;
  const actualStatus = errors > 0 ? "error" : passed === attempts.length ? "passed" : "failed";
  const expected = taskSpec.expectedOutcome ?? "any";
  const matchedExpectation =
    expected === "any"
      ? actualStatus !== "error"
      : expected === "passed"
        ? passed === attempts.length
        : attempts.every((attempt) => attempt.actualStatus === "failed");
  const durations = attempts.map((attempt) => attempt.durationMs).sort((a, b) => a - b);
  const meanDuration = average(durations);
  const stopReasons = [...new Set(attempts.map((attempt) => attempt.stopReason))];
  const attemptUsages = attempts.map((attempt) =>
    coerceUsageSummary(
      attempt.usage ?? { status: attempt.usageStatus, costUsd: attempt.costUsd },
      attempt.usageStatus === "unknown" ? undefined : attempt.costUsd,
    ),
  );
  const knownCosts = attemptUsages
    .filter((usage) => usage.status !== "unknown" && usage.costUsd !== undefined)
    .map((usage) => usage.costUsd as number);
  const aggregateUsage = mergeUsage(...attemptUsages);

  return {
    taskId: taskSpec.id,
    category: taskSpec.category ?? "uncategorized",
    expectedOutcome: expected,
    actualStatus,
    matchedExpectation,
    runId: attempts[0]?.runId ?? null,
    summaryPath: attempts[0]?.summaryPath ?? null,
    iterations: round(average(attempts.map((attempt) => attempt.iterations))),
    costUsd: round(average(knownCosts), 4),
    totalCostUsd: round(aggregateUsage.costUsd ?? 0, 4),
    usageStatus: aggregateUsage.status,
    usage: aggregateUsage,
    durationMs: round(meanDuration),
    stopReason: stopReasons.length === 1 ? (stopReasons[0] ?? null) : "mixed",
    filesChanged: round(average(attempts.map((attempt) => attempt.filesChanged))),
    linesAdded: round(average(attempts.map((attempt) => attempt.linesAdded))),
    linesDeleted: round(average(attempts.map((attempt) => attempt.linesDeleted))),
    integrityStatus: attempts.some((attempt) => attempt.integrityStatus === "violations")
      ? "violations"
      : attempts.every((attempt) => attempt.integrityStatus === "ok")
        ? "ok"
        : "unknown",
    semanticRisk: highestRisk(attempts.map((attempt) => attempt.semanticRisk ?? "none")),
    errorMessage: attempts.find((attempt) => attempt.errorMessage)?.errorMessage,
    attempts,
    passRate: round(passed / attempts.length, 4),
    medianDurationMs: percentile(durations, 50),
    worstDurationMs: durations.at(-1) ?? 0,
    durationStdDevMs: round(
      Math.sqrt(
        durations.reduce((sum, duration) => sum + (duration - meanDuration) ** 2, 0) /
          durations.length,
      ),
    ),
    flaky: passed > 0 && passed < attempts.length,
  };
}

export async function collectBenchmarkEnvironment(): Promise<BenchmarkEnvironment> {
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    model: getConfig().model,
    verdiktVersion: await readVersion(),
    gitCommit: await readGitCommit(),
  };
}

function average(values: number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function percentile(sorted: number[], value: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.max(0, Math.ceil((value / 100) * sorted.length) - 1);
  return sorted[index] ?? 0;
}

function highestRisk(values: string[]): string {
  const order = ["none", "low", "medium", "high"];
  return values.reduce(
    (highest, value) => (order.indexOf(value) > order.indexOf(highest) ? value : highest),
    "none",
  );
}

function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

async function readVersion(): Promise<string | undefined> {
  try {
    const path = fileURLToPath(new URL("../../package.json", import.meta.url));
    const parsed = JSON.parse(await readFile(path, "utf-8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

async function readGitCommit(): Promise<string | undefined> {
  return new Promise((resolveCommit) => {
    execFile("git", ["rev-parse", "HEAD"], { encoding: "utf-8" }, (err, stdout) => {
      resolveCommit(err ? undefined : stdout.trim() || undefined);
    });
  });
}
