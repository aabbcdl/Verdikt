import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script, createContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetConfig, setConfig } from "../config.js";
import { appendRunEvent } from "../trace/events.js";
import type { TaskSpec } from "../types.js";
import { buildBrowserOpenCommand, parseAppArgs, startAppServer } from "./app.js";
import { isPathInside } from "./localServer.js";
import {
  emptyPersistedRunQueue,
  savePersistedRunQueue,
  upsertPersistedRun,
} from "./persistentQueue.js";

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

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "verdikt-app-test-"));
  stateDir = join(tempDir, ".verdikt");
  await mkdir(stateDir, { recursive: true });
  setConfig({ stateDir });
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  resetConfig();
  await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("App server", () => {
  it("parses app command options with browser auto-open enabled by default", () => {
    expect(parseAppArgs(["--port=4567"])).toEqual({
      port: 4567,
      openBrowser: true,
    });
  });

  it("can disable browser auto-open from the app command", () => {
    expect(parseAppArgs(["--port=4567", "--no-open"])).toEqual({
      port: 4567,
      openBrowser: false,
    });
    expect(parseAppArgs(["--open=false"])).toEqual({
      port: 3849,
      openBrowser: false,
    });
  });

  it("rejects unknown app options and malformed ports", () => {
    expect(() => parseAppArgs(["--unknown"])).toThrow("Unknown flag: --unknown");
    expect(() => parseAppArgs(["--port=4567oops"])).toThrow("Invalid port number");
    expect(() => parseAppArgs(["unexpected"])).toThrow("Expected at most 0 positional arguments");
  });

  it("builds platform-specific browser launch commands", () => {
    const url = "http://127.0.0.1:3849";

    expect(buildBrowserOpenCommand(url, "win32")).toEqual({
      command: "cmd",
      args: ["/c", "start", "", url],
      detached: true,
    });
    expect(buildBrowserOpenCommand(url, "darwin")).toEqual({
      command: "open",
      args: [url],
      detached: true,
    });
    expect(buildBrowserOpenCommand(url, "linux")).toEqual({
      command: "xdg-open",
      args: [url],
      detached: true,
    });
  });

  it("binds to localhost only by default", async () => {
    const app = await startAppServer({ port: 0, logStartup: false });
    servers.push(trackApp(app));

    expect(app.host).toBe("127.0.0.1");
    expect(app.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("moves to an available port when the requested port is already in use", async () => {
    const blocker = createServer();
    await new Promise<void>((resolveListen) => blocker.listen(0, "127.0.0.1", resolveListen));
    const address = blocker.address();
    const blockedPort = typeof address === "object" && address ? address.port : 0;

    try {
      const app = await startAppServer({ port: blockedPort, logStartup: false });
      servers.push(trackApp(app));

      expect(app.port).not.toBe(blockedPort);
      expect(app.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const response = await fetch(app.url);
      expect(response.status).toBe(200);
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => {
        blocker.close((err) => (err ? rejectClose(err) : resolveClose()));
      });
    }
  });

  it("serves a readable and parseable main UI over HTTP", async () => {
    const app = await startAppServer({ port: 0, logStartup: false });
    servers.push(trackApp(app));

    const response = await fetch(app.url);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Verdikt \u4efb\u52a1\u5de5\u4f5c\u53f0");
    expect(html).toContain("\u65b0\u4efb\u52a1");
    expect(html).toContain("\u5f53\u524d\u4efb\u52a1");
    expect(html).toContain("\u5386\u53f2\u8bb0\u5f55");
    expect(html).toContain("\u5f00\u59cb\u6267\u884c\u4efb\u52a1");
    expect(html).toContain("\u53ea\u505a\u4ee3\u7801\u5ba1\u67e5");
    expect(html).toContain("\u9ad8\u7ea7\u8bbe\u7f6e");
    expect(html).toContain("\u4e0b\u4e00\u8f6e\u8865\u5145\u8bf4\u660e");
    expect(html).toContain("\u672c\u6b21\u8fd0\u884c\u6301\u7eed\u5141\u8bb8");
    expect(html).not.toMatch(/[鎺閹禒嬫粍顒]/);

    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    expect(() => new Script(script ?? "", { filename: "app.html <script>" })).not.toThrow();
  });

  it("serves responsive, accessible task controls with an in-page configuration preview", async () => {
    const app = await startAppServer({ port: 0, logStartup: false });
    servers.push(trackApp(app));

    const html = await (await fetch(app.url)).text();

    expect(html).toContain('id="formErrorSummary"');
    expect(html).toContain('id="configPreview"');
    expect(html).toContain('for="workbenchSearch"');
    expect(html).toContain('for="workbenchStatus"');
    expect(html).toContain('for="workbenchSource"');
    expect(html).toContain('for="workbenchRepo"');
    expect(html).toContain("正式任务统计");
    expect(html).toContain("正式任务数");
    expect(html).toContain('<label for="maxBudget">费用停止目标 USD</label>');
    expect(html).toContain("费用数据完整时，达到目标后停止");
    expect(html).toContain("费用未知或不完整时只能提醒，实际费用可能超过目标");
    expect(html).not.toContain("预算上限 USD");
    expect(html).toContain('aria-label="验收步骤 1 名称"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-current="page"');
    expect(html).toMatch(/\.status-idle\s*\{[^}]*color:\s*#4f5b70;/);
    expect(html).not.toContain("alert('当前配置");
    expect(html).toMatch(/\.workbench-list\s*\{[^}]*max-height:\s*none;[^}]*overflow:\s*visible;/);
    expect(html).toMatch(
      /@media \(max-width: 760px\)[\s\S]*?\.run-item\s*\{[^}]*grid-template-columns:\s*1fr;/,
    );
    expect(html.replace(/\r\n/g, "\n")).toContain(
      "@media (max-width: 860px) {\n    .workbench-toolbar { grid-template-columns:1fr 1fr; }\n    .run-item { grid-template-columns:1fr; }",
    );
  });

  it("serves an incremental durable run timeline", async () => {
    const runDir = join(stateDir, "run-events");
    await mkdir(runDir, { recursive: true });
    await appendRunEvent(runDir, { type: "run_started", runId: "run-events" });
    await appendRunEvent(runDir, {
      type: "log",
      runId: "run-events",
      data: { message: "working" },
    });
    const app = await startAppServer({ port: 0, logStartup: false });
    servers.push(trackApp(app));

    const response = await fetch(`${app.url}/api/events/run-events?after=1&limit=10`);
    const body = (await response.json()) as { events: Array<{ sequence: number; type: string }> };

    expect(response.status).toBe(200);
    expect(body.events).toEqual([expect.objectContaining({ sequence: 2, type: "log" })]);
  });

  it("rejects rewind and fork requests that omit a valid iteration", async () => {
    const app = await startAppServer({ port: 0, logStartup: false });
    servers.push(trackApp(app));

    for (const path of [
      "/api/rewind/missing",
      "/api/fork/missing?iteration=0",
      "/api/fork/missing?iteration=abc",
    ]) {
      const response = await fetch(`${app.url}${path}`, { method: "POST" });
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toContain("iteration");
    }
  });

  it("rejects notes for terminal runs instead of reporting a queued next round", async () => {
    const runId = "run-terminal-note";
    const runDir = join(stateDir, runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "summary.json"),
      JSON.stringify({ runId, stopReason: "max_iterations", applyStatus: "pending" }),
      "utf-8",
    );
    const app = await startAppServer({ port: 0, logStartup: false });
    servers.push(trackApp(app));

    const response = await fetch(`${app.url}/api/note/${runId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "继续修复" }),
    });
    const body = (await response.json()) as { error?: string };

    expect(response.status).toBe(409);
    expect(body.error).toContain("already finished");
  });

  it("presents a completed review run as a review, not a failed task", async () => {
    const runDir = join(stateDir, "run-review-phase");
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "summary.json"),
      JSON.stringify({
        runId: "run-review-phase",
        taskId: "review-task",
        goal: "审查支付模块",
        repoPath: tempDir,
        stopReason: "review_completed",
        reviewOnly: true,
        reviewReport: {
          verdict: "issues_found",
          summary: "发现两个问题。",
          findings: [
            { severity: "high", title: "A", detail: "d", recommendation: "r" },
            { severity: "low", title: "B", detail: "d", recommendation: "r" },
          ],
        },
        totalIterations: 0,
        totalCostUsd: 0.2,
        totalDurationMs: 1000,
        applyStatus: "discarded",
      }),
      "utf-8",
    );
    const app = await startAppServer({ port: 0, logStartup: false });
    servers.push(trackApp(app));

    const status = (await (await fetch(`${app.url}/api/run/run-review-phase`)).json()) as {
      phase?: { phase?: string; title?: string };
    };
    expect(status.phase?.phase).toBe("review_completed");
    expect(status.phase?.title).toContain("审查完成");
    expect(status.phase?.title).toContain("2");
    expect(status.phase?.title).not.toContain("未通过");
  });

  it("filters saved runs through the shared runs API", async () => {
    const runDir = join(stateDir, "run-searchable");
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "summary.json"),
      JSON.stringify({
        runId: "run-searchable",
        taskId: "auth-refresh",
        goal: "Refresh authentication tokens",
        repoPath: tempDir,
        stopReason: "passed",
        totalIterations: 1,
        totalCostUsd: 0.1,
      }),
      "utf-8",
    );
    const app = await startAppServer({ port: 0, logStartup: false });
    servers.push(trackApp(app));

    const match = (await (await fetch(`${app.url}/api/runs?q=authentication`)).json()) as {
      saved: Array<{ runId: string }>;
    };
    const miss = (await (await fetch(`${app.url}/api/runs?q=unrelated`)).json()) as {
      saved: Array<{ runId: string }>;
    };

    expect(match.saved.map((run) => run.runId)).toContain("run-searchable");
    expect(miss.saved).toEqual([]);
  });

  it("uses the same inferred cost completeness in run lists and saved run details", async () => {
    const runDir = join(stateDir, "run-cost-consistency");
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "summary.json"),
      JSON.stringify({
        runId: "run-cost-consistency",
        taskId: "cost-consistency",
        timestamp: "2026-07-24T08:00:00.000Z",
        stopReason: "passed",
        totalIterations: 1,
        totalDurationMs: 5000,
        totalCostUsd: 0.25,
        applyStatus: "pending",
        iterations: [],
      }),
      "utf-8",
    );
    const app = await startAppServer({ port: 0, logStartup: false });
    servers.push(trackApp(app));

    const runs = (await (await fetch(`${app.url}/api/runs`)).json()) as {
      saved: Array<{ runId: string; usageStatus: string; totalCostUsd: number }>;
    };
    const detail = (await (await fetch(`${app.url}/api/run/run-cost-consistency`)).json()) as {
      result: { usageStatus: string; totalCostUsd: number };
    };
    const listItem = runs.saved.find((run) => run.runId === "run-cost-consistency");

    expect(listItem).toMatchObject({ usageStatus: "complete", totalCostUsd: 0.25 });
    expect(detail.result).toMatchObject({ usageStatus: "complete", totalCostUsd: 0.25 });
  });

  it("uses human-readable terminal phase details", async () => {
    const runId = "run-max-iterations-phase";
    const runDir = join(stateDir, runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "summary.json"),
      JSON.stringify({
        runId,
        stopReason: "max_iterations",
        totalIterations: 3,
        totalDurationMs: 1000,
        totalCostUsd: 0,
        applyStatus: "pending",
      }),
      "utf-8",
    );
    const app = await startAppServer({ port: 0, logStartup: false });
    servers.push(trackApp(app));

    const response = await fetch(`${app.url}/api/run/${runId}`);
    const body = (await response.json()) as { phase?: { detail?: string } };

    expect(response.status).toBe(200);
    expect(body.phase?.detail).toContain("达到轮数上限");
    expect(body.phase?.detail).not.toContain("max_iterations");
  });

  it("serves favicon requests without console-noisy 404s", async () => {
    const app = await startAppServer({ port: 0, logStartup: false });
    servers.push(trackApp(app));

    const response = await fetch(`${app.url}/favicon.ico`);

    expect(response.status).toBe(204);
  });

  it("prints manual-open startup guidance when browser auto-open is disabled", async () => {
    const messages: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      messages.push(String(message ?? ""));
    };

    try {
      const app = await startAppServer({
        port: 0,
        logStartup: true,
        browserAutoOpen: false,
      });
      servers.push(trackApp(app));
    } finally {
      console.log = originalLog;
    }

    expect(messages.join("\n")).toContain("Open the URL above in your browser.");
    expect(messages.join("\n")).not.toContain("Opening the browser automatically");
  });

  it("prints auto-open startup guidance when browser auto-open is enabled", async () => {
    const messages: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      messages.push(String(message ?? ""));
    };

    try {
      const app = await startAppServer({
        port: 0,
        logStartup: true,
        browserAutoOpen: true,
      });
      servers.push(trackApp(app));
    } finally {
      console.log = originalLog;
    }

    expect(messages.join("\n")).toContain("Opening the browser automatically");
    expect(messages.join("\n")).toContain("Use --no-open to disable");
  });

  it("shows validation details when starting a run fails", async () => {
    const app = await startAppServer({ port: 0, logStartup: false });
    servers.push(trackApp(app));

    const response = await fetch(app.url);
    const html = await response.text();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
    const elements = createAppElements();
    const row = {
      querySelector: (selector: string) => {
        if (selector === ".step-id") return { value: "lint" };
        if (selector === ".step-cmd") return { value: "npm" };
        if (selector === ".step-args") return { value: '["run","lint"]' };
        throw new Error(`Unexpected selector ${selector}`);
      },
    };
    const context = {
      document: {
        getElementById: (id: string) => elements[id],
        querySelectorAll: (selector: string) => (selector === ".step-row" ? [row] : []),
      },
      window: {
        clearInterval: () => undefined,
        setInterval: () => 0,
      },
      fetch: async () => ({
        ok: false,
        json: async () => ({
          error: "Task validation failed",
          details: [
            {
              field: "acceptance.steps",
              message: "At least one required acceptance step is needed.",
              fix: "Mark one step as required.",
            },
          ],
        }),
      }),
      alert: () => undefined,
      confirm: () => true,
    } as Record<string, unknown> & { startRun?: () => Promise<void> };
    const contextWindow = context.window as Record<string, unknown>;
    contextWindow.fetch = context.fetch;
    context.Headers = Headers;
    context.URL = URL;
    context.URLSearchParams = URLSearchParams;

    new Script(script, { filename: "app.html <script>" }).runInNewContext(context);

    await context.startRun?.();

    expect(elements.logOutput.textContent).toContain("Task validation failed");
    expect(elements.logOutput.textContent).toContain("acceptance.steps");
    expect(elements.logOutput.textContent).toContain("Mark one step as required.");
  });

  it("can prefill the bundled demo task from the main UI", async () => {
    const app = await startAppServer({ port: 0, logStartup: false });
    servers.push(trackApp(app));

    const response = await fetch(app.url);
    const html = await response.text();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
    const elements = createAppElements();
    elements.repoPath.value = "";
    elements.goal.value = "";
    const rows = createMutableStepRows();
    const preparedDemoPath = join(stateDir, "demo-project");
    const formListeners: Record<string, () => void> = {};
    elements.viewNew = {
      ...elements.workbenchList,
      addEventListener: (name: string, listener: () => void) => {
        formListeners[name] = listener;
      },
    } as unknown as FakeElement;
    const context = createAppContext({
      document: {
        getElementById: (id: string) => elements[id],
        querySelectorAll: (selector: string) => (selector === ".step-row" ? rows : []),
      },
      window: {
        clearInterval: () => undefined,
        setInterval: () => 0,
      },
      fetch: async (input: string) => {
        expect(input).toBe("/api/demo/reset");
        return {
          ok: true,
          json: async () => ({
            repoPath: preparedDemoPath,
            inspection: {
              ok: true,
              repoPath: preparedDemoPath,
              projectName: "demo-project",
              git: { isRepository: true, clean: true, branch: "main", dirtyFiles: [] },
              projectType: "Node.js",
              packageManager: "npm",
              recommendedSteps: [{ id: "test", command: "npm", args: ["test"], required: true }],
              summary: "ready",
              issues: [],
            },
          }),
        };
      },
    } as Record<string, unknown>);

    new Script(script, { filename: "app.html <script>" }).runInContext(context);
    await new Script("fillDemoTask();").runInContext(context);
    const task = new Script("buildTaskSpec();").runInContext(context) as TaskSpec;

    expect(task.repoPath).toBe(preparedDemoPath);
    expect(task.goal).toContain("sum");
    expect(task.acceptance.steps).toEqual([{ id: "test", command: "npm", args: ["test"] }]);
    expect(task.planning).toEqual({ mode: "off", requireApproval: false });
    expect(task.stages).toBeUndefined();
    expect(task.maxIterations).toBe(2);
    expect(task.runSource).toBe("demo");

    new Script("renderConfigPreview(buildTaskSpec());").runInContext(context);
    expect(elements.configPreviewContent.innerHTML).toContain("费用停止目标 $1.00");
    expect(elements.configPreviewContent.innerHTML).toContain(
      "费用未知或不完整时只能提醒，实际费用可能超过目标",
    );

    formListeners.input();
    const editedTask = new Script("buildTaskSpec();").runInContext(context) as TaskSpec;
    expect(editedTask.runSource).toBe("user");
  });

  it("clears a stale project error after the project check succeeds", async () => {
    const app = await startAppServer({ port: 0, logStartup: false });
    servers.push(trackApp(app));
    const html = await (await fetch(app.url)).text();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
    const elements = createAppElements();
    const blankElement = (): FakeElement => ({
      ...elements.repoPath,
      style: { width: "" },
    });
    elements.formErrorSummary = blankElement();
    elements.formErrorSummary.hidden = false;
    elements.repoPathError = blankElement();
    elements.repoPathError.hidden = false;
    elements.repoPathError.textContent = "Project check failed";
    elements.projectStatus = blankElement();
    elements.inspectProjectBtn = blankElement();
    elements.acceptanceSummary = blankElement();
    const rows = createMutableStepRows();
    const context = createAppContext({
      document: {
        getElementById: (id: string) => elements[id],
        querySelectorAll: (selector: string) => (selector === ".step-row" ? rows : []),
      },
      window: { clearInterval: () => undefined, setInterval: () => 0 },
      fetch: async () => ({
        ok: true,
        json: async () => ({
          ok: true,
          repoPath: tempDir,
          projectType: "Node.js",
          packageManager: "npm",
          git: { branch: "main" },
          recommendedSteps: [{ id: "test", command: "npm", args: ["test"] }],
          summary: "ready",
          issues: [],
        }),
      }),
    } as Record<string, unknown>);

    new Script(script, { filename: "app.html <script>" }).runInContext(context);
    await new Script("acceptanceAutoManaged = false; inspectCurrentProject(false);").runInContext(
      context,
    );

    expect(elements.formErrorSummary.hidden).toBe(true);
    expect(elements.repoPathError.hidden).toBe(true);
    expect(elements.repoPathError.textContent).toBe("");
  });

  it("shows live stalls and paginates history without silently hiding older runs", async () => {
    const app = await startAppServer({ port: 0, logStartup: false });
    servers.push(trackApp(app));

    const html = await (await fetch(app.url)).text();

    expect(html).toContain("showStall(data.stall)");
    expect(html).toContain('id="workbenchSource"');
    expect(html).toContain('id="workbenchCount"');
    expect(html).toContain('id="loadMoreBtn"');
    expect(html).toContain("function loadMoreRuns()");
    expect(html).not.toContain(".slice(0, 50)");
    expect(html.replace(/\r\n/g, "\n")).toContain(
      "} else if (data.status === 'running') {\n      hideApproval();\n      setRunningControls(true);",
    );

    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
    const elements = createAppElements();
    elements.workbenchStatus.value = "all";
    elements.workbenchSource.value = "work";
    elements.workbenchRepo.value = "";
    const context = createAppContext({
      document: {
        getElementById: (id: string) => elements[id],
        querySelectorAll: () => [],
      },
      window: { clearInterval: () => undefined, setInterval: () => 0 },
      fetch: async () => ({
        ok: true,
        json: async () => ({ live: [], saved: [], totals: {}, checks: [] }),
      }),
    } as Record<string, unknown>);
    new Script(script, { filename: "app.html <script>" }).runInContext(context);

    expect(() =>
      new Script(
        `renderWorkbench({ live: [], saved: [
          { runId: "run-source-001", taskId: "formal-task", goal: "formal history", repoPath: "repo", status: "passed", applyStatus: "pending", runSource: "user", totalCostUsd: 0, usageStatus: "complete", pinned: false, archived: false, tags: [] },
          { runId: "run-source-002", taskId: "demo-task-hidden", goal: "demo history", repoPath: "repo", status: "passed", applyStatus: "pending", runSource: "demo", totalCostUsd: 0, usageStatus: "complete", pinned: false, archived: false, tags: [] },
          { runId: "run-source-003", taskId: "archived-task-hidden", goal: "archived history", repoPath: "repo", status: "passed", applyStatus: "pending", runSource: "user", totalCostUsd: 0, usageStatus: "complete", pinned: false, archived: true, tags: [] }
        ] });`,
      ).runInContext(context),
    ).not.toThrow();
    expect(elements.workbenchList.innerHTML).toContain("普通任务");
    expect(elements.workbenchList.innerHTML).toContain("formal-task");
    expect(elements.workbenchList.innerHTML).not.toContain("demo-task-hidden");
    expect(elements.workbenchList.innerHTML).not.toContain("archived-task-hidden");
  });

  it("shows exact approval details and truthful cost states", async () => {
    const app = await startAppServer({ port: 0, logStartup: false });
    servers.push(trackApp(app));
    const html = await (await fetch(app.url)).text();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
    const elements = createAppElements();
    const context = createAppContext({
      document: {
        getElementById: (id: string) => elements[id],
        querySelectorAll: () => [],
      },
      window: { clearInterval: () => undefined, setInterval: () => 0 },
      fetch: async () => ({
        ok: true,
        json: async () => ({ live: [], saved: [], totals: {}, checks: [] }),
      }),
      alert: () => undefined,
      confirm: () => true,
    } as Record<string, unknown>);
    new Script(script, { filename: "app.html <script>" }).runInContext(context);

    new Script(`showApproval({
      categories: ['external_write'],
      reason: 'Publish package',
      action: { command: 'npm publish', tool: 'Bash', cwd: 'D:/repo' }
    });`).runInContext(context);
    const costs = new Script(`[
      formatUsageCost({ totalCostUsd: 0, usageStatus: 'unknown' }, 2),
      formatUsageCost({ totalCostUsd: 0.25, usageStatus: 'partial' }, 2),
      formatUsageCost({ totalCostUsd: 0.25, usageStatus: 'complete' }, 2)
    ]`).runInContext(context) as string[];

    expect(elements.approvalAction.hidden).toBe(false);
    expect(elements.approvalAction.textContent).toContain("npm publish");
    expect(elements.approvalAction.textContent).toContain("Bash");
    expect(costs).toEqual(["未知", "$0.25+", "$0.25"]);
  });

  it("disables the apply button after a patch is applied", async () => {
    const app = await startAppServer({ port: 0, logStartup: false });
    servers.push(trackApp(app));

    const response = await fetch(app.url);
    const html = await response.text();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
    const elements = createAppElements();
    elements.applyBtn.disabled = false;
    elements.discardBtn.disabled = false;
    const context = createAppContext({
      document: {
        getElementById: (id: string) => elements[id],
        querySelectorAll: () => [],
      },
      window: {
        clearInterval: () => undefined,
        setInterval: () => 0,
        open: () => undefined,
      },
      fetch: async () => ({
        ok: true,
        json: async () => ({ success: true, applyStatus: "applied" }),
      }),
      alert: () => undefined,
      confirm: () => true,
    } as Record<string, unknown>);

    new Script(script, { filename: "app.html <script>" }).runInContext(context);
    new Script(`currentRunId = 'run-apply-001'; currentResult = { passed: true, applyStatus: 'pending' }; currentPatchReview = {
      available: true,
      repoPath: 'D:/repo',
      files: [{ path: 'src/sum.ts', additions: 1, deletions: 1 }],
      risk: { verdict: '风险较低' },
      truncated: false
    };`).runInContext(context);

    await (context as { applyPatch?: () => Promise<void> }).applyPatch?.();

    expect(elements.applyBtn.disabled).toBe(true);
    expect(elements.discardBtn.disabled).toBe(true);
  });

  it("gates patch application on a reviewed patch and keeps terminal recovery honest", async () => {
    const app = await startAppServer({ port: 0, logStartup: false });
    servers.push(trackApp(app));
    const html = await (await fetch(app.url)).text();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
    const elements = createAppElements();
    let confirmation = "";
    const context = createAppContext({
      document: { getElementById: (id: string) => elements[id], querySelectorAll: () => [] },
      window: { clearInterval: () => undefined, setInterval: () => 0, open: () => undefined },
      fetch: async () => ({
        ok: true,
        json: async () => ({ success: true, applyStatus: "applied" }),
      }),
      alert: () => undefined,
      confirm: (message: string) => {
        confirmation = message;
        return true;
      },
    } as Record<string, unknown>);

    new Script(script, { filename: "app.html <script>" }).runInContext(context);
    new Script(
      "currentRunId = 'run-terminal'; setResultControls({ passed: true, stopReason: 'passed', applyStatus: 'pending' });",
    ).runInContext(context);
    expect(elements.applyBtn.disabled).toBe(true);

    new Script(
      "currentPatchReview = { available: true, repoPath: 'D:/repo', files: [{ path: 'src/sum.ts', additions: 1, deletions: 1 }], risk: { verdict: '风险较低' }, truncated: false }; setResultControls(currentResult);",
    ).runInContext(context);
    await new Script("applyPatch()").runInContext(context);
    expect(confirmation).toContain("项目：D:/repo");
    expect(confirmation).toContain("文件：1 个");
    expect(confirmation).toContain("风险：风险较低");
    expect(elements.applyBtn.disabled).toBe(true);

    new Script(
      "setResultControls({ passed: false, stopReason: 'max_iterations', resumable: false, applyStatus: 'pending' }); fillResult({ passed: false, stopReason: 'max_iterations', iterations: 3, totalDurationMs: 0, totalCostUsd: 0, usageStatus: 'unknown' });",
    ).runInContext(context);
    expect(elements.retryBtn.textContent).toBe("重新运行");
    expect(elements.noteBtn.disabled).toBe(true);
    expect(elements.nextIterationNote.disabled).toBe(true);
    expect(elements.resultReason.textContent).toBe("\u8fbe\u5230\u8f6e\u6570\u4e0a\u9650");
    expect(elements.currentRunTimer.textContent).not.toBe("-");
    expect(elements.stageAttempt.textContent).toBe("3 轮");
    expect(elements.heartbeatAt.textContent).toBe("已结束");

    elements.workbenchStatus.value = "all";
    elements.workbenchSource.value = "all";
    elements.workbenchRepo.value = "";
    new Script(`
      renderWorkbench({ live: [], saved: [{
        runId: 'run-max-history', taskId: 'task-without-goal', repoPath: 'repo',
        status: 'max_iterations', stopReason: 'max_iterations', runSource: 'user',
        pinned: false, archived: false, tags: []
      }] });
    `).runInContext(context);
    expect(elements.workbenchList.innerHTML).toContain("\u8fbe\u5230\u8f6e\u6570\u4e0a\u9650");
    expect(elements.workbenchList.innerHTML).not.toContain("max_iterations");
  });

  it("reveals patch details and explains when a passed run has no patch", async () => {
    const app = await startAppServer({ port: 0, logStartup: false });
    servers.push(trackApp(app));
    const html = await (await fetch(app.url)).text();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
    const elements = createAppElements();
    let patchScrolledIntoView = false;
    elements.patchSection.scrollIntoView = () => {
      patchScrolledIntoView = true;
    };
    const context = createAppContext({
      document: { getElementById: (id: string) => elements[id], querySelectorAll: () => [] },
      window: { clearInterval: () => undefined, setInterval: () => 0 },
      fetch: async (input: string) => ({
        ok: true,
        json: async () =>
          input.includes("/api/patch/")
            ? {
                available: false,
                reason: "No final patch is available for this run.",
                files: [],
              }
            : { live: [], saved: [], checks: [], totals: {} },
      }),
    } as Record<string, unknown>);

    new Script(script, { filename: "app.html <script>" }).runInContext(context);
    await new Script(`
      currentRunId = 'run-no-patch';
      setResultControls({ passed: true, stopReason: 'passed', applyStatus: 'pending' });
      openPatchReview();
    `).runInContext(context);

    expect((elements.patchDetails as FakeElement & { open: boolean }).open).toBe(true);
    expect(patchScrolledIntoView).toBe(true);
    expect(elements.patchSummary.textContent).toBe("这次运行没有生成可查看的修改。");
    expect(elements.patchReview.textContent).toBe("暂无补丁。");
    expect(elements.applyBtn.disabled).toBe(true);
  });

  it("keeps apply and discard disabled for terminal apply states", async () => {
    const app = await startAppServer({ port: 0, logStartup: false });
    servers.push(trackApp(app));

    const response = await fetch(app.url);
    const html = await response.text();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
    const elements = createAppElements();
    const context = createAppContext({
      document: {
        getElementById: (id: string) => elements[id],
        querySelectorAll: () => [],
      },
      window: {
        clearInterval: () => undefined,
        setInterval: () => 0,
      },
    } as Record<string, unknown>);

    new Script(script, { filename: "app.html <script>" }).runInContext(context);

    new Script(
      "currentRunId = 'run-applied-001'; setResultControls({ passed: true, applyStatus: 'applied' });",
    ).runInContext(context);
    expect(elements.applyBtn.disabled).toBe(true);
    expect(elements.discardBtn.disabled).toBe(true);
    expect(elements.viewBtn.disabled).toBe(false);

    new Script(
      "currentRunId = 'run-discarded-001'; setResultControls({ passed: true, applyStatus: 'discarded' });",
    ).runInContext(context);
    expect(elements.applyBtn.disabled).toBe(true);
    expect(elements.discardBtn.disabled).toBe(true);
    expect(elements.viewBtn.disabled).toBe(false);
  });

  it("keeps discard disabled while a run has no terminal result", async () => {
    const app = await startAppServer({ port: 0, logStartup: false });
    servers.push(trackApp(app));

    const response = await fetch(app.url);
    const html = await response.text();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
    const elements = createAppElements();
    const context = createAppContext({
      document: {
        getElementById: (id: string) => elements[id],
        querySelectorAll: () => [],
      },
      window: {
        clearInterval: () => undefined,
        setInterval: () => 0,
      },
    } as Record<string, unknown>);

    new Script(script, { filename: "app.html <script>" }).runInContext(context);
    new Script("currentRunId = 'run-running-001'; setResultControls(null);").runInContext(context);

    expect(elements.applyBtn.disabled).toBe(true);
    expect(elements.discardBtn.disabled).toBe(true);
    expect(elements.viewBtn.disabled).toBe(false);
  });

  it("offers continue and discard as separate actions after a resumable stop", async () => {
    const app = await startAppServer({ port: 0, logStartup: false });
    servers.push(trackApp(app));
    const html = await (await fetch(app.url)).text();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
    const elements = createAppElements();
    const context = createAppContext({
      document: { getElementById: (id: string) => elements[id], querySelectorAll: () => [] },
      window: { clearInterval: () => undefined, setInterval: () => 0 },
    } as Record<string, unknown>);

    new Script(script, { filename: "app.html <script>" }).runInContext(context);
    new Script(
      "currentRunId = 'run-stopped'; setResultControls({ passed: false, stopReason: 'cancelled', resumable: true, applyStatus: 'pending' });",
    ).runInContext(context);

    expect(elements.retryBtn.disabled).toBe(false);
    expect(elements.retryBtn.textContent).toBe("\u7ee7\u7eed\u8fd0\u884c");
    expect(elements.discardBtn.disabled).toBe(false);
  });

  it("clears the stopped result and restores running actions when a saved run resumes", async () => {
    const app = await startAppServer({ port: 0, logStartup: false });
    servers.push(trackApp(app));
    const html = await (await fetch(app.url)).text();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
    const elements = createAppElements();
    elements.resultShell.hidden = false;
    elements.runningActions.hidden = true;
    const context = createAppContext({
      document: { getElementById: (id: string) => elements[id], querySelectorAll: () => [] },
      window: { clearInterval: () => undefined, setInterval: () => 0 },
      fetch: async () => ({
        ok: true,
        json: async () => ({ runId: "run-resumed", status: "queued" }),
      }),
    } as Record<string, unknown>);

    new Script(script, { filename: "app.html <script>" }).runInContext(context);
    await new Script(`
      pollProgress = () => undefined;
      refreshWorkbench = () => undefined;
      startSavedRun('/api/resume/run-resumed');
    `).runInContext(context);

    expect(elements.resultShell.hidden).toBe(true);
    expect(elements.runningActions.hidden).toBe(false);
  });

  it("renders provider failures as a specific resumable state in results and history", async () => {
    const app = await startAppServer({ port: 0, logStartup: false });
    servers.push(trackApp(app));
    const html = await (await fetch(app.url)).text();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
    const elements = createAppElements();
    elements.workbenchStatus.value = "all";
    elements.workbenchSource.value = "work";
    elements.workbenchRepo.value = "";
    const context = createAppContext({
      document: { getElementById: (id: string) => elements[id], querySelectorAll: () => [] },
      window: { clearInterval: () => undefined, setInterval: () => 0 },
      fetch: async () => ({
        ok: true,
        json: async () => ({ live: [], saved: [], totals: {}, checks: [] }),
      }),
    } as Record<string, unknown>);

    new Script(script, { filename: "app.html <script>" }).runInContext(context);
    new Script(`
      const providerResult = {
        passed: false,
        stopReason: 'provider_error',
        resumable: true,
        applyStatus: 'pending',
        providerError: { category: 'insufficient_credit', statusCode: 402 },
        advice: { title: '\u4f59\u989d\u4e0d\u8db3', summary: '\u8865\u5145\u4f59\u989d\u540e\u53ef\u4ee5\u7ee7\u7eed', nextActions: [] }
      };
      currentRunId = 'run-provider-ui';
      renderResultSummary(providerResult);
      fillResult(providerResult);
      setResultControls(providerResult);
      renderWorkbench({ live: [], saved: [{
        runId: 'run-provider-ui', taskId: 'provider-task', goal: 'history', repoPath: 'repo',
        status: 'provider_error', stopReason: 'provider_error', resumable: true, applyStatus: 'pending',
        runSource: 'user', totalCostUsd: 0, usageStatus: 'unknown', pinned: false, archived: false,
        tags: [], advice: providerResult.advice, providerError: providerResult.providerError
      }] });
    `).runInContext(context);

    expect(elements.resultConclusion.textContent).toContain("\u4f59\u989d\u4e0d\u8db3");
    expect(elements.resultReason.textContent).toBe("\u670d\u52a1\u8bf7\u6c42\u672a\u5b8c\u6210");
    expect(elements.retryBtn.textContent).toBe("\u7ee7\u7eed\u8fd0\u884c");
    expect(elements.discardBtn.disabled).toBe(false);
    expect(elements.workbenchList.innerHTML).toContain(
      "\u670d\u52a1\u8bf7\u6c42\u672a\u5b8c\u6210",
    );
    expect(new Script("eventTypeLabel('provider_error')").runInContext(context)).toBe(
      "\u670d\u52a1\u8bf7\u6c42\u5931\u8d25",
    );
  });

  it("shows local checks separately from provider request readiness", async () => {
    const app = await startAppServer({ port: 0, logStartup: false });
    servers.push(trackApp(app));
    const html = await (await fetch(app.url)).text();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
    const elements = createAppElements();
    const context = createAppContext({
      document: { getElementById: (id: string) => elements[id], querySelectorAll: () => [] },
      window: { clearInterval: () => undefined, setInterval: () => 0 },
      fetch: async () => ({
        ok: true,
        json: async () => ({
          ok: true,
          checks: [
            { name: "Node.js", ok: true, detail: "v24", required: true, verification: "confirmed" },
            {
              name: "模型连接测试",
              ok: true,
              detail: "first request",
              required: false,
              verification: "not_checked",
            },
          ],
        }),
      }),
    } as Record<string, unknown>);

    new Script(script, { filename: "app.html <script>" }).runInContext(context);
    await new Script("loadDoctor()").runInContext(context);

    expect(elements.doctorSummary.textContent).toContain("真实连接测试");
    expect(elements.doctorList.innerHTML).toContain("等待连接测试");
  });

  it("serves run details with data paths that load in the viewer", async () => {
    const runId = "run-view-001";
    const runDir = join(stateDir, runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "summary.json"),
      JSON.stringify({
        runId,
        status: "passed",
        stopReason: "passed",
        totalIterations: 1,
        totalCostUsd: 0,
        totalDurationMs: 1,
        iterations: [],
      }),
      "utf-8",
    );
    await writeFile(join(runDir, "iterations.jsonl"), "", "utf-8");

    const app = await startAppServer({ port: 0, logStartup: false });
    servers.push(trackApp(app));

    const viewResponse = await fetch(`${app.url}/view/${runId}`);
    const viewHtml = await viewResponse.text();
    const summaryResponse = await fetch(`${app.url}/data/${runId}/summary.json`);
    const summary = (await summaryResponse.json()) as { runId: string };

    expect(viewResponse.status).toBe(200);
    expect(viewHtml).toContain(`'/data/${runId}'`);
    expect(viewHtml).toContain(`'/api/verdict/${runId}'`);
    expect(summaryResponse.status).toBe(200);
    expect(summary.runId).toBe(runId);
  });

  it("serves the canonical verdict and rejects unsupported versions", async () => {
    const runId = "run-verdict-001";
    const runDir = join(stateDir, runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "summary.json"),
      JSON.stringify({ runId, stopReason: "passed" }),
      "utf-8",
    );
    await writeFile(
      join(runDir, "verdict.json"),
      JSON.stringify({
        version: 1,
        run: {
          runId,
          stopReason: "passed",
          totalDurationMs: 10,
          usageStatus: "complete",
        },
        status: "pass",
        summary: {
          title: "可以接受这项修改",
          explanation: "全部必需条件均已通过。",
          requiredPassed: 1,
          requiredTotal: 1,
        },
        recommendation: "accept_change",
        scope: {
          status: "skipped",
          expectedPaths: [],
          changedFiles: [],
          outOfScopeFiles: [],
          filesChanged: 0,
        },
        criteria: [
          {
            id: "test",
            name: "Tests",
            required: true,
            status: "pass",
            summary: "exit 0",
            evidenceIds: ["command:test"],
          },
        ],
        integrity: {
          status: "pass",
          testsModified: false,
          acceptanceWeakened: false,
          evidenceRecorded: true,
          criticalCount: 0,
          warningCount: 0,
          findings: [],
        },
        evidence: [
          {
            id: "command:test",
            kind: "test",
            source: "verified_execution",
            assurance: "verified",
            title: "Tests",
            summary: "exit 0",
          },
        ],
        findings: [],
        provenance: {},
        createdAt: "2026-07-28T12:00:00.000Z",
      }),
      "utf-8",
    );

    const app = await startAppServer({ port: 0, logStartup: false });
    servers.push(trackApp(app));

    const response = await fetch(`${app.url}/api/verdict/${runId}`);
    const body = (await response.json()) as { version?: number; status?: string };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ version: 1, status: "pass" });

    await writeFile(
      join(runDir, "verdict.json"),
      JSON.stringify({ version: 1, status: "pass", run: { runId } }),
      "utf-8",
    );
    const invalid = await fetch(`${app.url}/api/verdict/${runId}`);
    expect(invalid.status).toBe(422);

    await writeFile(
      join(runDir, "verdict.json"),
      JSON.stringify({ version: 2, status: "pass" }),
      "utf-8",
    );
    const unsupported = await fetch(`${app.url}/api/verdict/${runId}`);
    const unsupportedBody = (await unsupported.json()) as { error?: string };

    expect(unsupported.status).toBe(422);
    expect(unsupportedBody.error).toContain("Unsupported verdict version");
  });

  it("marks saved runs without verdict.json as legacy", async () => {
    const runId = "run-legacy-verdict";
    const runDir = join(stateDir, runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "summary.json"),
      JSON.stringify({ runId, stopReason: "passed" }),
      "utf-8",
    );

    const app = await startAppServer({ port: 0, logStartup: false });
    servers.push(trackApp(app));

    const response = await fetch(`${app.url}/api/verdict/${runId}`);
    const body = (await response.json()) as { legacy?: boolean };

    expect(response.status).toBe(404);
    expect(body.legacy).toBe(true);
  });

  it("serves provider failures as actionable resumable states", async () => {
    const runId = "run-provider-error-001";
    const runDir = join(stateDir, runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "summary.json"),
      JSON.stringify({
        runId,
        stopReason: "provider_error",
        totalIterations: 0,
        totalCostUsd: 0,
        usageStatus: "unknown",
        totalDurationMs: 25,
        resumable: true,
        providerError: {
          category: "insufficient_credit",
          statusCode: 402,
          message: "Insufficient credit",
          retryable: false,
        },
        iterations: [],
      }),
      "utf-8",
    );
    await writeFile(join(runDir, "state.json"), JSON.stringify({ phase: "stopped" }), "utf-8");

    const app = await startAppServer({ port: 0, logStartup: false });
    servers.push(trackApp(app));

    const response = await fetch(`${app.url}/api/run/${runId}`);
    const body = (await response.json()) as {
      status: string;
      result?: {
        stopReason?: string;
        providerError?: { category?: string; statusCode?: number };
        advice?: { title?: string; nextActions?: string[] };
      };
    };

    expect(response.status).toBe(200);
    expect(body.status).toBe("resumable");
    expect(body.result?.providerError).toEqual(
      expect.objectContaining({ category: "insufficient_credit", statusCode: 402 }),
    );
    expect(body.result?.advice?.title).toContain("\u4f59\u989d");
    expect(body.result?.advice?.nextActions?.join("\n")).toContain("\u7ee7\u7eed\u8fd0\u884c");
  });

  it("resumes a just-stopped live run before its old cleanup timer can remove it", async () => {
    const runId = "run-resume-immediately";
    const blockerRunId = "run-active-blocker";
    const now = new Date().toISOString();
    const task: TaskSpec = {
      id: "resume-immediately",
      goal: "Continue a saved run immediately after it stops",
      repoPath: tempDir,
      acceptance: { steps: [{ id: "test", command: process.execPath, args: ["--version"] }] },
      maxIterations: 2,
    };
    let queue = emptyPersistedRunQueue();
    queue = upsertPersistedRun(queue, {
      runId: blockerRunId,
      task: { ...task, id: "active-blocker" },
      mode: "new",
      status: "running",
      queuedAt: now,
      updatedAt: now,
      heartbeatAt: now,
      ownerPid: process.pid,
    });
    queue = upsertPersistedRun(queue, {
      runId,
      task,
      mode: "new",
      status: "queued",
      queuedAt: now,
      updatedAt: now,
    });
    await savePersistedRunQueue(stateDir, queue);

    const app = await startAppServer({ port: 0, logStartup: false, terminalRunTtlMs: 200 });
    servers.push(trackApp(app));

    const cancelled = await fetch(`${app.url}/api/cancel/${runId}`, { method: "POST" });
    expect(cancelled.status).toBe(200);

    const runDir = join(stateDir, runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "state.json"),
      JSON.stringify({
        task,
        instruction: task.goal,
        nextIteration: 0,
        totalCostUsd: 0,
        totalDurationMs: 0,
        lastSavedAt: now,
        useWorktree: false,
        useIntegrity: false,
        phase: "stopped",
      }),
      "utf-8",
    );

    const archived = await fetch(`${app.url}/api/run/${runId}/metadata`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });
    expect(archived.status).toBe(200);
    const runs = (await (await fetch(`${app.url}/api/runs`)).json()) as {
      live: Array<{ runId: string; archived?: boolean }>;
    };
    expect(runs.live.find((run) => run.runId === runId)?.archived).toBe(true);

    const resumed = await fetch(`${app.url}/api/resume/${runId}`, { method: "POST" });
    const resumedBody = (await resumed.json()) as { status?: string; queuePosition?: number };
    expect(resumed.status).toBe(200);
    expect(resumedBody).toMatchObject({ status: "queued", queuePosition: 1 });

    await new Promise((resolve) => setTimeout(resolve, 300));
    const status = await fetch(`${app.url}/api/run/${runId}`);
    const statusBody = (await status.json()) as { status?: string };
    expect(status.status).toBe(200);
    expect(statusBody.status).toBe("queued");
  });

  it("returns a clear API error when a saved run summary is unreadable", async () => {
    const runId = "run-bad-summary-001";
    const runDir = join(stateDir, runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "summary.json"), "{not valid json", "utf-8");

    const app = await startAppServer({ port: 0, logStartup: false });
    servers.push(trackApp(app));

    const response = await fetch(`${app.url}/api/run/${runId}`);
    const body = (await response.json()) as { error?: string };

    expect(response.status).toBe(500);
    expect(body.error).toBe("Saved run summary is unreadable");
  });

  it("returns a conflict instead of a server error when discarding an applied run", async () => {
    const runId = "run-already-applied";
    const runDir = join(stateDir, runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "summary.json"),
      JSON.stringify({ stopReason: "passed", applyStatus: "applied" }, null, 2),
      "utf-8",
    );

    const app = await startAppServer({ port: 0, logStartup: false });
    servers.push(trackApp(app));

    const response = await fetch(`${app.url}/api/discard/${runId}`, { method: "POST" });
    const body = (await response.json()) as { error?: string };

    expect(response.status).toBe(409);
    expect(body.error).toContain("already applied");
  });

  it("serves an environment preflight API for the app onboarding panel", async () => {
    const app = await startAppServer({ port: 0, logStartup: false });
    servers.push(trackApp(app));

    const response = await fetch(`${app.url}/api/doctor`);
    const body = (await response.json()) as {
      ok: boolean;
      checks: Array<{ name: string; ok: boolean; detail: string; required: boolean }>;
    };

    expect(response.status).toBe(200);
    expect(typeof body.ok).toBe("boolean");
    expect(body.checks.map((check) => check.name)).toContain("Node.js");
    expect(body.checks.map((check) => check.name)).toContain("Git");
    expect(body.checks.every((check) => typeof check.required === "boolean")).toBe(true);
  });

  it("returns a saved task for edit-and-rerun flows", async () => {
    const runId = "run-task-edit-001";
    const runDir = join(stateDir, runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "task.json"),
      JSON.stringify({
        id: "fix-sum",
        goal: "Fix sum",
        repoPath: tempDir,
        acceptance: { steps: [{ id: "test", command: "npm", args: ["test"] }] },
        maxIterations: 5,
      }),
      "utf-8",
    );

    const app = await startAppServer({ port: 0, logStartup: false });
    servers.push(trackApp(app));

    const response = await fetch(`${app.url}/api/task/${runId}`);
    const body = (await response.json()) as { task?: TaskSpec };

    expect(response.status).toBe(200);
    expect(body.task?.goal).toBe("Fix sum");
    expect(body.task?.acceptance.steps?.[0].command).toBe("npm");
  });

  it("updates saved run metadata from the app workbench", async () => {
    const runId = "run-meta-api-001";
    const runDir = join(stateDir, runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "summary.json"),
      JSON.stringify({
        runId,
        taskId: "fix-sum",
        goal: "Fix sum",
        repoPath: tempDir,
        stopReason: "passed",
        timestamp: "2026-06-18T00:00:00.000Z",
      }),
      "utf-8",
    );

    const app = await startAppServer({ port: 0, logStartup: false });
    servers.push(trackApp(app));

    const response = await fetch(`${app.url}/api/run/${runId}/metadata`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinned: true, tags: ["important"], note: "keep" }),
    });
    const body = (await response.json()) as { metadata?: { pinned: boolean; tags: string[] } };
    const runsResponse = await fetch(`${app.url}/api/runs`);
    const runsBody = (await runsResponse.json()) as {
      saved: Array<{ runId: string; pinned: boolean; tags: string[] }>;
    };

    expect(response.status).toBe(200);
    expect(body.metadata?.pinned).toBe(true);
    expect(runsBody.saved.find((run) => run.runId === runId)?.pinned).toBe(true);
    expect(runsBody.saved.find((run) => run.runId === runId)?.tags).toEqual(["important"]);
  });

  it("serves project statistics for the dashboard strip", async () => {
    for (const { runId, stopReason, repoPath, runSource, archived = false } of [
      { runId: "run-stats-001", stopReason: "passed", repoPath: tempDir, runSource: "user" },
      {
        runId: "run-stats-002",
        stopReason: "max_iterations",
        repoPath: tempDir,
        runSource: "user",
      },
      { runId: "run-stats-demo", stopReason: "passed", repoPath: tempDir, runSource: "demo" },
      {
        runId: "run-stats-archived",
        stopReason: "passed",
        repoPath: tempDir,
        runSource: "user",
        archived: true,
      },
    ]) {
      const runDir = join(stateDir, runId);
      await mkdir(runDir, { recursive: true });
      await writeFile(
        join(runDir, "summary.json"),
        JSON.stringify({
          runId,
          taskId: runId,
          task: { id: runId, goal: runId, repoPath, runSource },
          goal: runId,
          repoPath,
          stopReason,
          totalCostUsd: 1,
          totalDurationMs: 1000,
          timestamp: `2026-06-18T00:00:0${runId.endsWith("1") ? "1" : "2"}.000Z`,
        }),
        "utf-8",
      );
      if (archived) {
        await writeFile(
          join(runDir, "metadata.json"),
          JSON.stringify({ pinned: false, archived: true, tags: [], note: "" }),
          "utf-8",
        );
      }
    }

    const app = await startAppServer({ port: 0, logStartup: false });
    servers.push(trackApp(app));

    const response = await fetch(`${app.url}/api/stats`);
    const body = (await response.json()) as {
      totals: { runs: number; passed: number; pendingPatches: number };
      projects: Array<{ repoPath: string; runs: number; passRate: number }>;
    };

    expect(response.status).toBe(200);
    expect(body.totals.runs).toBe(2);
    expect(body.totals.passed).toBe(1);
    expect(body.projects[0].repoPath).toBe(tempDir);
    expect(body.projects[0].passRate).toBe(50);
  });
});

function createAppElements(): Record<string, FakeElement> {
  const elements: Record<string, FakeElement> = {};
  const ids = [
    "repoPath",
    "goal",
    "stages",
    "maxIterations",
    "maxBudget",
    "allowTestChanges",
    "maxRisk",
    "planningMode",
    "nextIterationNote",
    "checkpointIteration",
    "steeringStatus",
    "timelineList",
    "approvalBox",
    "approvalReason",
    "approvalCategories",
    "approvalAction",
    "logOutput",
    "progressBar",
    "statusBadge",
    "globalStatus",
    "runBtn",
    "dryRunBtn",
    "stopBtn",
    "applyBtn",
    "viewBtn",
    "patchBtn",
    "retryBtn",
    "discardBtn",
    "resultIterations",
    "resultCost",
    "resultDuration",
    "resultReason",
    "currentRunTimer",
    "currentStage",
    "stageAttempt",
    "heartbeatAt",
    "resultShell",
    "runningActions",
    "resultBanner",
    "resultConclusion",
    "resultSummary",
    "reviewReport",
    "adviceBox",
    "workbenchList",
    "patchSummary",
    "patchReview",
    "patchSection",
    "patchDetails",
    "processDetails",
    "noteBtn",
    "nextIterationNote",
    "agentTimeline",
    "laneExecutor",
    "laneVerifier",
    "laneJudge",
    "phaseLabel",
    "doctorSummary",
    "doctorList",
    "workbenchSearch",
    "workbenchStatus",
    "workbenchRepo",
    "workbenchSource",
    "workbenchCount",
    "loadMoreBtn",
    "stallBox",
    "stallDetail",
    "statusHero",
    "projectStats",
    "notificationMode",
    "configPreview",
    "configPreviewContent",
  ];

  for (const id of ids) {
    elements[id] = {
      value: "",
      textContent: "",
      innerHTML: "",
      className: "",
      disabled: false,
      style: { width: "" },
      scrollTop: 0,
      scrollHeight: 0,
      hidden: false,
      focus: () => undefined,
      scrollIntoView: () => undefined,
    };
  }

  elements.repoPath.value = tempDir;
  elements.goal.value = "Fix the bug";
  elements.stages.value = "";
  elements.maxIterations.value = "5";
  elements.maxBudget.value = "5";
  elements.allowTestChanges.value = "false";
  elements.maxRisk.value = "low";

  return elements;
}

function createMutableStepRows(): Array<{
  querySelector: (selector: string) => { value: string };
}> {
  const fields: Record<string, { value: string }> = {
    ".step-id": { value: "test" },
    ".step-cmd": { value: "npm" },
    ".step-args": { value: '["test"]' },
  };
  return [
    {
      querySelector: (selector: string) => {
        const field = fields[selector];
        if (!field) throw new Error(`Unexpected selector ${selector}`);
        return field;
      },
    },
  ];
}

type FakeElement = {
  value: string;
  textContent: string;
  innerHTML?: string;
  className: string;
  disabled: boolean;
  style: { width: string };
  scrollTop: number;
  scrollHeight: number;
  hidden?: boolean;
  focus?: (...args: unknown[]) => void;
  scrollIntoView?: () => void;
};

describe("isPathInside", () => {
  it("rejects sibling paths with the same prefix", () => {
    expect(isPathInside("C:\\state", "C:\\state2\\run-001")).toBe(false);
  });

  it("accepts direct children", () => {
    expect(isPathInside("C:\\state", "C:\\state\\run-001")).toBe(true);
  });

  it("contains unexpected request errors without stopping the workbench", async () => {
    const app = await startAppServer({
      port: 0,
      logStartup: false,
      doctorChecks: async () => {
        throw new Error("doctor exploded");
      },
    });
    servers.push(trackApp(app));

    const failed = await fetch(`${app.url}/api/doctor`);
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: "doctor exploded" });

    const healthy = await fetch(app.url);
    expect(healthy.status).toBe(200);
    expect(await healthy.text()).toContain("<title>Verdikt");
  });

  it("restores durable approval waits into the workbench after restart", async () => {
    const { emptyPersistedRunQueue, savePersistedRunQueue, upsertPersistedRun } = await import(
      "./persistentQueue.js"
    );
    const task: TaskSpec = {
      id: "approval-wait",
      runSource: "demo",
      goal: "Deploy to production",
      repoPath: tempDir,
      acceptance: { steps: [{ id: "test", command: "node", args: ["--version"] }] },
      maxIterations: 2,
    };
    const state = upsertPersistedRun(emptyPersistedRunQueue(), {
      runId: "run-waiting-approval",
      task,
      mode: "resume",
      status: "waiting_approval",
      queuedAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:01:00.000Z",
      resumeRunDir: join(stateDir, "run-waiting-approval"),
      approvalRequest: { categories: ["deployment"], reason: "Needs approval" },
    });
    await savePersistedRunQueue(stateDir, state);

    const app = await startAppServer({ port: 0, logStartup: false });
    servers.push(trackApp(app));
    const response = await fetch(`${app.url}/api/runs`);
    const body = (await response.json()) as {
      live: Array<{ runId: string; status: string; runSource?: string }>;
    };

    expect(body.live).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: "run-waiting-approval",
          status: "waiting_approval",
          runSource: "demo",
        }),
      ]),
    );
  });
});

function createAppContext(overrides: Record<string, unknown>) {
  const windowOverrides =
    overrides.window && typeof overrides.window === "object"
      ? (overrides.window as Record<string, unknown>)
      : {};
  const fetchImpl =
    overrides.fetch ??
    windowOverrides.fetch ??
    (async () => {
      throw new Error("fetch should not be called in this browser context");
    });

  return createContext({
    ...overrides,
    Headers,
    URL,
    URLSearchParams,
    fetch: fetchImpl,
    window: { ...windowOverrides, fetch: fetchImpl },
  });
}
