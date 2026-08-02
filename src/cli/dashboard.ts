/**
 * CLI handler for `verdikt dashboard` command.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { UsageSummary } from "../types.js";
import { coerceUsageSummary, formatCost, mergeUsage } from "../usage.js";
import { readVerdictResult } from "../verdict/store.js";
import {
  type LocalServerHandle,
  dataContentType,
  injectDefaultDataDir,
  isAllowedDataFile,
  isPathInside,
  isValidRunId,
  listenLocal,
} from "./localServer.js";
import { parseArgs } from "./parseArgs.js";

export async function handleDashboard(args: string[] = []): Promise<void> {
  parseArgs(args, { positional: { max: 0 } });
  const handle = await startDashboardServer({ port: 3848 });
  console.log("\nVerdikt Dashboard");
  console.log(`   ${handle.url}`);
  console.log(
    `\n   ${handle.totalRuns} runs · ${handle.totalBenchmarks} benchmarks · ${formatCost(handle.totalUsage, 2)} total`,
  );
  console.log("\nPress Ctrl+C to stop.\n");
}

export interface DashboardServerHandle extends LocalServerHandle {
  totalRuns: number;
  totalBenchmarks: number;
  totalCost: number;
  totalUsage: UsageSummary;
}

export async function startDashboardServer(options: {
  port: number;
  host?: string;
}): Promise<DashboardServerHandle> {
  const config = (await import("../config.js")).getConfig();
  const { readdir, stat, readFile: readFileFs } = await import("node:fs/promises");
  const stateDir = resolve(config.stateDir);

  const runs: Array<Record<string, unknown>> = [];
  const benchmarks: Array<Record<string, unknown>> = [];

  let entries: string[];
  try {
    entries = await readdir(stateDir);
  } catch {
    entries = [];
  }

  for (const entry of entries.sort()) {
    if (!isValidRunId(entry)) continue;

    const dir = join(stateDir, entry);
    try {
      const summaryPath = join(dir, "summary.json");
      const benchmarkPath = join(dir, "benchmark.json");

      const summaryStat = await stat(summaryPath).catch(() => null);
      const benchmarkStat = await stat(benchmarkPath).catch(() => null);

      if (summaryStat) {
        const summary = JSON.parse(await readFileFs(summaryPath, "utf-8"));
        const usage = coerceUsageSummary(
          summary.usage ?? { status: summary.usageStatus, costUsd: summary.totalCostUsd },
          optionalNumber(summary.totalCostUsd),
        );
        runs.push({
          runId: entry,
          taskId: displayString(summary.taskId),
          stopReason: displayString(summary.stopReason, "unknown"),
          iterations: displayNumber(summary.totalIterations),
          totalCostUsd: usage.costUsd ?? 0,
          usageStatus: usage.status,
          usage,
          totalDurationMs: displayNumber(summary.totalDurationMs),
          timestamp: displayString(summary.timestamp),
        });
      }

      if (benchmarkStat) {
        const bench = JSON.parse(await readFileFs(benchmarkPath, "utf-8"));
        const results = Array.isArray(bench.results) ? bench.results : [];
        const avgCostUsd = displayNumber(bench.metrics?.avgCostUsd);
        const avgCostStatus = usageStatus(bench.metrics?.avgCostStatus, bench.metrics?.avgCostUsd);
        const avgDurationMs = displayNumber(bench.metrics?.avgDurationMs);
        benchmarks.push({
          id: entry,
          tasks: results.length,
          passed: results.filter((r: Record<string, unknown>) => r.matchedExpectation).length,
          totalCostUsd: avgCostUsd * results.length,
          usageStatus: avgCostStatus,
          totalDurationMs: avgDurationMs * results.length,
        });
      }
    } catch {
      // Skip malformed run folders.
    }
  }

  const totalRuns = runs.length;
  const passedRuns = runs.filter((r) => r.stopReason === "passed").length;
  const totalUsage = mergeUsage(
    ...runs.map((run) => coerceUsageSummary(run.usage, optionalNumber(run.totalCostUsd))),
  );
  const totalCost = totalUsage.costUsd ?? 0;
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
      usageStatus: totalUsage.status,
      unknownCostRuns: runs.filter((run) => run.usageStatus !== "complete").length,
      avgIterations,
    },
  };

  const { createServer } = await import("node:http");
  const port = options.port;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

    if (url.pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = await readFileFs(
        resolve(import.meta.dirname, "../../apps/ui/dashboard.html"),
        "utf-8",
      );
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (url.pathname === "/data/dashboard.json") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(dashboardData));
      return;
    }

    if (url.pathname.startsWith("/view/")) {
      const id = url.pathname.replace("/view/", "");
      if (!isValidRunId(id)) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Invalid run ID");
        return;
      }

      const itemDir = join(stateDir, id);
      if (!isPathInside(stateDir, itemDir)) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Access denied");
        return;
      }

      const isBenchmark = existsSync(join(itemDir, "benchmark.json"));
      const htmlPath = isBenchmark
        ? resolve(import.meta.dirname, "../../apps/ui/benchmark.html")
        : resolve(import.meta.dirname, "../../apps/ui/index.html");
      const html = await readFileFs(htmlPath, "utf-8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        injectDefaultDataDir(
          html,
          `/data/${encodeURIComponent(id)}`,
          `/api/verdict/${encodeURIComponent(id)}`,
        ),
      );
      return;
    }

    if (url.pathname.startsWith("/api/verdict/") && req.method === "GET") {
      const id = url.pathname.replace("/api/verdict/", "");
      if (!isValidRunId(id)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid run ID" }));
        return;
      }
      const itemDir = join(stateDir, id);
      if (!isPathInside(stateDir, itemDir)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Access denied" }));
        return;
      }
      const verdict = await readVerdictResult(itemDir);
      if (verdict.status === "ok") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(verdict.verdict));
        return;
      }
      if (verdict.status === "missing") {
        const legacy = existsSync(join(itemDir, "summary.json"));
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: legacy ? "Legacy run" : "Run not found", legacy }));
        return;
      }
      res.writeHead(422, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error:
            verdict.status === "unsupported"
              ? `Unsupported verdict version: ${String(verdict.version)}`
              : verdict.error,
        }),
      );
      return;
    }

    if (url.pathname.startsWith("/data/")) {
      const parts = url.pathname.replace(/^\/data\//, "").split("/");
      const id = decodeURIComponent(parts.shift() ?? "");
      const fileName = parts.join("/");

      if (!isValidRunId(id) || !isAllowedDataFile(fileName)) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Invalid data path");
        return;
      }

      const filePath = join(stateDir, id, fileName);
      if (!isPathInside(stateDir, filePath)) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Access denied");
        return;
      }

      try {
        const content = await readFileFs(filePath, "utf-8");
        res.writeHead(200, { "Content-Type": dataContentType(fileName) });
        res.end(content);
      } catch {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
      }
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  const handle = await listenLocal(server, { port, host: options.host });
  return {
    ...handle,
    totalRuns,
    totalBenchmarks: benchmarks.length,
    totalCost,
    totalUsage,
  };
}

function displayString(value: unknown, fallback = "?"): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function usageStatus(value: unknown, legacyCost: unknown): "complete" | "partial" | "unknown" {
  if (value === "complete" || value === "partial" || value === "unknown") return value;
  return optionalNumber(legacyCost) === undefined ? "unknown" : "complete";
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function displayNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
