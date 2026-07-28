import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfig, setConfig } from "../config.js";
import type { RunResult, TaskSpec } from "../types.js";

vi.mock("../loop/supervisor.js", () => ({
  runSupervisorLoop: vi.fn(),
}));

vi.mock("../trace/recorder.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../trace/recorder.js")>();
  return {
    ...actual,
    createRunId: () => "run-cancel-001",
  };
});

import { runSupervisorLoop } from "../loop/supervisor.js";
import { startAppServer } from "./app.js";

const servers: Array<{ close: () => Promise<void> }> = [];

type AppSessionServer = {
  url: string;
  sessionHeaders: Readonly<Record<string, string>>;
};

const appSessionHeaders = new Map<string, Readonly<Record<string, string>>>();
const nativeFetch = globalThis.fetch.bind(globalThis);

async function fetch(...args: Parameters<typeof globalThis.fetch>): Promise<Response> {
  const [input, init] = args;
  const requestUrl = new URL(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
  );
  const sessionHeaders = appSessionHeaders.get(requestUrl.origin);
  if (!sessionHeaders) return nativeFetch(input, init);

  const headers = new Headers(init?.headers);
  for (const [name, value] of Object.entries(sessionHeaders)) {
    if (!headers.has(name)) headers.set(name, value);
  }
  return nativeFetch(input, { ...init, headers });
}

function trackApp<T extends AppSessionServer>(app: T): T {
  appSessionHeaders.set(new URL(app.url).origin, app.sessionHeaders);
  return app;
}

const execFileAsync = promisify(execFile);
let tempDir: string;
let repoDir: string;
let stateDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "verdikt-app-cancel-test-"));
  repoDir = join(tempDir, "repo");
  stateDir = join(tempDir, ".verdikt");
  await mkdir(repoDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await initGitRepo(repoDir);
  setConfig({ stateDir });
  vi.mocked(runSupervisorLoop).mockReset();
}, 30_000);

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  resetConfig();
  await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}, 30_000);

