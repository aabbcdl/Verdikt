import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { parseStressArgs, runHttpLoad, summarizeHttpSamples } from "./runner.js";

describe("stress runner", () => {
  it("parses stress options with safe defaults and explicit overrides", () => {
    expect(parseStressArgs([])).toMatchObject({
      scenario: "all",
      iterations: 20,
      concurrency: 4,
      httpRequests: 100,
      httpConcurrency: 10,
      maxP95Ms: 1000,
    });

    expect(
      parseStressArgs([
        "--scenario=http",
        "--iterations=7",
        "--concurrency=2",
        "--http-requests=24",
        "--http-concurrency=6",
        "--http-url=http://127.0.0.1:3849",
        "--max-p95-ms=250",
        "--keep-temp",
      ]),
    ).toMatchObject({
      scenario: "http",
      iterations: 7,
      concurrency: 2,
      httpRequests: 24,
      httpConcurrency: 6,
      httpUrl: "http://127.0.0.1:3849",
      maxP95Ms: 250,
      keepTemp: true,
    });
  });

  it("rejects invalid stress options before running anything expensive", () => {
    expect(() => parseStressArgs(["--scenario=jmeter"])).toThrow("Invalid scenario");
    expect(() => parseStressArgs(["--iterations=0"])).toThrow("iterations");
    expect(() => parseStressArgs(["--http-requests=nope"])).toThrow("http-requests");
  });

  it("runs bounded concurrent HTTP load and reports latency", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let total = 0;

    const server = createServer(async (_req, res) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      total += 1;
      await sleep(10);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      inFlight -= 1;
    });

    const url = await listen(server);
    try {
      const result = await runHttpLoad({
        baseUrl: url,
        paths: ["/ok"],
        requests: 20,
        concurrency: 5,
      });

      expect(result.total).toBe(20);
      expect(result.failed).toBe(0);
      expect(result.statusCounts[200]).toBe(20);
      expect(result.p95Ms).toBeGreaterThanOrEqual(0);
      expect(result.requestsPerSecond).toBeGreaterThan(0);
      expect(maxInFlight).toBeLessThanOrEqual(5);
      expect(total).toBe(20);
    } finally {
      await close(server);
    }
  });

  it("counts failing HTTP responses as failed load samples", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("busy");
    });

    const url = await listen(server);
    try {
      const result = await runHttpLoad({
        baseUrl: url,
        paths: ["/busy"],
        requests: 3,
        concurrency: 2,
      });

      expect(result.total).toBe(3);
      expect(result.failed).toBe(3);
      expect(result.statusCounts[503]).toBe(3);
    } finally {
      await close(server);
    }
  });

  it("summarizes empty HTTP samples without NaN values", () => {
    expect(summarizeHttpSamples([], 1000)).toMatchObject({
      total: 0,
      failed: 0,
      minMs: 0,
      avgMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      maxMs: 0,
      requestsPerSecond: 0,
    });
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No server address");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}
