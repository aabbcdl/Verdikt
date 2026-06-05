import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

/**
 * Verdikt VS Code Extension
 *
 * Provides a sidebar view for browsing Verdikt runs and benchmarks,
 * with commands for applying/discarding patches and viewing details.
 */

export function activate(context: vscode.ExtensionContext) {
  // Register tree data providers
  const runsProvider = new RunsTreeProvider();
  const benchmarksProvider = new BenchmarksTreeProvider();

  vscode.window.registerTreeDataProvider("verdiktRuns", runsProvider);
  vscode.window.registerTreeDataProvider("verdiktBenchmarks", benchmarksProvider);

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand("verdikt.refresh", () => {
      runsProvider.refresh();
      benchmarksProvider.refresh();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("verdikt.viewRun", (item: RunTreeItem) => {
      if (item.runId) {
        openRunPanel(context, item.runId);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("verdikt.apply", async (item: RunTreeItem) => {
      if (item.runId) {
        const terminal = vscode.window.createTerminal("Verdikt");
        terminal.sendText(`verdikt apply ${item.runId}`);
        terminal.show();
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("verdikt.discard", async (item: RunTreeItem) => {
      if (item.runId) {
        const confirm = await vscode.window.showWarningMessage(
          `Discard run ${item.runId}?`,
          "Discard",
          "Cancel",
        );
        if (confirm === "Discard") {
          const terminal = vscode.window.createTerminal("Verdikt");
          terminal.sendText(`verdikt discard ${item.runId}`);
          terminal.show();
        }
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
    vscode.commands.registerCommand("verdikt.dashboard", () => {
      const terminal = vscode.window.createTerminal("Verdikt");
      terminal.sendText("verdikt dashboard");
      terminal.show();
      vscode.env.openExternal(vscode.Uri.parse("http://localhost:3848"));
    }),
  );
}

function getStateDir(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  return path.join(homeDir, ".verdikt");
}

interface RunSummary {
  runId?: string;
  taskId?: string;
  stopReason?: string;
  totalIterations?: number;
  totalCostUsd?: number;
  totalDurationMs?: number;
  timestamp?: string;
}

class RunTreeItem extends vscode.TreeItem {
  constructor(
    public readonly runId: string,
    public readonly summary: RunSummary,
  ) {
    super(runId, vscode.TreeItemCollapsibleState.None);

    this.description = `${summary.taskId ?? "?"} · ${summary.stopReason ?? "?"}`;
    this.tooltip = [
      `Task: ${summary.taskId ?? "?"}`,
      `Status: ${summary.stopReason ?? "?"}`,
      `Iterations: ${summary.totalIterations ?? "?"}`,
      `Cost: $${(summary.totalCostUsd ?? 0).toFixed(4)}`,
      `Time: ${summary.timestamp ?? "?"}`,
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
    const stateDir = getStateDir();
    const items: RunTreeItem[] = [];

    try {
      const entries = fs.readdirSync(stateDir).sort().reverse();

      for (const entry of entries) {
        const summaryPath = path.join(stateDir, entry, "summary.json");
        if (!fs.existsSync(summaryPath)) continue;

        try {
          const raw = fs.readFileSync(summaryPath, "utf-8");
          const summary: RunSummary = JSON.parse(raw);
          items.push(new RunTreeItem(entry, summary));
        } catch {
          // Skip invalid entries
        }
      }
    } catch {
      // No state directory yet
    }

    return items;
  }
}

interface BenchmarkSummary {
  id?: string;
  results?: Array<{ matchedExpectation: boolean }>;
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

    const total = summary.results?.length ?? 0;
    const passed = summary.results?.filter((r) => r.matchedExpectation).length ?? 0;
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
        const benchmarkPath = path.join(stateDir, entry, "benchmark.json");
        if (!fs.existsSync(benchmarkPath)) continue;

        try {
          const raw = fs.readFileSync(benchmarkPath, "utf-8");
          const summary: BenchmarkSummary = JSON.parse(raw);
          items.push(new BenchmarkTreeItem(entry, summary));
        } catch {
          // Skip invalid entries
        }
      }
    } catch {
      // No state directory yet
    }

    return items;
  }
}

function openRunPanel(_context: vscode.ExtensionContext, runId: string): void {
  const stateDir = getStateDir();
  const summaryPath = path.join(stateDir, runId, "summary.json");

  if (!fs.existsSync(summaryPath)) {
    vscode.window.showErrorMessage(`Run not found: ${runId}`);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    "verdiktRun",
    `Verdikt: ${runId}`,
    vscode.ViewColumn.One,
    { enableScripts: true },
  );

  const raw = fs.readFileSync(summaryPath, "utf-8");
  const summary = JSON.parse(raw);

  panel.webview.html = getRunHtml(runId, summary);
}

function getRunHtml(runId: string, summary: any): string {
  const status = summary.stopReason ?? "unknown";
  const statusColor = status === "passed" ? "#3fb950" : "#f85149";
  const iterations = summary.iterations ?? [];
  const cost = (summary.totalCostUsd ?? 0).toFixed(4);
  const duration = ((summary.totalDurationMs ?? 0) / 1000).toFixed(1);

  const iterRows = iterations
    .map(
      (iter: any) => `
    <tr>
      <td>${iter.index + 1}</td>
      <td>${iter.judge?.passed ? "✅" : "❌"}</td>
      <td>${iter.verifier?.done ? "✅" : "❌"} ${iter.verifier?.problems?.length ?? 0} problems</td>
      <td>${iter.patch?.filesChanged?.length ?? 0} files</td>
      <td>$${(iter.costUsd ?? 0).toFixed(4)}</td>
    </tr>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html>
<head>
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 1rem; }
  h1 { font-size: 1.3rem; }
  .status { color: ${statusColor}; font-weight: bold; }
  table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
  th, td { text-align: left; padding: 0.5rem; border-bottom: 1px solid var(--vscode-panel-border); }
  th { color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
  <h1>${runId}</h1>
  <p>Task: <strong>${summary.taskId ?? "?"}</strong> · Status: <span class="status">${status}</span></p>
  <p>Iterations: ${iterations.length} · Cost: $${cost} · Duration: ${duration}s</p>
  <table>
    <thead><tr><th>#</th><th>Judge</th><th>Verifier</th><th>Files</th><th>Cost</th></tr></thead>
    <tbody>${iterRows}</tbody>
  </table>
</body>
</html>`;
}

export function deactivate() {}
