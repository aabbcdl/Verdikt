/**
 * CLI handler for `verdikt view` command.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export async function handleView(args: string[]): Promise<void> {
  const id = args[0];
  if (!id) {
    console.error("Error: run-id or benchmark-id is required");
    console.error("Usage: verdikt view <run-id|benchmark-id>");
    process.exit(1);
  }

  const config = (await import("../config.js")).getConfig();
  const itemDir = resolve(config.stateDir, id);
  const summaryPath = join(itemDir, "summary.json");
  const benchmarkPath = join(itemDir, "benchmark.json");

  const isBenchmark = existsSync(benchmarkPath);
  const isRun = existsSync(summaryPath);

  if (!isBenchmark && !isRun) {
    console.error(`\n❌ Run or benchmark not found: ${id}`);
    console.error('\nUse "verdikt list" to see available runs and benchmarks.');
    process.exit(1);
  }

  // Serve the UI
  const { createServer } = await import("node:http");
  const { readFile: readFileFs } = await import("node:fs/promises");
  const runUiPath = resolve(import.meta.dirname, "../../apps/ui/index.html");
  const benchUiPath = resolve(import.meta.dirname, "../../apps/ui/benchmark.html");
  const htmlPath = isBenchmark ? benchUiPath : runUiPath;

  const port = 3847;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = await readFileFs(htmlPath, "utf-8");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    } else if (url.pathname.startsWith("/data/")) {
      // Serve run/benchmark data files
      const filePath = resolve(itemDir, url.pathname.replace("/data/", ""));
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
    const label = isBenchmark ? "Benchmark Viewer" : "Run Viewer";
    console.log(`\n🌐 Verdikt ${label}`);
    console.log(`   ${isBenchmark ? "Benchmark" : "Run"}: ${id}`);
    console.log(`   URL: http://localhost:${port}?dir=/data`);
    console.log("\n   Press Ctrl+C to stop.\n");
  });
}
