import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Script, createContext } from "node:vm";
import { describe, expect, it } from "vitest";

const malicious = `"><img src=x onerror="alert(1)"><script>alert(2)</script>`;

describe("2026-07-26 UX fixes", () => {
  it("keeps a single theme layer and the new UX invariants in the workbench page", async () => {
    const html = await readFile(join(process.cwd(), "apps", "ui", "app.html"), "utf-8");
    // One :root only — the dead dark-theme layer made the patch diff unreadable.
    expect(html.match(/:root \{/g)?.length).toBe(1);
    expect(html).toMatch(/\.patch-review \{[^}]*color: #c9d1d9;/s);
    expect(html).toContain("scroll-padding-top");
    expect(html).toContain('id="taskFormNotice"');
    expect(html).toContain("review_completed: '审查完成'");
    expect(html).toContain("function updatePendingIndicators(");
    expect(html).toContain("run-group-title");
    expect(html).toContain('aria-label="查看 ${itemLabel}"');
    expect(html).toContain(".lane-grid {");
    expect(html).toContain("progress-sweep");
    // Degraded "?" separators must stay gone.
    expect(html).not.toContain(" ? \\u6392\\u961f ");
    expect(html).not.toContain("agent ? \\u7b2c");
  });

  it("renders the review report on the run report page and hides patch panels", async () => {
    const { context, elements } = await loadUiScript("index.html");

    context.render?.(
      {
        status: "review_completed",
        reviewOnly: true,
        runId: "review-run",
        taskId: "review-task",
        timestamp: "2026-07-26T00:00:00.000Z",
        totalCostUsd: 0.2,
        usageStatus: "complete",
        totalDurationMs: 1000,
        applyStatus: "discarded",
        reviewReport: {
          verdict: "issues_found",
          summary: "回调存在重复扣款风险。",
          findings: [
            {
              severity: "high",
              title: "回调没有幂等键",
              detail: "重试会重复扣款。",
              file: "src/pay/webhook.ts",
              line: 42,
              recommendation: "以 orderId+eventId 去重。",
            },
          ],
        },
        iterations: [],
      },
      [],
      "/data/review-run",
      { iterationsAvailable: false },
    );

    expect(elements["review-panel"]?.hidden).toBe(false);
    expect(elements["safety-panel"]?.hidden).toBe(true);
    expect(elements["patch-panel"]?.hidden).toBe(true);
    expect(String(elements["review-report"]?.innerHTML)).toContain("回调没有幂等键");
    expect(String(elements["status-grid"]?.innerHTML)).toContain("审查完成");
    expect(String(elements["status-grid"]?.innerHTML)).toContain("发现问题");
    expect(String(elements["status-grid"]?.innerHTML)).not.toContain("review_completed");
  });
});

describe("static report pages", () => {
  it("uses the Chinese workbench language and light visual system across report pages", async () => {
    const expectations = [
      ["index.html", "Verdikt 运行报告"],
      ["dashboard.html", "Verdikt 运行仪表盘"],
      ["benchmark.html", "Verdikt Benchmark 报告"],
    ] as const;

    for (const [fileName, title] of expectations) {
      const html = await readFile(join(process.cwd(), "apps", "ui", fileName), "utf-8");
      expect(html).toContain('<html lang="zh-CN">');
      expect(html).toContain(title);
      expect(html).toContain("--bg: #f4f7fb");
      expect(html).toContain("--surface: #ffffff");
    }
  });

  it("escapes saved run summary fields before rendering run details", async () => {
    const { context, elements } = await loadUiScript("index.html");

    context.render?.(
      {
        status: "passed",
        runId: malicious,
        taskId: malicious,
        timestamp: malicious,
        totalCostUsd: 0,
        totalDurationMs: 0,
        applyStatus: malicious,
        workspace: {
          mode: malicious,
          originalRepoCleanBeforeApply: false,
        },
        integrity: {
          status: malicious,
          criticalCount: 0,
        },
        patch: {
          filesChanged: malicious,
          finalPatchPath: malicious,
        },
        iterations: [
          {
            durationMs: 0,
            costUsd: 0,
            judge: { passed: false, summary: malicious },
            verifier: { nextInstruction: malicious, problems: [malicious] },
            integrity: { status: malicious },
            patch: { filesChanged: [malicious] },
          },
        ],
      },
      [],
      malicious,
    );

    assertNoRawDangerousMarkup(elements);
  });

  it("includes a stopped partial iteration in the full run report", async () => {
    const { context, elements } = await loadUiScript("index.html");

    context.render?.(
      {
        status: "cancelled",
        stopReason: "cancelled",
        runId: "run-stopped",
        taskId: "stopped-task",
        timestamp: "2026-07-18T08:00:00.000Z",
        totalCostUsd: 0.42,
        totalDurationMs: 185_000,
        applyStatus: "pending",
        workspace: { mode: "isolated", originalRepoCleanBeforeApply: true },
        integrity: { status: "ok", criticalCount: 0 },
        patch: { filesChanged: 1 },
        iterations: [],
        partialIteration: {
          index: 0,
          executorOutput: "Fixed src/sum.ts",
          changedFiles: ["src/sum.ts"],
          judge: { passed: true, summary: "1/1 passed" },
        },
      },
      [],
      "/data/run-stopped",
    );

    expect(elements["status-grid"].innerHTML).toContain("Iterations");
    expect(elements["status-grid"].innerHTML).toContain(">1<");
    expect(elements["patch-info"].innerHTML).toContain("src/sum.ts");
    expect(elements.iterations.innerHTML).toContain("Round 1");
    expect(elements.iterations.innerHTML).toContain("1/1 passed");
  });

  it("does not claim an optional iterations file exists when it is unavailable", async () => {
    const { context, elements } = await loadUiScript("index.html");

    context.render?.(
      {
        status: "cancelled",
        stopReason: "cancelled",
        runId: "run-without-iterations-file",
        taskId: "stopped-task",
        timestamp: "2026-07-24T08:00:00.000Z",
        totalCostUsd: 0.42,
        usageStatus: "complete",
        totalDurationMs: 185_000,
        applyStatus: "discarded",
        workspace: { mode: "isolated", originalRepoCleanBeforeApply: true },
        integrity: { status: "ok", criticalCount: 0 },
        patch: { filesChanged: 0 },
        iterations: [],
      },
      [],
      "/data/run-without-iterations-file",
      { iterationsAvailable: false },
    );

    expect(elements.evidence.innerHTML).toContain("summary.json");
    expect(elements.evidence.innerHTML).not.toContain("iterations.jsonl");
  });

  it("escapes dashboard run and benchmark fields before rendering tables", async () => {
    const { context, elements } = await loadUiScript("dashboard.html");

    context.render?.({
      runs: [
        {
          runId: malicious,
          taskId: malicious,
          stopReason: malicious,
          iterations: 1,
          totalCostUsd: 0,
          totalDurationMs: 0,
          timestamp: malicious,
        },
      ],
      benchmarks: [
        {
          id: malicious,
          tasks: 1,
          passed: 0,
          totalCostUsd: 0,
          totalDurationMs: 0,
        },
      ],
      stats: {
        totalRuns: 1,
        totalBenchmarks: 1,
        passRate: 0,
        totalCost: 0,
        avgIterations: 1,
      },
    });

    assertNoRawDangerousMarkup(elements);
  });

  it("escapes benchmark result fields before rendering benchmark details", async () => {
    const { context, elements } = await loadUiScript("benchmark.html");

    context.render?.(
      {
        suiteId: malicious,
        benchmarkId: malicious,
        status: malicious,
        completedAt: malicious,
        metrics: {
          successRate: 1,
          expectedOutcomeRate: 1,
          firstTryPassRate: 1,
          multiRoundRecoveryRate: 0,
          recoverableFailureSampleCount: 1,
          recoverableFailureRecoveryRate: 1,
          avgIterations: 1,
          avgCostUsd: 0,
          avgDurationMs: 0,
          infrastructureErrorRate: 0,
        },
        totals: { tasks: 1 },
        tasks: [
          {
            taskId: malicious,
            category: malicious,
            expectedOutcome: malicious,
            actualStatus: malicious,
            matchedExpectation: false,
            iterations: 1,
            costUsd: 0,
            durationMs: 0,
            semanticRisk: malicious,
            stopReason: malicious,
            summaryPath: malicious,
          },
        ],
      },
      malicious,
    );

    assertNoRawDangerousMarkup(elements);
  });
});

async function loadUiScript(fileName: string): Promise<{
  context: UiContext;
  elements: Record<string, FakeElement>;
}> {
  const html = await readFile(join(process.cwd(), "apps", "ui", fileName), "utf-8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  expect(script).toBeTruthy();

  const elements: Record<string, FakeElement> = {};
  const context = createUiContext({
    document: {
      getElementById: (id: string) => {
        elements[id] ??= createFakeElement();
        return elements[id];
      },
    },
    window: {
      location: { search: "" },
    },
    URLSearchParams,
    fetch: async () => {
      throw new Error("fetch should not be called without a default data dir");
    },
  }) as UiContext;

  new Script(script ?? "", { filename: `${fileName} <script>` }).runInContext(context);
  return { context, elements };
}

function createFakeElement(): FakeElement {
  return {
    innerHTML: "",
    textContent: "",
  };
}

function assertNoRawDangerousMarkup(elements: Record<string, FakeElement>): void {
  const rendered = Object.values(elements)
    .map((element) => `${element.innerHTML}\n${element.textContent}`)
    .join("\n");

  expect(rendered).not.toContain("<img");
  expect(rendered).not.toContain("<script");
  expect(rendered).not.toContain("</script");
  expect(rendered).toContain("&lt;img");
  expect(rendered).toContain("&lt;script");
}

interface FakeElement {
  innerHTML: string;
  textContent: string;
}

interface UiContext {
  render?: (...args: unknown[]) => void;
}

function createUiContext(overrides: Record<string, unknown>) {
  const windowOverrides =
    overrides.window && typeof overrides.window === "object"
      ? (overrides.window as Record<string, unknown>)
      : {};
  const fetchImpl =
    overrides.fetch ??
    windowOverrides.fetch ??
    (async () => {
      throw new Error("fetch should not be called without a default data dir");
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
