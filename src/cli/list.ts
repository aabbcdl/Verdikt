/**
 * CLI handler for `verdikt list` command.
 */

import { join, resolve } from "node:path";

export async function handleList(): Promise<void> {
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

  // Separate runs and benchmarks
  const runs: Array<{ id: string; time: string; status: string; task: string }> = [];
  const benchmarks: Array<{ id: string; time: string; tasks: number; status: string }> = [];

  for (const entry of entries.sort().reverse()) {
    const dir = join(stateDir, entry);
    try {
      const summaryPath = join(dir, "summary.json");
      const benchmarkPath = join(dir, "benchmark.json");

      const summaryStat = await stat(summaryPath).catch(() => null);
      const benchmarkStat = await stat(benchmarkPath).catch(() => null);

      if (summaryStat) {
        const summary = JSON.parse(await readFile(summaryPath, "utf-8"));
        runs.push({
          id: entry,
          time: summary.timestamp || "—",
          status: summary.stopReason || summary.status || "—",
          task: summary.taskId || "—",
        });
      } else if (benchmarkStat) {
        const bench = JSON.parse(await readFile(benchmarkPath, "utf-8"));
        benchmarks.push({
          id: entry,
          time: bench.completedAt || bench.startedAt || "—",
          tasks: bench.totals?.tasks || 0,
          status: bench.status || "—",
        });
      }
    } catch {
      // Skip unreadable entries
    }
  }

  if (benchmarks.length > 0) {
    console.log("\n📊 Benchmarks:");
    console.log("  ID                                    Tasks  Status      Time");
    console.log(`  ${"─".repeat(70)}`);
    for (const b of benchmarks) {
      console.log(
        `  ${b.id.padEnd(36)} ${String(b.tasks).padStart(4)}   ${b.status.padEnd(10)}  ${b.time}`,
      );
    }
  }

  if (runs.length > 0) {
    console.log("\n🏃 Runs:");
    console.log(
      "  ID                                    Task                  Status          Time",
    );
    console.log(`  ${"─".repeat(90)}`);
    for (const r of runs.slice(0, 20)) {
      // Show last 20
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