describe("App server run cancellation", () => {
  it("refuses to apply a live run before it is completed", async () => {
    let observedSignal: AbortSignal | undefined;

    vi.mocked(runSupervisorLoop).mockImplementation(async (_task: TaskSpec, options) => {
      if (!options) throw new Error("Expected supervisor options");
      observedSignal = options.signal;
      await new Promise<void>((resolve) => {
        observedSignal?.addEventListener("abort", () => resolve(), { once: true });
      });

      return {
        reason: "cancelled",
        iterations: [],
        totalDurationMs: 25,
        totalCostUsd: 0,
        runId: options.runId,
      } satisfies RunResult;
    });

    const app = await startAppServer({ port: 0, logStartup: false });
    servers.push(trackApp(app));

    const startResponse = await fetch(`${app.url}/api/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "apply-live-test",
        goal: "Keep running until cancelled",
        repoPath: repoDir,
        acceptance: { steps: [{ id: "test", command: "npm", args: ["test"] }] },
        maxIterations: 5,
      } satisfies TaskSpec),
    });
    const started = (await startResponse.json()) as { runId: string };

    await vi.waitFor(() => {
      expect(observedSignal?.aborted).toBe(false);
    });

    const applyResponse = await fetch(`${app.url}/api/apply/${started.runId}`, {
      method: "POST",
    });
    const applyBody = (await applyResponse.json()) as { error?: string };

    expect(applyResponse.status).toBe(409);
    expect(applyBody.error).toContain("completed");
    expect(observedSignal?.aborted).toBe(false);
  });

  it("refuses to discard a live run before it is stopped", async () => {
    let observedSignal: AbortSignal | undefined;

    vi.mocked(runSupervisorLoop).mockImplementation(async (_task: TaskSpec, options) => {
      if (!options) throw new Error("Expected supervisor options");
      observedSignal = options.signal;
      await new Promise<void>((resolve) => {
        observedSignal?.addEventListener("abort", () => resolve(), { once: true });
      });

      return {
        reason: "cancelled",
        iterations: [],
        totalDurationMs: 25,
        totalCostUsd: 0,
        runId: options.runId,
      } satisfies RunResult;
    });

    const app = await startAppServer({ port: 0, logStartup: false });
    servers.push(trackApp(app));

    const startResponse = await fetch(`${app.url}/api/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "discard-live-test",
        goal: "Keep running until cancelled",
        repoPath: repoDir,
        acceptance: { steps: [{ id: "test", command: "npm", args: ["test"] }] },
        maxIterations: 5,
      } satisfies TaskSpec),
    });
    const started = (await startResponse.json()) as { runId: string };

    await vi.waitFor(() => {
      expect(observedSignal?.aborted).toBe(false);
    });

    const discardResponse = await fetch(`${app.url}/api/discard/${started.runId}`, {
      method: "POST",
    });
    const discardBody = (await discardResponse.json()) as { error?: string };

    expect(discardResponse.status).toBe(409);
    expect(discardBody.error).toContain("completed");
    expect(observedSignal?.aborted).toBe(false);
  });

  it("aborts the live supervisor run and reports it as cancelled", async () => {
    let observedSignal: AbortSignal | undefined;

    vi.mocked(runSupervisorLoop).mockImplementation(async (_task: TaskSpec, options) => {
      if (!options) throw new Error("Expected supervisor options");
      observedSignal = options.signal;
      await new Promise<void>((resolve) => {
        observedSignal?.addEventListener("abort", () => resolve(), { once: true });
      });

      return {
        reason: "cancelled",
        iterations: [],
        totalDurationMs: 25,
        totalCostUsd: 0,
        runId: options.runId,
      } satisfies RunResult;
    });

    const app = await startAppServer({ port: 0, logStartup: false });
    servers.push(trackApp(app));

    const startResponse = await fetch(`${app.url}/api/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "cancel-test",
        goal: "Keep running until cancelled",
        repoPath: repoDir,
        acceptance: { steps: [{ id: "test", command: "npm", args: ["test"] }] },
        maxIterations: 5,
      } satisfies TaskSpec),
    });
    const started = (await startResponse.json()) as { runId: string };

    expect(startResponse.status).toBe(200);
    expect(started.runId).toBe("run-cancel-001");
    await vi.waitFor(() => {
      expect(observedSignal?.aborted).toBe(false);
    });

    const cancelResponse = await fetch(`${app.url}/api/cancel/${started.runId}`, {
      method: "POST",
    });
    const cancelBody = (await cancelResponse.json()) as { success?: boolean };

    expect(cancelResponse.status).toBe(200);
    expect(cancelBody.success).toBe(true);
    expect(observedSignal?.aborted).toBe(true);

    await vi.waitFor(async () => {
      const statusResponse = await fetch(`${app.url}/api/run/${started.runId}`);
      const statusBody = (await statusResponse.json()) as {
        status: string;
        result: { stopReason?: string; passed?: boolean } | null;
      };

      expect(statusResponse.status).toBe(200);
      expect(statusBody.status).toBe("cancelled");
      expect(statusBody.result?.stopReason).toBe("cancelled");
      expect(statusBody.result?.passed).toBe(false);
    });
  });
});

async function initGitRepo(cwd: string): Promise<void> {
  await writeFile(join(cwd, "README.md"), "# test repo\n", "utf-8");
  await execFileAsync("git", ["init"], { cwd });
  await execFileAsync("git", ["config", "user.email", "verdikt@example.test"], { cwd });
  await execFileAsync("git", ["config", "user.name", "Verdikt Test"], { cwd });
  await execFileAsync("git", ["add", "README.md"], { cwd });
  await execFileAsync("git", ["commit", "-m", "init", "--no-gpg-sign"], { cwd });
}
