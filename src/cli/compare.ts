/**
 * CLI handler for `verdikt compare` command.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { UsageSummary } from "../types.js";
import { coerceUsageSummary, formatCost } from "../usage.js";
import { isPathInside, isValidRunId } from "./localServer.js";
import { parseArgs } from "./parseArgs.js";

export async function handleCompare(args: string[]): Promise<void> {
  if (args.length < 2) {
    console.error("\n??Two run IDs are required");
    console.error("Usage: verdikt compare <run1> <run2>");
    console.error('\nUse "verdikt list" to see available runs.');
    process.exit(1);
  }
  const { positional } = parseArgs(args, {
    positional: { min: 2, max: 2, names: ["run1", "run2"] },
  });
  const [run1Id, run2Id] = positional;

  const config = (await import("../config.js")).getConfig();
  const { readFile: readFileFs } = await import("node:fs/promises");

  if (!isValidRunId(run1Id) || !isValidRunId(run2Id)) {
    console.error("\n❌ Invalid run ID");
    console.error("Run IDs may only contain letters, numbers, dashes, and underscores.");
    process.exit(1);
  }

  const stateDir = resolve(config.stateDir);
  const run1Dir = resolve(stateDir, run1Id);
  const run2Dir = resolve(stateDir, run2Id);

  const run1SummaryPath = join(run1Dir, "summary.json");
  const run2SummaryPath = join(run2Dir, "summary.json");

  if (!isPathInside(stateDir, run1SummaryPath) || !isPathInside(stateDir, run2SummaryPath)) {
    console.error("\n❌ Access denied");
    process.exit(1);
  }

  if (!existsSync(run1SummaryPath)) {
    console.error(`\n❌ Run not found: ${run1Id}`);
    process.exit(1);
  }
  if (!existsSync(run2SummaryPath)) {
    console.error(`\n❌ Run not found: ${run2Id}`);
    process.exit(1);
  }

  const run1 = JSON.parse(await readFileFs(run1SummaryPath, "utf-8"));
  const run2 = JSON.parse(await readFileFs(run2SummaryPath, "utf-8"));
  const run1Iterations = summaryNumber(run1, ["totalIterations", "iterations"]);
  const run2Iterations = summaryNumber(run2, ["totalIterations", "iterations"]);
  const run1DurationMs = summaryNumber(run1, ["totalDurationMs"]);
  const run2DurationMs = summaryNumber(run2, ["totalDurationMs"]);
  const run1Usage = summaryUsage(run1);
  const run2Usage = summaryUsage(run2);

  const pad = (s: string, n: number) => s.padEnd(n);
  const col = 22;

  console.log("\n📊 Run Comparison\n");
  console.log(
    `${"Metric".padEnd(col)} ${run1Id.slice(0, 20).padEnd(22)} ${run2Id.slice(0, 20).padEnd(22)} Delta`,
  );
  console.log(`${"─".repeat(col)} ${"─".repeat(22)} ${"─".repeat(22)} ${"─".repeat(12)}`);

  const rows: Array<[string, string, string, string]> = [
    [
      "Status",
      summaryString(run1, "stopReason"),
      summaryString(run2, "stopReason"),
      summaryString(run1, "stopReason") === summaryString(run2, "stopReason") ? "=" : "≠",
    ],
    ["Task", summaryString(run1, "taskId"), summaryString(run2, "taskId"), ""],
    [
      "Iterations",
      fmtMaybeNumber(run1Iterations),
      fmtMaybeNumber(run2Iterations),
      diffMaybeNum(run1Iterations, run2Iterations),
    ],
    [
      "Cost (USD)",
      formatCost(run1Usage, 4),
      formatCost(run2Usage, 4),
      diffCost(run1Usage, run2Usage),
    ],
    [
      "Duration",
      fmtMaybeDuration(run1DurationMs),
      fmtMaybeDuration(run2DurationMs),
      diffMaybeNum(run1DurationMs, run2DurationMs, "ms"),
    ],
    [
      "Files changed",
      fmtMaybeNumber(summaryNumber(run1, ["filesChanged"])),
      fmtMaybeNumber(summaryNumber(run2, ["filesChanged"])),
      "",
    ],
  ];

  for (const [metric, v1, v2, delta] of rows) {
    console.log(`${pad(metric, col)} ${pad(v1, 22)} ${pad(v2, 22)} ${delta}`);
  }

  // Compare patches if both exist
  const patch1 = join(run1Dir, "evidence", "final.patch");
  const patch2 = join(run2Dir, "evidence", "final.patch");
  if (existsSync(patch1) && existsSync(patch2)) {
    const p1 = (await readFileFs(patch1, "utf-8")).split("\n").length;
    const p2 = (await readFileFs(patch2, "utf-8")).split("\n").length;
    console.log(
      `${pad("Patch lines", col)} ${pad(String(p1), 22)} ${pad(String(p2), 22)} ${diffNum(p1, p2)}`,
    );
  }

  console.log();
}

function summaryString(summary: Record<string, unknown>, key: string): string {
  const value = summary[key];
  return typeof value === "string" && value.trim() ? value : "?";
}

function summaryNumber(summary: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = summary[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function fmtMaybeNumber(value: number | null): string {
  return value === null ? "?" : String(value);
}

function fmtMaybeDuration(ms: number | null): string {
  return ms === null ? "?" : fmtDuration(ms);
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function diffNum(a: number, b: number, suffix = ""): string {
  const d = b - a;
  if (d === 0) return "=";
  const sign = d > 0 ? "+" : "";
  return `${sign}${d}${suffix}`;
}

function diffMaybeNum(a: number | null, b: number | null, suffix = ""): string {
  if (a === null || b === null) return "";
  return diffNum(a, b, suffix);
}

function summaryUsage(summary: Record<string, unknown>): UsageSummary {
  const embedded = summary.usage;
  const legacyCost = summaryNumber(summary, ["totalCostUsd"]);
  return coerceUsageSummary(
    embedded ?? { status: summary.usageStatus, costUsd: legacyCost ?? undefined },
    legacyCost ?? undefined,
  );
}

function diffCost(a: UsageSummary, b: UsageSummary): string {
  if (a.status !== "complete" || b.status !== "complete") return "n/a";
  if (a.costUsd === undefined || b.costUsd === undefined) return "n/a";
  const d = b.costUsd - a.costUsd;
  if (Math.abs(d) < 0.0001) return "=";
  const sign = d > 0 ? "+" : "";
  return `${sign}$${d.toFixed(4)}`;
}
