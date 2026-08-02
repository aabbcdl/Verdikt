/**
 * CLI handler for `verdikt view` command.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
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

export async function handleView(args: string[]): Promise<void> {
  const { positional } = parseArgs(args, {
    positional: { min: 1, max: 1, names: ["run-id|benchmark-id"] },
  });
  const id = positional[0];

  let handle: ViewServerHandle;
  try {
    handle = await startViewServer({ id, port: 3847 });
  } catch {
    console.error(`\nRun or benchmark not found: ${id}`);
    console.error('\nUse "verdikt list" to see available runs and benchmarks.');
    process.exit(1);
  }
  const label = handle.isBenchmark ? "Benchmark Viewer" : "Run Viewer";
  console.log(`\nVerdikt ${label}`);
  console.log(`   ${handle.isBenchmark ? "Benchmark" : "Run"}: ${id}`);
  console.log(`   URL: ${handle.url}`);
  console.log("\n   Press Ctrl+C to stop.\n");
}

export interface ViewServerHandle extends LocalServerHandle {
  isBenchmark: boolean;
}

export async function startViewServer(options: {
  id: string;
  port: number;
  host?: string;
}): Promise<ViewServerHandle> {
  const id = options.id;
  const config = (await import("../config.js")).getConfig();
  const stateDir = resolve(config.stateDir);
  const itemDir = resolve(stateDir, id);

  if (!isValidRunId(id) || !isPathInside(stateDir, itemDir)) {
    throw new Error("Invalid run or benchmark ID");
  }

  const summaryPath = join(itemDir, "summary.json");
  const benchmarkPath = join(itemDir, "benchmark.json");

  const isBenchmark = existsSync(benchmarkPath);
  const isRun = existsSync(summaryPath);

  if (!isBenchmark && !isRun) {
    throw new Error(`Run or benchmark not found: ${id}`);
  }

  const { createServer } = await import("node:http");
  const { readFile: readFileFs } = await import("node:fs/promises");
  const htmlPath = isBenchmark
    ? resolve(import.meta.dirname, "../../apps/ui/benchmark.html")
    : resolve(import.meta.dirname, "../../apps/ui/index.html");

  const port = options.port;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

    if (url.pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = await readFileFs(htmlPath, "utf-8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(injectDefaultDataDir(html, "/data", "/api/verdict"));
      return;
    }

    if (url.pathname === "/api/verdict" && req.method === "GET") {
      const verdict = await readVerdictResult(itemDir);
      if (verdict.status === "ok") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(verdict.verdict));
        return;
      }
      if (verdict.status === "missing") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: existsSync(summaryPath)
              ? "Verdict result is not available for this legacy run"
              : "Run not found",
            legacy: existsSync(summaryPath),
          }),
        );
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
      const fileName = url.pathname.replace(/^\/data\//, "");
      if (!isAllowedDataFile(fileName)) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Invalid data path");
        return;
      }

      const filePath = resolve(itemDir, fileName);
      if (!isPathInside(itemDir, filePath)) {
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
  return { ...handle, isBenchmark };
}
