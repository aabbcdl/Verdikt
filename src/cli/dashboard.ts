/**
 * CLI handler for `verdikt dashboard` command.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export async function handleDashboard(): Promise<void> {
  const config = (await import("../config.js")).getConfig();
  const { readdir, stat, readFile: readFileFs } = await import("node:fs/promises");
  const stateDir = resolve(config.stateDir);

  // Collect runs and benchmarks
  const runs: Array<Record<string, unknown>> = [];
  const benchmarks: Array<Record<string, unknown>> = [];

  let entries: string[];
  try {
    entries = await readdir(stateDir);
  } catch {
    // State directory doesn't exist yet — no runs to display
    entries = [];
  }

  for (const entry of entries.sort()) {
    const dir = join(stateDir, entry);
    try {
      const summaryPath = join(dir, "summary.json");
      const benchmarkPath = join(dir, "benchmark.json");

      const summaryStat = await stat(summaryPath).catch(() => null);
      const benchmarkStat = await stat(benchmarkPath).catch(() => null);

      if (summaryStat) {
        const summary = JSON.parse(await readFileFs(summaryPath, "utf-8"));
        runs.push({
          runId: entry,
          taskId: summary.taskId,
          stopReason: summary.stopReason,
          iterations: summary.totalIterations,
          totalCostUsd: summary.totalCostUsd,
          totalDurationMs: summary.totalDurationMs,
          timestamp: summary.timestamp,
        });
      }

      if (benchmarkStat) {
        const bench = JSON.parse(await readFileFs(benchmarkPath, "utf-8"));
        benchmarks.push({
          id: entry,
          tasks: bench.results?.length ?? 0,
          passed:
            bench.results?.filter((r: Record<string, unknown>) => r.matchedExpectation).length ?? 0,
          totalCostUsd: bench.metrics?.avgCostUsd
            ? bench.metrics.avgCostUsd * (bench.results?.length ?? 0)
            : 0,
          totalDurationMs: bench.metrics?.avgDurationMs
            ? bench.metrics.avgDurationMs * (bench.results?.length ?? 0)
            : 0,
        });
      }
    } catch {
      // Skip entries with missing or malformed JSON files
    }
  }

  // Aggregate stats
  const totalRuns = runs.length;
  const passedRuns = runs.filter((r) => r.stopReason === "passed").length;
  const totalCost = runs.reduce((sum, r) => sum + ((r.totalCostUsd as number) || 0), 0);
  const avgIterations =
    totalRuns > 0
      ? runs.reduce((sum, r) => sum + ((r.iterations as number) || 0), 0) / totalRuns
      : 0;

  const dashboardData = {
    runs,
    benchmarks,
    stats: {
      totalRuns,
      totalBenchmarks: benchmarks.length,
      passRate: totalRuns > 0 ? passedRuns / totalRuns : 0,
      totalCost,
      avgIterations,
    },
  };

  // Serve dashboard
  const { createServer } = await import("node:http");
  const port = 3848;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = await readFileFs(
        resolve(import.meta.dirname, "../../apps/ui/dashboard.html"),
        "utf-8",
      );
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    } else if (url.pathname === "/data/dashboard.json") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(JSON.stringify(dashboardData));
    } else if (url.pathname.startsWith("/view/")) {
      const id = url.pathname.replace("/view/", "");
      const itemDir = join(stateDir, id);
      const isBenchmark = existsSync(join(itemDir, "benchmark.json"));
      const htmlPath = isBenchmark
        ? resolve(import.meta.dirname, "../../apps/ui/benchmark.html")
        : resolve(import.meta.dirname, "../../apps/ui/index.html");
      const html = await readFileFs(htmlPath, "utf-8");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    } else if (url.pathname.startsWith("/data/")) {
      const filePath = join(stateDir, url.pathname.replace("/data/", ""));
      try {
        const content = await readFileFs(filePath, "utf-8");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(content);
      } catch {
        // File not found or read error — return 404
        res.writeHead(404);
        res.end("Not found");
      }
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  server.listen(port, () => {
    console.log("\n📊 Verdikt Dashboard");
    console.log(`   http://localhost:${port}`);
    console.log(
      `\n   ${totalRuns} runs · ${benchmarks.length} benchmarks · $${totalCost.toFixed(2)} total`,
    );
    console.log("\nPress Ctrl+C to stop.\n");
  });
}
