import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import * as vscode from "vscode";

/**
 * Verdikt VS Code Extension
 *
 * Provides a sidebar view for browsing Verdikt runs and benchmarks,
 * with commands for applying/discarding patches and viewing details.
 */

export function activate(context: vscode.ExtensionContext) {
  const runsProvider = new RunsTreeProvider();
  const benchmarksProvider = new BenchmarksTreeProvider();

  vscode.window.registerTreeDataProvider("verdiktRuns", runsProvider);
  vscode.window.registerTreeDataProvider("verdiktBenchmarks", benchmarksProvider);

  context.subscriptions.push(
    vscode.commands.registerCommand("verdikt.refresh", () => {
      runsProvider.refresh();
      benchmarksProvider.refresh();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("verdikt.viewRun", (item: RunTreeItem) => {
      const runId = getItemRunId(item);
      if (runId) {
        openRunPanel(context, runId);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("verdikt.apply", async (item: RunTreeItem) => {
      const runId = getItemRunId(item);
      if (!runId) return;
      if (await tryRunAction(`/api/apply/${encodeURIComponent(runId)}`)) {
        vscode.window.showInformationMessage(`Applied Verdikt run ${runId}.`);
        runsProvider.refresh();
        return;
      }
      runInTerminal(`verdikt apply ${runId}`);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("verdikt.discard", async (item: RunTreeItem) => {
      const runId = getItemRunId(item);
      if (!runId) return;

      const confirm = await vscode.window.showWarningMessage(
        `Discard run ${runId}?`,
        "Discard",
        "Cancel",
      );
      if (confirm === "Discard") {
        if (await tryRunAction(`/api/discard/${encodeURIComponent(runId)}`)) {
          vscode.window.showInformationMessage(`Discarded Verdikt run ${runId}.`);
          runsProvider.refresh();
          return;
        }
        runInTerminal(`verdikt discard ${runId}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("verdikt.run", async () => {
      const taskFile = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: { JSON: ["json"] },
        title: "Select Task File",
      });

      if (taskFile?.[0]) {
        const terminal = vscode.window.createTerminal("Verdikt");
        terminal.sendText(`verdikt run --task "${taskFile[0].fsPath}"`);
        terminal.show();
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("verdikt.dashboard", async () => {
      const serverUrl = getServerUrl();
      try {
        await requestJson("/api/v1/capabilities");
      } catch {
        runInTerminal("verdikt app --no-open");
      }
      await vscode.env.openExternal(vscode.Uri.parse(serverUrl));
    }),
  );
}

function getStateDir(): string {
  const workspaceRoot = getWorkspaceRoot();
  const configuredStateDir = process.env.VERDIKT_STATE_DIR;
  if (configuredStateDir && configuredStateDir.trim().length > 0) {
    return path.resolve(workspaceRoot ?? process.cwd(), configuredStateDir);
  }

  if (workspaceRoot) {
    return path.join(workspaceRoot, ".verdikt");
  }

  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  return path.join(homeDir, ".verdikt");
}

function getWorkspaceRoot(): string | null {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
}

interface RunSummary {
  runId?: string;
  taskId?: string;
  stopReason?: string;
  status?: string;
  totalIterations?: number;
  totalCostUsd?: number;
  usageStatus?: "complete" | "partial" | "unknown";
  usage?: { status?: "complete" | "partial" | "unknown"; costUsd?: number };
  totalDurationMs?: number;
  timestamp?: string;
  iterations?: unknown[];
}

class RunTreeItem extends vscode.TreeItem {
  constructor(
    public readonly runId: string,
    public readonly summary: RunSummary,
  ) {
    super(runId, vscode.TreeItemCollapsibleState.None);

    const taskId = safeText(summary.taskId, "?");
    const stopReason = safeText(summary.stopReason, "?");
    this.description = `${taskId} - ${stopReason}`;
    this.tooltip = [
      `Task: ${taskId}`,
      `Status: ${stopReason}`,
      `Iterations: ${safeOptionalNumber(summary.totalIterations)}`,
      `Cost: ${formatCost(summary, 4)}`,
      `Time: ${safeText(summary.timestamp, "?")}`,
    ].join("\n");

    this.contextValue = "verdiktRun";

    if (summary.stopReason === "passed") {
      this.iconPath = new vscode.ThemeIcon("check", new vscode.ThemeColor("testing.iconPassed"));
    } else {
      this.iconPath = new vscode.ThemeIcon("close", new vscode.ThemeColor("testing.iconFailed"));
    }
  }
}

class RunsTreeProvider implements vscode.TreeDataProvider<RunTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<RunTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: RunTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<RunTreeItem[]> {
    try {
      const data = await requestJson<{ live?: unknown[]; saved?: unknown[] }>("/api/runs");
      const merged = [...(Array.isArray(data.live) ? data.live : []), ...(Array.isArray(data.saved) ? data.saved : [])];
      const seen = new Set<string>();
      return merged.flatMap((value) => {
        const item = normalizeApiRun(value);
        if (!item || seen.has(item.runId)) return [];
        seen.add(item.runId);
        return [new RunTreeItem(item.runId, item.summary)];
      });
    } catch {
      // Fall back to saved files when the local app service is not running.
    }

    const stateDir = getStateDir();
    const items: RunTreeItem[] = [];
    try {
      const entries = fs.readdirSync(stateDir).sort().reverse();

      for (const entry of entries) {
        if (!isValidRunId(entry)) continue;

        const summaryPath = path.join(stateDir, entry, "summary.json");
        if (!isPathInside(stateDir, summaryPath) || !fs.existsSync(summaryPath)) continue;

        const summary = readJsonFile<RunSummary>(summaryPath);
        if (summary) {
          items.push(new RunTreeItem(entry, summary));
        }
      }
    } catch {
      // No state directory yet.
    }

    return items;
  }
}

interface BenchmarkSummary {
  id?: string;
  tasks?: Array<{ matchedExpectation?: boolean }>;
  results?: Array<{ matchedExpectation?: boolean }>;
  metrics?: {
    avgCostUsd?: number;
    avgDurationMs?: number;
  };
}

class BenchmarkTreeItem extends vscode.TreeItem {
  constructor(
    public readonly benchId: string,
    public readonly summary: BenchmarkSummary,
  ) {
    super(benchId, vscode.TreeItemCollapsibleState.None);

    const tasks = benchmarkTasks(summary);
    const total = tasks.length;
    const passed = tasks.filter((r) => r.matchedExpectation).length;
    this.description = `${passed}/${total} passed`;
    this.contextValue = "verdiktBenchmark";
    this.iconPath = new vscode.ThemeIcon("graph");
  }
}

class BenchmarksTreeProvider implements vscode.TreeDataProvider<BenchmarkTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<BenchmarkTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: BenchmarkTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<BenchmarkTreeItem[]> {
    const stateDir = getStateDir();
    const items: BenchmarkTreeItem[] = [];

    try {
      const entries = fs.readdirSync(stateDir).sort().reverse();

      for (const entry of entries) {
        if (!isValidRunId(entry)) continue;

        const benchmarkPath = path.join(stateDir, entry, "benchmark.json");
        if (!isPathInside(stateDir, benchmarkPath) || !fs.existsSync(benchmarkPath)) continue;

        const summary = readJsonFile<BenchmarkSummary>(benchmarkPath);
        if (summary) {
          items.push(new BenchmarkTreeItem(entry, summary));
        }
      }
    } catch {
      // No state directory yet.
    }

    return items;
  }
}

function openRunPanel(_context: vscode.ExtensionContext, runId: string): void {
  if (!isValidRunId(runId)) {
    vscode.window.showErrorMessage(`Invalid run ID: ${runId}`);
    return;
  }

  const stateDir = getStateDir();
  const runDir = path.resolve(stateDir, runId);
  const summaryPath = path.join(runDir, "summary.json");

  if (!isPathInside(stateDir, summaryPath) || !fs.existsSync(summaryPath)) {
    vscode.window.showErrorMessage(`Run not found: ${runId}`);
    return;
  }

  const summary = readJsonFile<RunSummary>(summaryPath);
  if (!summary) {
    vscode.window.showErrorMessage(`Run summary is unreadable: ${runId}`);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    "verdiktRun",
    `Verdikt: ${runId}`,
    vscode.ViewColumn.One,
    { enableScripts: false },
  );

  panel.webview.html = getRunHtml(runId, summary);
}

function getRunHtml(runId: string, summary: RunSummary): string {
  const status = safeText(summary.stopReason, "unknown");
  const statusColor = status === "passed" ? "#3fb950" : "#f85149";
  const iterations = Array.isArray(summary.iterations) ? summary.iterations : [];
  const cost = formatCost(summary, 4);
  const duration = (safeNumber(summary.totalDurationMs) / 1000).toFixed(1);

  const iterRows = iterations
    .map((iter, index) => {
      const row = isRecord(iter) ? iter : {};
      const judge = isRecord(row.judge) ? row.judge : {};
      const verifier = isRecord(row.verifier) ? row.verifier : {};
      const patch = isRecord(row.patch) ? row.patch : {};
      const filesChanged = Array.isArray(patch.filesChanged) ? patch.filesChanged.length : 0;
      const problemCount = Array.isArray(verifier.problems) ? verifier.problems.length : 0;

      return `
    <tr>
      <td>${safeNumber(row.index, index) + 1}</td>
      <td>${judge.passed ? "passed" : "failed"}</td>
      <td>${verifier.done ? "done" : "open"} ${problemCount} problems</td>
      <td>${filesChanged} files</td>
      <td>${formatCost(row, 4, "costUsd")}</td>
    </tr>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html>
<head>
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 1rem; }
  h1 { font-size: 1.3rem; overflow-wrap: anywhere; }
  .status { color: ${statusColor}; font-weight: bold; }
  table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
  th, td { text-align: left; padding: 0.5rem; border-bottom: 1px solid var(--vscode-panel-border); }
  th { color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
  <h1>${escapeHtml(runId)}</h1>
  <p>Task: <strong>${escapeHtml(summary.taskId, "?")}</strong> - Status: <span class="status">${escapeHtml(status)}</span></p>
  <p>Iterations: ${iterations.length} - Cost: ${cost} - Duration: ${duration}s</p>
  <table>
    <thead><tr><th>#</th><th>Judge</th><th>Verifier</th><th>Files</th><th>Cost</th></tr></thead>
    <tbody>${iterRows}</tbody>
  </table>
</body>
</html>`;
}

function getServerUrl(): string {
  const configured = vscode.workspace.getConfiguration("verdikt").get<string>(
    "serverUrl",
    "http://127.0.0.1:3849",
  );
  return configured.replace(/\/+$/, "");
}

function requestJson<T>(route: string, method = "GET"): Promise<T> {
  const base = new URL(getServerUrl());
  if (base.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(base.hostname)) {
    return Promise.reject(new Error("Verdikt server URL must point to localhost over HTTP."));
  }
  const target = new URL(route, `${base.toString().replace(/\/+$/, "")}/`);
  return new Promise<T>((resolveRequest, reject) => {
    const request = http.request(target, { method }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        if (body.length < 2_000_000) body += chunk;
      });
      response.on("end", () => {
        try {
          const parsedValue: unknown = body ? JSON.parse(body) : {};
          if ((response.statusCode ?? 500) >= 400) {
            const error = isRecord(parsedValue) ? parsedValue.error : undefined;
            reject(new Error(safeText(error, `Verdikt service returned ${response.statusCode}`)));
            return;
          }
          resolveRequest(parsedValue as T);
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(1500, () => request.destroy(new Error("Verdikt service timed out.")));
    request.on("error", reject);
    request.end();
  });
}

async function tryRunAction(route: string): Promise<boolean> {
  try {
    const result = await requestJson<{ success?: boolean; error?: string }>(route, "POST");
    return result.success !== false;
  } catch {
    return false;
  }
}

function runInTerminal(command: string): void {
  const terminal = vscode.window.createTerminal("Verdikt");
  terminal.sendText(command);
  terminal.show();
}

function normalizeApiRun(value: unknown): { runId: string; summary: RunSummary } | null {
  if (!isRecord(value)) return null;
  const runId = safeText(value.runId, "");
  if (!isValidRunId(runId)) return null;
  const result = isRecord(value.result) ? value.result : {};
  const status = safeText(result.stopReason, safeText(value.status, "unknown"));
  const totalCostUsd = optionalNumber(result.totalCostUsd) ?? optionalNumber(value.totalCostUsd);
  const usageStatus = usageStatusOf(result) ?? usageStatusOf(value);
  return {
    runId,
    summary: {
      runId,
      taskId: safeText(value.taskId, runId),
      stopReason: status,
      status,
      totalIterations: optionalNumber(result.iterations) ?? optionalNumber(value.iterations),
      totalCostUsd,
      usageStatus,
      totalDurationMs: optionalNumber(result.totalDurationMs) ?? optionalNumber(value.totalDurationMs),
      timestamp: safeText(value.updatedAt, safeText(value.startedAt, safeText(value.queuedAt, "?"))),
    },
  };
}

function usageStatusOf(value: unknown): "complete" | "partial" | "unknown" | undefined {
  if (!isRecord(value)) return undefined;
  const usage = isRecord(value.usage) ? value.usage : null;
  const status = usage?.status ?? value.usageStatus;
  return status === "complete" || status === "partial" || status === "unknown" ? status : undefined;
}

function formatCost(value: unknown, digits = 4, field = "totalCostUsd"): string {
  if (!isRecord(value)) return "unknown";
  const status = usageStatusOf(value) ?? (optionalNumber(value[field]) !== undefined ? "complete" : "unknown");
  const amount = optionalNumber(value[field]);
  if (status === "unknown" || amount === undefined) return "unknown";
  const formatted = `$${amount.toFixed(digits)}`;
  return status === "partial" ? `${formatted}+` : formatted;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function getItemRunId(item: RunTreeItem | undefined): string | null {
  if (!item?.runId || !isValidRunId(item.runId)) {
    return null;
  }
  return item.runId;
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

function benchmarkTasks(summary: BenchmarkSummary): Array<{ matchedExpectation?: boolean }> {
  if (Array.isArray(summary.tasks)) return summary.tasks;
  if (Array.isArray(summary.results)) return summary.results;
  return [];
}

function isValidRunId(runId: string): boolean {
  return /^[a-zA-Z0-9\-_]{1,64}$/.test(runId);
}

function isPathInside(basePath: string, targetPath: string): boolean {
  const normalBase = path.resolve(basePath);
  const normalTarget = path.resolve(targetPath);
  const relativePath = path.relative(normalBase, normalTarget);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function safeText(value: unknown, fallback = "-"): string {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}

function safeNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function safeOptionalNumber(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "?";
}

function escapeHtml(value: unknown, fallback = "-"): string {
  return safeText(value, fallback)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deactivate() {}
