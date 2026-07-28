import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetConfig, setConfig } from "../config.js";
import { startViewServer } from "./view.js";

const servers: Array<{ close: () => Promise<void> }> = [];
let tempDir: string;
let stateDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "verdikt-view-test-"));
  stateDir = join(tempDir, ".verdikt");
  await mkdir(stateDir, { recursive: true });
  setConfig({ stateDir });
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  resetConfig();
  await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("View server", () => {
  it("binds to localhost and serves run data", async () => {
    const runId = "run-view-001";
    const runDir = join(stateDir, runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "summary.json"), JSON.stringify({ runId }), "utf-8");
    await writeFile(join(runDir, "iterations.jsonl"), "", "utf-8");

    const server = await startViewServer({ id: runId, port: 0 });
    servers.push(server);

    const pageResponse = await fetch(server.url);
    const pageHtml = await pageResponse.text();
    const dataResponse = await fetch(`${server.url}/data/summary.json`);
    const data = (await dataResponse.json()) as { runId: string };

    expect(server.host).toBe("127.0.0.1");
    expect(pageResponse.status).toBe(200);
    expect(pageHtml).toContain("'/data'");
    expect(dataResponse.status).toBe(200);
    expect(data.runId).toBe(runId);
  });

  it("serves favicon requests without console-noisy 404s", async () => {
    const runId = "run-view-favicon";
    const runDir = join(stateDir, runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "summary.json"), JSON.stringify({ runId }), "utf-8");

    const server = await startViewServer({ id: runId, port: 0 });
    servers.push(server);

    const response = await fetch(`${server.url}/favicon.ico`);

    expect(response.status).toBe(204);
  });

  it("rejects data paths outside the run folder", async () => {
    const runId = "run-view-002";
    const runDir = join(stateDir, runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "summary.json"), JSON.stringify({ runId }), "utf-8");

    const server = await startViewServer({ id: runId, port: 0 });
    servers.push(server);

    const response = await fetch(`${server.url}/data/..%2Fsecret.json`);

    expect(response.status).toBe(400);
  });

  it("rejects viewer IDs that try to leave the state directory", async () => {
    const outsideDir = join(tempDir, "outside-run");
    await mkdir(outsideDir, { recursive: true });
    await writeFile(
      join(outsideDir, "summary.json"),
      JSON.stringify({ runId: "outside" }),
      "utf-8",
    );

    await expect(startViewServer({ id: "../outside-run", port: 0 })).rejects.toThrow(
      "Invalid run or benchmark ID",
    );
  });
});
