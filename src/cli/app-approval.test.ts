import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { consumeActionGrant, requestActionApproval } from "../approval/actionStore.js";
import { createApprovalRequest, readApprovalRecord } from "../approval/store.js";
import { resetConfig, setConfig } from "../config.js";
import type { RunResult, TaskSpec } from "../types.js";
import {
  emptyPersistedRunQueue,
  savePersistedRunQueue,
  upsertPersistedRun,
} from "./persistentQueue.js";

vi.mock("../loop/supervisor.js", () => ({
  runSupervisorLoop: vi.fn(),
  resumeSupervisorLoop: vi.fn(),
}));

import { resumeSupervisorLoop, runSupervisorLoop } from "../loop/supervisor.js";
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

let tempDir: string;
let stateDir: string;
let runDir: string;
const runId = "run-approval-web-001";
const task: TaskSpec = {
  id: "release-task",
  goal: "Deploy to production after approval",
  repoPath: ".",
  acceptance: { testCommand: "node --version" },
};

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "verdikt-app-approval-"));
  stateDir = join(tempDir, ".verdikt");
  runDir = join(stateDir, runId);
  task.repoPath = tempDir;
  await mkdir(join(runDir, "evidence"), { recursive: true });
  await writeFile(join(runDir, "task.json"), JSON.stringify(task), "utf-8");
  await writeFile(
    join(runDir, "state.json"),
    JSON.stringify({
      task,
      instruction: task.goal,
      nextIteration: 0,
      totalCostUsd: 0,
      totalDurationMs: 0,
      lastSavedAt: new Date().toISOString(),
      useWorktree: false,
      useIntegrity: false,
      phase: "waiting_approval",
    }),
    "utf-8",
  );
  await createApprovalRequest(runDir, {
    categories: ["deployment", "production"],
    reason: "Production release",
  });
  let queue = emptyPersistedRunQueue();
  queue = upsertPersistedRun(queue, {
    runId,
    task,
    mode: "resume",
    status: "waiting_approval",
    queuedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    resumeRunDir: runDir,
    approvalRequest: {
      categories: ["deployment", "production"],
      reason: "Production release",
    },
  });
  await savePersistedRunQueue(stateDir, queue);
  setConfig({ stateDir });
  vi.mocked(resumeSupervisorLoop).mockReset();
  vi.mocked(runSupervisorLoop).mockReset();
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  resetConfig();
  await rm(tempDir, { recursive: true, force: true });
});

