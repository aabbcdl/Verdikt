/**
 * CLI handler for `verdikt list` command.
 */

import { join, resolve } from "node:path";
import { isPathInside, isValidRunId } from "./localServer.js";
import { parseArgs } from "./parseArgs.js";

export async function handleList(args: string[] = []): Promise<void> {
  parseArgs(args, { positional: { max: 0 } });
  const config = (await import("../config.js")).getConfig();
  const { readdir, stat, readFile } = await import("node:fs/promises");
  const stateDir = resolve(config.stateDir);

  let entries: string[];
  try {
    entries = await readdir(stateDir);
  } catch {
    console.log("No runs found. Run `verdikt run --task <file>` first.");
    return;
  }

  const runs: Array<{ id: string; time: string; status: string; task: string }> = [];
  const benchmarks: Array<{ id: string; time: string; tasks: number; status: string }> = [];

  for (const entry of entries.sort().reverse()) {
    if (!isValidRunId(entry)) continue;

    const dir = resolve(stateDir, entry);
    if (!isPathInside(stateDir, dir)) continue;

    try {
      const summaryPath = join(dir, "summary.json");
      const benchmarkPath = join(dir, "benchmark.json");

      const summaryStat = await stat(summaryPath).catch(() => null);
      const benchmarkStat = await stat(benchmarkPath).catch(() => null);

      if (summaryStat) {
        const summary = JSON.parse(await readFile(summaryPath, "utf-8"));
        runs.push({
          id: entry,
          time: displayString(summary.timestamp),
          status: displayString(summary.stopReason, displayString(summary.status)),
          task: displayString(summary.taskId),
        });
      } else if (benchmarkStat) {
        const bench = JSON.parse(await readFile(benchmarkPath, "utf-8"));
        benchmarks.push({
          id: entry,
          time: displayString(bench.completedAt, displayString(bench.startedAt)),
          tasks: displayInteger(bench.totals?.tasks),
          status: displayString(bench.status),
        });
      }
    } catch {
      // Skip unreadable entries.
    }
  }

  if (benchmarks.length > 0) {
    console.log("\nBenchmarks:");
    console.log("  ID                                    Tasks  Status      Time");
    console.log(`  ${"-".repeat(70)}`);
    for (const b of benchmarks) {
      console.log(
        `  ${b.id.padEnd(36)} ${String(b.tasks).padStart(4)}   ${b.status.padEnd(10)}  ${b.time}`,
      );
    }
  }

  if (runs.length > 0) {
    console.log("\nRuns:");
    console.log(
      "  ID                                    Task                  Status          Time",
    );
    console.log(`  ${"-".repeat(90)}`);
    for (const r of runs.slice(0, 20)) {
      console.log(`  ${r.id.padEnd(36)} ${r.task.padEnd(20)}  ${r.status.padEnd(14)}  ${r.time}`);
    }
    if (runs.length > 20) {
      console.log(`  ... and ${runs.length - 20} more`);
    }
  }

  if (runs.length === 0 && benchmarks.length === 0) {
    console.log("No runs or benchmarks found. Run `verdikt run --task <file>` first.");
  }
}

function displayString(value: unknown, fallback = "-"): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function displayInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}
