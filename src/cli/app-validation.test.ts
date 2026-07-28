import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfig, setConfig } from "../config.js";
import type { RunResult, TaskSpec } from "../types.js";

vi.mock("../loop/supervisor.js", () => ({
  runSupervisorLoop: vi.fn(),
  resumeSupervisorLoop: vi.fn(),
}));

import { resumeSupervisorLoop, runSupervisorLoop } from "../loop/supervisor.js";
import { startAppServer } from "./app.js";

const execFileAsync = promisify(execFile);
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

let tempDir: string;
let repoDir: string;
let stateDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "verdikt-app-validation-test-"));
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

describe("App server task validation", () => {
  it("rejects invalid JSON requests without starting the supervisor", async () => {
    const app = await startAppServer({ port: 0, logStartup: false });
    servers.push(trackApp(app));

    const response = await fetch(`${app.url}/api/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not valid json",
    });
    const body = (await response.json()) as { error?: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe("Invalid JSON request body");
    expect(runSupervisorLoop).not.toHaveBeenCalled();
  });

  it("rejects JSON requests that are not task objects", async () => {
    const app = await startAppServer({ port: 0, logStartup: false });
    servers.push(trackApp(app));

    const response = await fetch(`${app.url}/api/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "null",
    });
    const body = (await response.json()) as { error?: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe("Invalid task request body");
    expect(runSupervisorLoop).not.toHaveBeenCalled();
  });

  it("rejects dirty repositories at submission and accepts them with allowDirtyRepo", async () => {
    const app = await startAppServer({ port: 0, logStartup: false });
    servers.push(trackApp(app));
    await writeFile(join(repoDir, "wip.txt"), "uncommitted work\n", "utf-8");

    const task = {
      id: "dirty-repo-task",
      goal: "Fix the bug in a way that can be checked automatically.",
      repoPath: repoDir,
      acceptance: { steps: [{ id: "test", command: "node", args: ["--version"] }] },
      maxIterations: 3,
    } satisfies TaskSpec;

    const rejected = await fetch(`${app.url}/api/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(task),
    });
    const rejectedBody = (await rejected.json()) as {
      error?: string;
      details?: Array<{ message?: string; fix?: string }>;
    };
    expect(rejected.status).toBe(400);
    expect(rejectedBody.error).toContain("未提交");
    expect(rejectedBody.details?.[0]?.message).toContain("wip.txt");
    expect(rejectedBody.details?.[0]?.fix).toContain("allowDirtyRepo");
    expect(runSupervisorLoop).not.toHaveBeenCalled();

    vi.mocked(runSupervisorLoop).mockResolvedValueOnce({
      reason: "cancelled",
      iterations: [],
      totalDurationMs: 1,
      totalCostUsd: 0,
      applyStatus: "pending",
    } as unknown as RunResult);
    const allowed = await fetch(`${app.url}/api/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...task, allowDirtyRepo: true }),
    });
    const allowedBody = (await allowed.json()) as { status?: string };
    expect(allowed.status).toBe(200);
    expect(allowedBody.status).toBe("queued");
  });

  it("rejects state-changing requests from untrusted browser origins", async () => {
    const app = await startAppServer({ port: 0, logStartup: false });
    servers.push(trackApp(app));

    const response = await fetch(`${app.url}/api/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://attacker.example",
      },
      body: JSON.stringify({
        id: "csrf-start-run",
        goal: "Fix the bug in a way that can be checked automatically.",
        repoPath: repoDir,
        acceptance: { steps: [{ id: "test", command: "node", args: ["--version"] }] },
        maxIterations: 3,
      } satisfies TaskSpec),
    });
    const body = (await response.json()) as { error?: string };

    expect(response.status).toBe(403);
    expect(body.error).toBe("Untrusted request origin");
    expect(runSupervisorLoop).not.toHaveBeenCalled();
  });

  it("rejects task requests with non-string repo paths before filesystem checks", async () => {
    const app = await startAppServer({ port: 0, logStartup: false });
    servers.push(trackApp(app));

    const response = await fetch(`${app.url}/api/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "bad-repo-path",
        goal: "Fix the bug in a way that can be checked automatically.",
        repoPath: 42,
        acceptance: { steps: [{ id: "test", command: "node", args: ["--version"] }] },
        maxIterations: 3,
      }),
    });
    const body = (await response.json()) as { error?: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe("repoPath and goal are required");
    expect(runSupervisorLoop).not.toHaveBeenCalled();
  });

  it("rejects invalid run requests before starting the supervisor", async () => {
    const app = await startAppServer({ port: 0, logStartup: false });
    servers.push(trackApp(app));

    const response = await fetch(`${app.url}/api/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "invalid-task",
        goal: "Fix the bug in a way that can be checked automatically.",
        repoPath: repoDir,
        acceptance: {
          steps: [{ id: "lint", command: "npm", args: ["run", "lint"], required: false }],
        },
        maxIterations: 3,
      } satisfies TaskSpec),
    });
    const body = (await response.json()) as { error?: string; details?: Array<{ field: string }> };

    expect(response.status).toBe(400);
    expect(body.error).toBe("Task validation failed");
    expect(body.details?.some((detail) => detail.field === "acceptance.steps")).toBe(true);
    expect(runSupervisorLoop).not.toHaveBeenCalled();
  });

  it("accepts a valid request after shared validation passes", async () => {
    vi.mocked(runSupervisorLoop).mockResolvedValue({
      reason: "passed",
      iterations: [],
      totalDurationMs: 1,
      totalCostUsd: 0,
      runId: "run-valid-001",
    } satisfies RunResult);

    const app = await startAppServer({ port: 0, logStartup: false });
    servers.push(trackApp(app));

    const response = await fetch(`${app.url}/api/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "valid-task",
        goal: "Fix the bug in a way that can be checked automatically.",
        repoPath: repoDir,
        acceptance: { steps: [{ id: "test", command: "node", args: ["--version"] }] },
        maxIterations: 3,
      } satisfies TaskSpec),
    });
    const body = (await response.json()) as { runId?: string };

    expect(response.status).toBe(200);
    expect(body.runId).toBeTruthy();
    await vi.waitFor(() => {
      expect(runSupervisorLoop).toHaveBeenCalledOnce();
    });
  });

  it("queues multiple run requests and exposes them in the workbench", async () => {
    let releaseFirstRun: () => void = () => undefined;
    const firstRunCanFinish = new Promise<void>((resolve) => {
      releaseFirstRun = resolve;
    });
    let runCallCount = 0;

    vi.mocked(runSupervisorLoop).mockImplementation(async (_task, options) => {
      if (!options?.runId) throw new Error("Expected run id");
      runCallCount += 1;
      if (runCallCount === 1) {
        await firstRunCanFinish;
      }
      return {
        reason: "passed",
        iterations: [],
        totalDurationMs: 1,
        totalCostUsd: 0,
        runId: options.runId,
      } satisfies RunResult;
    });

    const app = await startAppServer({ port: 0, logStartup: false });
    servers.push(trackApp(app));

    const task = {
      id: "valid-task",
      goal: "Fix the bug in a way that can be checked automatically.",
      repoPath: repoDir,
      acceptance: { steps: [{ id: "test", command: "node", args: ["--version"] }] },
      maxIterations: 3,
    } satisfies TaskSpec;

    const firstResponse = await fetch(`${app.url}/api/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(task),
    });
    const secondResponse = await fetch(`${app.url}/api/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...task, id: "valid-task-2" }),
    });

    const first = (await firstResponse.json()) as { runId: string; status: string };
    const second = (await secondResponse.json()) as {
      runId: string;
      status: string;
      queuePosition: number;
    };

    expect(first.status).toBe("queued");
    expect(second.status).toBe("queued");
    expect(second.queuePosition).toBeGreaterThanOrEqual(0);

    await vi.waitFor(async () => {
      const response = await fetch(`${app.url}/api/runs`);
      const body = (await response.json()) as {
        activeRunId?: string;
        live: Array<{ runId: string; status: string; queuePosition: number }>;
      };
      expect(body.activeRunId).toBe(first.runId);
      expect(body.live.find((run) => run.runId === first.runId)?.status).toBe("running");
      expect(body.live.find((run) => run.runId === second.runId)?.status).toBe("queued");
    });

    releaseFirstRun();
  });

  it("persists queued, running, and heartbeat updates to queue.json", async () => {
    let releaseRun: () => void = () => undefined;
    const runCanFinish = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });

    let emitLog: ((message: string) => void) | undefined;
    vi.mocked(runSupervisorLoop).mockImplementation(async (_task, options) => {
      emitLog = options?.onLog;
      await runCanFinish;
      return {
        reason: "passed",
        iterations: [],
        totalDurationMs: 1,
        totalCostUsd: 0,
        runId: options?.runId,
      } satisfies RunResult;
    });

    const app = await startAppServer({ port: 0, logStartup: false });
    servers.push(trackApp(app));
    const task = {
      id: "persisted-task",
      goal: "Persist this queued task.",
      repoPath: repoDir,
      acceptance: { steps: [{ id: "test", command: "node", args: ["--version"] }] },
    } satisfies TaskSpec;

    const first = (await (
      await fetch(`${app.url}/api/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(task),
      })
    ).json()) as { runId: string };
    const second = (await (
      await fetch(`${app.url}/api/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...task, id: "persisted-task-2" }),
      })
    ).json()) as { runId: string };

    await vi.waitFor(() => expect(emitLog).toBeTypeOf("function"));
    emitLog?.("Executor heartbeat");

    try {
      await vi.waitFor(
        async () => {
          const queue = JSON.parse(await readFile(join(stateDir, "queue.json"), "utf-8")) as {
            activeRunId: string | null;
            order: string[];
            items: Record<string, { status: string; heartbeatAt?: string; lastLog?: string }>;
          };
          expect(queue.activeRunId).toBe(first.runId);
          expect(queue.order).toContain(second.runId);
          expect(queue.items[first.runId]?.status).toBe("running");
          expect(queue.items[first.runId]?.heartbeatAt).toBeTruthy();
          expect(queue.items[first.runId]?.lastLog).toContain("Executor heartbeat");
          expect(queue.items[second.runId]?.status).toBe("queued");
        },
        { timeout: 10_000, interval: 100 },
      );
    } finally {
      releaseRun();
    }
  });

  it("continues persisted work automatically after the workbench restarts", async () => {
    vi.mocked(runSupervisorLoop).mockImplementation(async (interruptedTask, options) => {
      await new Promise<void>((resolve) => {
        options?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      // Faithful to the real supervisor: an interrupted run persists BOTH a
      // summary (with resumable: true) AND resumable state before returning.
      // The old unfaithful mock (no files) hid a recovery bug that marked
      // interrupted runs "completed" after restart.
      const runDir = join(stateDir, String(options?.runId));
      await mkdir(runDir, { recursive: true });
      await writeFile(
        join(runDir, "summary.json"),
        JSON.stringify({ stopReason: "interrupted", resumable: true }),
        "utf-8",
      );
      await writeFile(
        join(runDir, "state.json"),
        JSON.stringify({
          task: interruptedTask,
          instruction: "continue",
          nextIteration: 0,
          totalCostUsd: 0,
          totalDurationMs: 1,
          lastSavedAt: new Date().toISOString(),
          useWorktree: false,
          useIntegrity: false,
          phase: "interrupted",
        }),
        "utf-8",
      );
      return {
        reason: "interrupted",
        iterations: [],
        totalDurationMs: 1,
        totalCostUsd: 0,
        runId: options?.runId,
        applyStatus: "pending",
        resumable: true,
      } satisfies RunResult;
    });

    const firstApp = await startAppServer({ port: 0, logStartup: false });
    servers.push(trackApp(firstApp));
    const task = {
      id: "restart-task",
      goal: "Continue this task after restart.",
      repoPath: repoDir,
      acceptance: { steps: [{ id: "test", command: "node", args: ["--version"] }] },
    } satisfies TaskSpec;

    const first = (await (
      await fetch(`${firstApp.url}/api/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(task),
      })
    ).json()) as { runId: string };
    const second = (await (
      await fetch(`${firstApp.url}/api/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...task, id: "restart-task-2" }),
      })
    ).json()) as { runId: string };

    await vi.waitFor(() => expect(runSupervisorLoop).toHaveBeenCalledOnce());
    await firstApp.close();

    const saved = JSON.parse(await readFile(join(stateDir, "queue.json"), "utf-8")) as {
      items: Record<string, { status: string }>;
    };
    expect(saved.items[first.runId]?.status).toBe("resumable");
    expect(saved.items[second.runId]?.status).toBe("queued");

    vi.mocked(runSupervisorLoop).mockReset();
    vi.mocked(runSupervisorLoop).mockImplementation(async (_task, options) => ({
      reason: "passed",
      iterations: [],
      totalDurationMs: 1,
      totalCostUsd: 0,
      runId: options?.runId,
    }));
    vi.mocked(resumeSupervisorLoop).mockReset();
    vi.mocked(resumeSupervisorLoop).mockResolvedValue({
      reason: "passed",
      iterations: [],
      totalDurationMs: 1,
      totalCostUsd: 0,
    } as unknown as RunResult);

    const restartedApp = await startAppServer({ port: 0, logStartup: false });
    servers.push(trackApp(restartedApp));
    // The interrupted run continues from its saved state (resume), and the
    // never-started second task runs fresh.
    await vi.waitFor(() => {
      expect(resumeSupervisorLoop).toHaveBeenCalledTimes(1);
      expect(runSupervisorLoop).toHaveBeenCalledTimes(1);
    });
    expect(vi.mocked(resumeSupervisorLoop).mock.calls[0]?.[0]).toContain(first.runId);
  });

  it("surfaces supervisor log messages in the run status endpoint", async () => {
    let releaseRun: () => void = () => undefined;
    const runCanFinish = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });

    vi.mocked(runSupervisorLoop).mockImplementation(async (_task, options) => {
      const logOptions = options as { onLog?: (message: string) => void };
      logOptions.onLog?.("Executor running in isolated workspace");
      await runCanFinish;
      return {
        reason: "passed",
        iterations: [],
        totalDurationMs: 1,
        totalCostUsd: 0,
        runId: "run-valid-001",
      } satisfies RunResult;
    });

    const app = await startAppServer({ port: 0, logStartup: false });
    servers.push(trackApp(app));

    try {
      const startResponse = await fetch(`${app.url}/api/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "valid-task",
          goal: "Fix the bug in a way that can be checked automatically.",
          repoPath: repoDir,
          acceptance: { steps: [{ id: "test", command: "node", args: ["--version"] }] },
          maxIterations: 3,
        } satisfies TaskSpec),
      });
      const startBody = (await startResponse.json()) as { runId?: string };

      await vi.waitFor(async () => {
        const statusResponse = await fetch(`${app.url}/api/run/${startBody.runId}`);
        const statusBody = (await statusResponse.json()) as { log?: string };
        expect(statusBody.log).toContain("Executor running in isolated workspace");
      });
    } finally {
      releaseRun();
    }
  });

  it("expires completed live status and falls back to the saved run summary", async () => {
    vi.mocked(runSupervisorLoop).mockImplementation(async (_task, options) => {
      if (!options?.runId) throw new Error("Expected run id");
      const runDir = join(stateDir, options.runId);
      await mkdir(runDir, { recursive: true });
      await writeFile(
        join(runDir, "summary.json"),
        JSON.stringify(
          {
            runId: options.runId,
            stopReason: "passed",
            totalIterations: 1,
            totalCostUsd: 0,
            totalDurationMs: 1,
          },
          null,
          2,
        ),
        "utf-8",
      );
      return {
        reason: "passed",
        iterations: [],
        totalDurationMs: 1,
        totalCostUsd: 0,
        runId: options.runId,
      } satisfies RunResult;
    });

    const app = await startAppServer({
      port: 0,
      logStartup: false,
      terminalRunTtlMs: 250,
    });
    servers.push(trackApp(app));

    const startResponse = await fetch(`${app.url}/api/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "valid-task",
        goal: "Fix the bug in a way that can be checked automatically.",
        repoPath: repoDir,
        acceptance: { steps: [{ id: "test", command: "node", args: ["--version"] }] },
        maxIterations: 3,
      } satisfies TaskSpec),
    });
    const startBody = (await startResponse.json()) as { runId?: string };

    await vi.waitFor(async () => {
      const statusResponse = await fetch(`${app.url}/api/run/${startBody.runId}`);
      const statusBody = (await statusResponse.json()) as { status?: string; log?: string };
      expect(statusBody.status).toBe("completed");
      expect(statusBody.log).toContain("Starting run");
    });

    await vi.waitFor(async () => {
      const statusResponse = await fetch(`${app.url}/api/run/${startBody.runId}`);
      const statusBody = (await statusResponse.json()) as { status?: string; log?: string };
      expect(statusBody.status).toBe("completed");
      expect(statusBody.log).toBe(`Run ${startBody.runId} completed.`);
    });
  });

  it("returns saved apply status in completed run status", async () => {
    const runId = "run-applied-status";
    const runDir = join(stateDir, runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "summary.json"),
      JSON.stringify(
        {
          runId,
          stopReason: "passed",
          totalIterations: 1,
          totalCostUsd: 0,
          totalDurationMs: 1,
          applyStatus: "applied",
        },
        null,
        2,
      ),
      "utf-8",
    );

    const app = await startAppServer({ port: 0, logStartup: false });
    servers.push(trackApp(app));

    const statusResponse = await fetch(`${app.url}/api/run/${runId}`);
    const statusBody = (await statusResponse.json()) as {
      result?: { applyStatus?: string };
    };

    expect(statusResponse.status).toBe(200);
    expect(statusBody.result?.applyStatus).toBe("applied");
  });

  it("serves saved patch review data", async () => {
    const runId = "run-patch-review";
    const runDir = join(stateDir, runId);
    await mkdir(join(runDir, "evidence"), { recursive: true });
    await writeFile(
      join(runDir, "summary.json"),
      JSON.stringify({ runId, stopReason: "passed", applyStatus: "pending" }),
      "utf-8",
    );
    await writeFile(
      join(runDir, "evidence", "final.patch"),
      [
        "diff --git a/src/sum.ts b/src/sum.ts",
        "+++ b/src/sum.ts",
        "@@ -1,1 +1,1 @@",
        "-return a - b;",
        "+return a + b;",
      ].join("\n"),
      "utf-8",
    );

    const app = await startAppServer({ port: 0, logStartup: false });
    servers.push(trackApp(app));

    const response = await fetch(`${app.url}/api/patch/${runId}`);
    const body = (await response.json()) as { available: boolean; files: Array<{ path: string }> };

    expect(response.status).toBe(200);
    expect(body.available).toBe(true);
    expect(body.files[0].path).toBe("src/sum.ts");
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
