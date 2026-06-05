/**
 * CLI handler for `verdikt compare` command.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export async function handleCompare(args: string[]): Promise<void> {
  const run1Id = args[0];
  const run2Id = args[1];
  if (!run1Id || !run2Id) {
    console.error("\n❌ Two run IDs are required");
    console.error("Usage: verdikt compare <run1> <run2>");
    console.error('\nUse "verdikt list" to see available runs.');
    process.exit(1);
  }

  const config = (await import("../config.js")).getConfig();
  const { readFile: readFileFs } = await import("node:fs/promises");

  const run1Dir = resolve(config.stateDir, run1Id);
  const run2Dir = resolve(config.stateDir, run2Id);

  const run1SummaryPath = join(run1Dir, "summary.json");
  const run2SummaryPath = join(run2Dir, "summary.json");

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

  const pad = (s: string, n: number) => s.padEnd(n);
  const col = 22;

  console.log("\n📊 Run Comparison\n");
  console.log(
    `${"Metric".padEnd(col)} ${run1Id.slice(0, 20).padEnd(22)} ${run2Id.slice(0, 20).padEnd(22)} Delta`,
  );
  console.log(`${"─".repeat(col)} ${"─".repeat(22)} ${"─".repeat(22)} ${"─".repeat(12)}`);

  const rows: Array<[string, string, string, string]> = [
    ["Status", run1.stopReason, run2.stopReason, run1.stopReason === run2.stopReason ? "=" : "≠"],
    ["Task", run1.taskId ?? "?", run2.taskId ?? "?", ""],
    [
      "Iterations",
      String(run1.iterations),
      String(run2.iterations),
      diffNum(run1.iterations, run2.iterations),
    ],
    [
      "Cost (USD)",
      `$${(run1.totalCostUsd ?? 0).toFixed(4)}`,
      `$${(run2.totalCostUsd ?? 0).toFixed(4)}`,
      diffCost(run1.totalCostUsd ?? 0, run2.totalCostUsd ?? 0),
    ],
    [
      "Duration",
      fmtDuration(run1.totalDurationMs),
      fmtDuration(run2.totalDurationMs),
      diffNum(run1.totalDurationMs, run2.totalDurationMs, "ms"),
    ],
    ["Files changed", String(run1.filesChanged ?? "?"), String(run2.filesChanged ?? "?"), ""],
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

function diffCost(a: number, b: number): string {
  const d = b - a;
  if (Math.abs(d) < 0.0001) return "=";
  const sign = d > 0 ? "+" : "";
  return `${sign}$${d.toFixed(4)}`;
}