describe("App approval and evidence APIs", () => {
  it("approves and automatically continues a waiting run", async () => {
    vi.mocked(resumeSupervisorLoop).mockResolvedValue({
      reason: "passed",
      iterations: [],
      totalDurationMs: 1,
      totalCostUsd: 0,
      runId,
    } satisfies RunResult);
    const app = await startAppServer({ port: 0, logStartup: false });
    servers.push(trackApp(app));

    // The hero phase must agree with the waiting badge — no "executor running"
    // contradiction on the approval surface.
    const waitingStatus = (await (await fetch(`${app.url}/api/run/${runId}`)).json()) as {
      status?: string;
      phase?: { title?: string; phase?: string };
    };
    expect(waitingStatus.status).toBe("waiting_approval");
    expect(waitingStatus.phase?.title).toContain("确认");

    const response = await fetch(`${app.url}/api/approve/${runId}`, { method: "POST" });
    const body = (await response.json()) as { status?: string };

    expect(response.status).toBe(200);
    expect(body.status).toBe("queued");
    await vi.waitFor(() =>
      expect(resumeSupervisorLoop).toHaveBeenCalledWith(runDir, expect.anything()),
    );
    expect((await readApprovalRecord(runDir))?.status).toBe("approved");
  });

  it("shows and grants an exact action for the requested scope", async () => {
    await requestActionApproval(runDir, {
      signature: "publish-action",
      command: "npm publish",
      tool: "Bash",
      cwd: tempDir,
      categories: ["deployment", "external_write"],
      reason: "Publish package",
    });
    let queue = emptyPersistedRunQueue();
    queue = upsertPersistedRun(queue, {
      runId,
      task,
      mode: "resume",
      status: "waiting_approval",
      queuedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      resumeRunDir: runDir,
      approvalRequest: {
        categories: ["deployment", "external_write"],
        reason: "Publish package",
        action: {
          signature: "publish-action",
          command: "npm publish",
          tool: "Bash",
          cwd: tempDir,
        },
      },
    });
    await savePersistedRunQueue(stateDir, queue);
    vi.mocked(resumeSupervisorLoop).mockResolvedValue({
      reason: "passed",
      iterations: [],
      totalDurationMs: 1,
      totalCostUsd: 0,
      usageStatus: "unknown",
      runId,
    } satisfies RunResult);
    const app = await startAppServer({ port: 0, logStartup: false });
    servers.push(trackApp(app));

    const runs = (await (await fetch(`${app.url}/api/runs`)).json()) as {
      live: Array<{ approvalRequest?: { action?: { command?: string } } }>;
    };
    expect(runs.live[0].approvalRequest?.action?.command).toBe("npm publish");

    const response = await fetch(`${app.url}/api/approve/${runId}?scope=run`, { method: "POST" });
    expect(response.status).toBe(200);
    expect(await consumeActionGrant(runDir, "publish-action")).toBe(true);
    expect(await consumeActionGrant(runDir, "publish-action")).toBe(true);
  });

  it("shows and approves an exact action while the executor is still running", async () => {
    // Hermetic fixture: a clean throwaway git repo. Never point at the live
    // project checkout — a dirty real repo root is (correctly) rejected by
    // the submission preflight.
    const liveRepoDir = join(tempDir, "live-repo");
    await mkdir(liveRepoDir, { recursive: true });
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const runGit = promisify(execFile);
    await runGit("git", ["init", "-q"], { cwd: liveRepoDir });
    await runGit("git", ["config", "user.email", "test@verdikt.local"], { cwd: liveRepoDir });
    await runGit("git", ["config", "user.name", "Verdikt Test"], { cwd: liveRepoDir });
    await writeFile(join(liveRepoDir, "a.txt"), "a\n", "utf-8");
    await runGit("git", ["add", "-A"], { cwd: liveRepoDir });
    await runGit("git", ["commit", "-q", "-m", "init", "--no-gpg-sign"], { cwd: liveRepoDir });

    let releaseRun: (() => void) | undefined;
    vi.mocked(runSupervisorLoop).mockImplementation(async (incomingTask, options) => {
      const liveRunId = options.runId as string;
      const liveRunDir = join(stateDir, liveRunId);
      await mkdir(join(liveRunDir, "evidence"), { recursive: true });
      await writeFile(join(liveRunDir, "task.json"), JSON.stringify(incomingTask), "utf-8");
      await writeFile(
        join(liveRunDir, "state.json"),
        JSON.stringify({
          task: incomingTask,
          instruction: incomingTask.goal,
          nextIteration: 0,
          totalCostUsd: 0,
          totalDurationMs: 0,
          lastSavedAt: new Date().toISOString(),
          useWorktree: false,
          useIntegrity: false,
          phase: "running",
        }),
        "utf-8",
      );
      await requestActionApproval(liveRunDir, {
        signature: "live-action",
        command: "npm publish",
        tool: "Bash",
        cwd: tempDir,
        categories: ["external_write"],
        reason: "Publish package",
      });
      await new Promise<void>((resolve) => {
        releaseRun = resolve;
      });
      return {
        reason: "passed",
        iterations: [],
        totalDurationMs: 1,
        totalCostUsd: 0,
        runId: liveRunId,
      } satisfies RunResult;
    });

    const app = await startAppServer({ port: 0, logStartup: false });
    servers.push(trackApp(app));
    const start = await fetch(`${app.url}/api/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...task, id: "live-action-task", repoPath: liveRepoDir }),
    });
    const started = (await start.json()) as { runId?: string; error?: string };
    expect(start.status, JSON.stringify(started)).toBe(200);
    expect(started.runId).toBeTruthy();

    await vi.waitFor(async () => {
      const response = await fetch(`${app.url}/api/run/${started.runId as string}`);
      const status = (await response.json()) as {
        status: string;
        approvalRequest?: ApprovalRequest;
      };
      expect(status.status).toBe("waiting_approval");
      expect(status.approvalRequest?.action?.command).toBe("npm publish");
    });

    const approval = await fetch(`${app.url}/api/approve/${started.runId as string}`, {
      method: "POST",
    });
    const approvalBody = (await approval.json()) as { status?: string; continued?: boolean };
    expect(approval.status).toBe(200);
    expect(approvalBody).toMatchObject({ status: "running", continued: true });
    expect(runSupervisorLoop).toHaveBeenCalledTimes(1);
    expect(await consumeActionGrant(join(stateDir, started.runId as string), "live-action")).toBe(
      true,
    );

    releaseRun?.();
  });

  it("rejects and lets the supervisor finish the run safely", async () => {
    vi.mocked(resumeSupervisorLoop).mockResolvedValue({
      reason: "approval_rejected",
      iterations: [],
      totalDurationMs: 1,
      totalCostUsd: 0,
      runId,
    } satisfies RunResult);
    const app = await startAppServer({ port: 0, logStartup: false });
    servers.push(trackApp(app));

    const response = await fetch(`${app.url}/api/reject/${runId}`, { method: "POST" });
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(resumeSupervisorLoop).toHaveBeenCalledOnce());
    expect((await readApprovalRecord(runDir))?.status).toBe("rejected");
  });

  it("verifies evidence and reports tampering", async () => {
    const app = await startAppServer({ port: 0, logStartup: false });
    servers.push(trackApp(app));
    await fetch(`${app.url}/api/approve/${runId}`, { method: "POST" });

    const validResponse = await fetch(`${app.url}/api/evidence/${runId}/verify`);
    expect(((await validResponse.json()) as { valid: boolean }).valid).toBe(true);

    await writeFile(join(runDir, "task.json"), JSON.stringify({ id: "tampered" }), "utf-8");
    const changedResponse = await fetch(`${app.url}/api/evidence/${runId}/verify`);
    const changed = (await changedResponse.json()) as { valid: boolean; changed: string[] };
    expect(changed.valid).toBe(false);
    expect(changed.changed).toContain("task.json");
  });
});
