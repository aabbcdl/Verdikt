import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetConfig, setConfig } from "../config.js";
import { startDashboardServer } from "./dashboard.js";

const servers: Array<{ close: () => Promise<void> }> = [];
let tempDir: string;
let stateDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "verdikt-dashboard-test-"));
  stateDir = join(tempDir, ".verdikt");
  await mkdir(stateDir, { recursive: true });
  setConfig({ stateDir });
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  resetConfig();
  await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("Dashboard server", () => {
  it("binds to localhost and serves dashboard data", async () => {
    const runId = "run-dashboard-001";
    const runDir = join(stateDir, runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "summary.json"),
      JSON.stringify({
        runId,
        taskId: "task-1",
        stopReason: "passed",
        totalIterations: 1,
        totalCostUsd: 0.25,
        totalDurationMs: 10,
      }),
      "utf-8",
    );

    const server = await startDashboardServer({ port: 0 });
    servers.push(server);

    const response = await fetch(`${server.url}/data/dashboard.json`);
    const data = (await response.json()) as {
      runs: Array<{ runId: string }>;
      stats: { totalRuns: number };
    };

    expect(server.host).toBe("127.0.0.1");
    expect(response.status).toBe(200);
    expect(data.stats.totalRuns).toBe(1);
    expect(data.runs[0].runId).toBe(runId);
  });

  it("normalizes malformed saved-run numbers before building dashboard data", async () => {
    const runId = "run-dashboard-bad-numbers";
    const runDir = join(stateDir, runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "summary.json"),
      JSON.stringify({
        runId,
        taskId: "task-1",
        stopReason: "passed",
        totalIterations: "many",
        totalCostUsd: "<img src=x>",
        totalDurationMs: "slow",
      }),
      "utf-8",
    );

    const server = await startDashboardServer({ port: 0 });
    servers.push(server);

    const response = await fetch(`${server.url}/data/dashboard.json`);
    const data = (await response.json()) as {
      runs: Array<{ totalCostUsd: number; totalDurationMs: number; iterations: number }>;
      stats: { totalCost: number; avgIterations: number };
    };

    expect(response.status).toBe(200);
    expect(server.totalCost).toBe(0);
    expect(data.stats.totalCost).toBe(0);
    expect(data.stats.avgIterations).toBe(0);
    expect(data.runs[0].totalCostUsd).toBe(0);
    expect(data.runs[0].totalDurationMs).toBe(0);
    expect(data.runs[0].iterations).toBe(0);
  });

  it("serves favicon requests without console-noisy 404s", async () => {
    const server = await startDashboardServer({ port: 0 });
    servers.push(server);

    const response = await fetch(`${server.url}/favicon.ico`);

    expect(response.status).toBe(204);
  });

  it("serves run detail pages with a working data path", async () => {
    const runId = "run-dashboard-002";
    const runDir = join(stateDir, runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "summary.json"), JSON.stringify({ runId }), "utf-8");
    await writeFile(join(runDir, "iterations.jsonl"), "", "utf-8");

    const server = await startDashboardServer({ port: 0 });
    servers.push(server);

    const pageResponse = await fetch(`${server.url}/view/${runId}`);
    const pageHtml = await pageResponse.text();
    const dataResponse = await fetch(`${server.url}/data/${runId}/summary.json`);
    const data = (await dataResponse.json()) as { runId: string };

    expect(pageResponse.status).toBe(200);
    expect(pageHtml).toContain(`'/data/${runId}'`);
    expect(dataResponse.status).toBe(200);
    expect(data.runId).toBe(runId);
  });

  it("rejects data paths outside the state folder", async () => {
    const server = await startDashboardServer({ port: 0 });
    servers.push(server);

    const response = await fetch(`${server.url}/data/..%2Fsecret/summary.json`);

    expect(response.status).toBe(400);
  });
});
