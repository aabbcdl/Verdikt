import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { deriveRunLifecycle } from "../trace/lifecycle.js";
import type { ProviderErrorSummary, RunSource, TaskSpec, UsageStatus } from "../types.js";
import { coerceUsageSummary, formatCost } from "../usage.js";
import { isPathInside, isValidRunId } from "./localServer.js";
import { type RunAdvice, type RunSummaryForAdvice, buildRunAdvice } from "./runAdvice.js";

export interface RunMetadata {
  pinned: boolean;
  archived: boolean;
  tags: string[];
  note: string;
}

export interface SavedRunListItem {
  runId: string;
  taskId: string;
  goal: string;
  repoPath: string;
  status: string;
  stopReason?: string;
  providerError?: ProviderErrorSummary;
  applyStatus: string;
  iterations: number;
  totalCostUsd: number;
  usageStatus: UsageStatus;
  totalDurationMs: number;
  timestamp: string;
  updatedAt: string;
  resumable: boolean;
  runSource: RunSource;
  nextIteration?: number;
  advice: RunAdvice;
  pinned: boolean;
  archived: boolean;
  tags: string[];
  note: string;
}

export interface RunStats {
  totals: {
    runs: number;
    passed: number;
    failed: number;
    resumable: number;
    pendingPatches: number;
    totalCostUsd: number;
    unknownCostRuns: number;
    avgDurationMs: number;
    passRate: number;
  };
  projects: Array<{
    repoPath: string;
    runs: number;
    passed: number;
    failed: number;
    pendingPatches: number;
    totalCostUsd: number;
    unknownCostRuns: number;
    avgDurationMs: number;
    passRate: number;
    latestRunAt: string;
  }>;
  stopReasons: Array<{ reason: string; count: number }>;
}

export async function listSavedRuns(stateDirInput: string): Promise<SavedRunListItem[]> {
  const stateDir = resolve(stateDirInput);
  let entries: string[];
  try {
    entries = await readdir(stateDir);
  } catch {
    return [];
  }

  const runs: SavedRunListItem[] = [];
  for (const entry of entries) {
    if (!isValidRunId(entry)) continue;
    const runDir = resolve(stateDir, entry);
    if (!isPathInside(stateDir, runDir)) continue;

    const summaryPath = join(runDir, "summary.json");
    const statePath = join(runDir, "state.json");
    if (existsSync(summaryPath)) {
      const item = await readSummaryRun(entry, summaryPath, runDir);
      if (item) runs.push(item);
      continue;
    }

    if (existsSync(statePath)) {
      const item = await readResumableRun(entry, statePath, runDir);
      if (item) runs.push(item);
    }
  }

  return runs.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

async function readSummaryRun(
  runId: string,
  summaryPath: string,
  runDir: string,
): Promise<SavedRunListItem | null> {
  try {
    const summary = JSON.parse(await readFile(summaryPath, "utf-8")) as RunSummaryForAdvice &
      Record<string, unknown>;
    const fileStat = await stat(summaryPath);
    const task = isRecord(summary.task) ? summary.task : null;
    const lifecycle = await deriveRunLifecycle(runDir);
    const state = lifecycle.state as (Record<string, unknown> & { task?: unknown }) | null;
    const stateTask = state && isRecord(state.task) ? state.task : null;
    const resumable = lifecycle.resumable;
    const summaryTimestamp = text(summary.timestamp, fileStat.mtime.toISOString());
    const updatedAt = state ? text(state.lastSavedAt, summaryTimestamp) : summaryTimestamp;
    const metadata = await readRunMetadataFromDir(runDir);
    const usageSource =
      resumable && state
        ? (state.usage ?? { status: state.usageStatus, costUsd: state.totalCostUsd })
        : (summary.usage ?? { status: summary.usageStatus, costUsd: summary.totalCostUsd });
    const usageFallback =
      resumable && state
        ? optionalNumber(state.totalCostUsd)
        : optionalNumber(summary.totalCostUsd);
    const usage = coerceUsageSummary(usageSource, usageFallback);
    const nextIteration = state
      ? number(state.nextIteration, number(summary.totalIterations, 0))
      : undefined;
    const stopReason = text(
      summary.stopReason,
      text(summary.status, resumable ? "resumable" : "unknown"),
    );
    const providerError = readProviderError(summary.providerError);
    return {
      runId,
      taskId: text(summary.taskId, text(task?.id, text(stateTask?.id, "?"))),
      goal: text(summary.goal, text(task?.goal, text(stateTask?.goal, ""))),
      repoPath: text(summary.repoPath, text(task?.repoPath, text(stateTask?.repoPath, ""))),
      status: stopReason,
      stopReason,
      providerError,
      applyStatus: text(summary.applyStatus, "pending"),
      iterations: number(
        summary.totalIterations,
        Array.isArray(summary.iterations) ? summary.iterations.length : (nextIteration ?? 0),
      ),
      totalCostUsd: usage.costUsd ?? 0,
      usageStatus: usage.status,
      totalDurationMs: state
        ? number(state.totalDurationMs, number(summary.totalDurationMs, 0))
        : number(summary.totalDurationMs, 0),
      timestamp: summaryTimestamp,
      updatedAt,
      resumable,
      runSource: inferRunSource(summary, task ?? stateTask),
      nextIteration,
      advice:
        stopReason === "provider_error"
          ? buildRunAdvice(summary)
          : resumable
            ? buildResumableAdvice(nextIteration ?? 0, usage)
            : buildRunAdvice(summary),
      ...metadata,
    };
  } catch {
    return null;
  }
}

async function readResumableRun(
  runId: string,
  statePath: string,
  runDir: string,
): Promise<SavedRunListItem | null> {
  try {
    const lifecycle = await deriveRunLifecycle(runDir);
    if (!lifecycle.resumable || !lifecycle.state) return null;
    const state = lifecycle.state as unknown as Record<string, unknown>;
    const task = isRecord(state.task) ? state.task : {};
    const updatedAt = text(state.lastSavedAt, (await stat(statePath)).mtime.toISOString());
    const nextIteration = number(state.nextIteration, 0);
    const metadata = await readRunMetadataFromDir(runDir);
    const usage = coerceUsageSummary(
      state.usage ?? { status: state.usageStatus, costUsd: state.totalCostUsd },
      optionalNumber(state.totalCostUsd),
    );
    return {
      runId,
      taskId: text(task.id, "?"),
      goal: text(task.goal, ""),
      repoPath: text(task.repoPath, ""),
      status: "resumable",
      applyStatus: "pending",
      iterations: nextIteration,
      totalCostUsd: usage.costUsd ?? 0,
      usageStatus: usage.status,
      totalDurationMs: number(state.totalDurationMs, 0),
      timestamp: updatedAt,
      updatedAt,
      resumable: true,
      runSource: inferRunSource(state, task),
      nextIteration,
      advice: buildResumableAdvice(nextIteration, usage),
      ...metadata,
    };
  } catch {
    return null;
  }
}

export async function readRunMetadata(
  stateDirInput: string,
  runId: string,
): Promise<RunMetadata | null> {
  const runDir = resolveRunDir(stateDirInput, runId);
  if (!runDir || !existsSync(runDir)) return null;
  return readRunMetadataFromDir(runDir);
}

export async function updateRunMetadata(
  stateDirInput: string,
  runId: string,
  patch: Partial<RunMetadata>,
): Promise<RunMetadata | null> {
  const runDir = resolveRunDir(stateDirInput, runId);
  if (!runDir || !existsSync(runDir)) return null;

  const current = await readRunMetadataFromDir(runDir);
  const next: RunMetadata = {
    pinned: typeof patch.pinned === "boolean" ? patch.pinned : current.pinned,
    archived: typeof patch.archived === "boolean" ? patch.archived : current.archived,
    tags: Array.isArray(patch.tags)
      ? patch.tags
          .map((tag) => String(tag).trim())
          .filter(Boolean)
          .slice(0, 12)
      : current.tags,
    note: typeof patch.note === "string" ? patch.note.slice(0, 1000) : current.note,
  };

  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "metadata.json"), JSON.stringify(next, null, 2), "utf-8");
  return next;
}

export async function archiveRun(
  stateDirInput: string,
  runId: string,
): Promise<RunMetadata | null> {
  return updateRunMetadata(stateDirInput, runId, { archived: true });
}

export async function readTaskForSavedRun(
  stateDirInput: string,
  runId: string,
): Promise<TaskSpec | null> {
  const runDir = resolveRunDir(stateDirInput, runId);
  if (!runDir || !existsSync(runDir)) return null;

  for (const fileName of ["task.json", "normalizedTask.json"]) {
    const taskPath = join(runDir, fileName);
    if (!existsSync(taskPath)) continue;
    try {
      return JSON.parse(await readFile(taskPath, "utf-8")) as TaskSpec;
    } catch {
      return null;
    }
  }

  const statePath = join(runDir, "state.json");
  if (existsSync(statePath)) {
    try {
      const state = JSON.parse(await readFile(statePath, "utf-8")) as Record<string, unknown>;
      return isRecord(state.task) ? (state.task as unknown as TaskSpec) : null;
    } catch {
      return null;
    }
  }

  const summaryPath = join(runDir, "summary.json");
  if (existsSync(summaryPath)) {
    try {
      const summary = JSON.parse(await readFile(summaryPath, "utf-8")) as Record<string, unknown>;
      return isRecord(summary.task) ? (summary.task as unknown as TaskSpec) : null;
    } catch {
      return null;
    }
  }

  return null;
}

export async function buildRunStats(stateDirInput: string): Promise<RunStats> {
  const runs = await listSavedRuns(stateDirInput);
  const visibleRuns = runs.filter(
    (run) => !run.archived && run.runSource !== "test" && run.runSource !== "benchmark",
  );
  const completedRuns = visibleRuns.filter((run) => !run.resumable);
  const passed = visibleRuns.filter((run) => run.status === "passed").length;
  const pendingPatches = visibleRuns.filter(
    (run) => run.status === "passed" && run.applyStatus === "pending",
  ).length;
  const totalCostUsd = visibleRuns.reduce((sum, run) => sum + run.totalCostUsd, 0);
  const unknownCostRuns = visibleRuns.filter((run) => run.usageStatus !== "complete").length;
  const totalDurationMs = visibleRuns.reduce((sum, run) => sum + run.totalDurationMs, 0);

  const projectMap = new Map<string, SavedRunListItem[]>();
  for (const run of visibleRuns) {
    const key = run.repoPath || "(unknown project)";
    projectMap.set(key, [...(projectMap.get(key) ?? []), run]);
  }

  const stopReasonMap = new Map<string, number>();
  for (const run of completedRuns) {
    stopReasonMap.set(run.status, (stopReasonMap.get(run.status) ?? 0) + 1);
  }

  const projects = [...projectMap.entries()]
    .map(([repoPath, projectRuns]) => {
      const projectPassed = projectRuns.filter((run) => run.status === "passed").length;
      const projectCompleted = projectRuns.filter((run) => !run.resumable).length;
      const projectDuration = projectRuns.reduce((sum, run) => sum + run.totalDurationMs, 0);
      return {
        repoPath,
        runs: projectRuns.length,
        passed: projectPassed,
        failed: projectCompleted - projectPassed,
        pendingPatches: projectRuns.filter(
          (run) => run.status === "passed" && run.applyStatus === "pending",
        ).length,
        totalCostUsd: roundMoney(projectRuns.reduce((sum, run) => sum + run.totalCostUsd, 0)),
        unknownCostRuns: projectRuns.filter((run) => run.usageStatus !== "complete").length,
        avgDurationMs: projectRuns.length ? Math.round(projectDuration / projectRuns.length) : 0,
        passRate: projectCompleted ? Math.round((projectPassed / projectCompleted) * 100) : 0,
        latestRunAt: projectRuns.reduce(
          (latest, run) => (run.updatedAt > latest ? run.updatedAt : latest),
          "",
        ),
      };
    })
    .sort((a, b) => b.latestRunAt.localeCompare(a.latestRunAt));

  return {
    totals: {
      runs: visibleRuns.length,
      passed,
      failed: completedRuns.length - passed,
      resumable: visibleRuns.filter((run) => run.resumable).length,
      pendingPatches,
      totalCostUsd: roundMoney(totalCostUsd),
      unknownCostRuns,
      avgDurationMs: visibleRuns.length ? Math.round(totalDurationMs / visibleRuns.length) : 0,
      passRate: completedRuns.length ? Math.round((passed / completedRuns.length) * 100) : 0,
    },
    projects,
    stopReasons: [...stopReasonMap.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
  };
}

function readProviderError(value: unknown): ProviderErrorSummary | undefined {
  if (!isRecord(value)) return undefined;
  const category = text(value.category, "unknown");
  if (
    ![
      "authentication",
      "insufficient_credit",
      "rate_limited",
      "service_unavailable",
      "configuration",
      "unknown",
    ].includes(category)
  ) {
    return undefined;
  }
  return {
    category: category as ProviderErrorSummary["category"],
    statusCode: optionalNumber(value.statusCode),
    message: text(value.message, "Provider request failed"),
    retryable: value.retryable === true,
  };
}

function inferRunSource(
  container: Record<string, unknown>,
  task: Record<string, unknown> | null,
): RunSource {
  // Only trust the explicit runSource field. The previous fixture-string
  // heuristic ("mock-multi-round" etc.) baked leaked test data into
  // production classification and could mislabel genuine user runs.
  const explicit = container.runSource ?? task?.runSource;
  return isRunSource(explicit) ? explicit : "unknown";
}

function isRunSource(value: unknown): value is RunSource {
  return ["user", "demo", "benchmark", "test", "unknown"].includes(String(value));
}

function buildResumableAdvice(
  nextIteration: number,
  usage: ReturnType<typeof coerceUsageSummary>,
): RunAdvice {
  return {
    kind: "warning",
    title: "运行已中断,可以继续",
    summary: "现场已保存,继续运行会从上次中断的位置开始。",
    nextActions: ["点击继续运行,从保存的现场恢复", "或先查看日志确认中断原因,再决定是否继续"],
    evidence: [
      `已完成 ${nextIteration} 轮`,
      `已花费 ${formatCost(usage, 4).replace("unknown", "未知")}`,
    ],
  };
}

async function readRunMetadataFromDir(runDir: string): Promise<RunMetadata> {
  try {
    const raw = JSON.parse(await readFile(join(runDir, "metadata.json"), "utf-8")) as Record<
      string,
      unknown
    >;
    return {
      pinned: raw.pinned === true,
      archived: raw.archived === true,
      tags: Array.isArray(raw.tags)
        ? raw.tags
            .map((tag) => String(tag).trim())
            .filter(Boolean)
            .slice(0, 12)
        : [],
      note: text(raw.note, ""),
    };
  } catch {
    return defaultMetadata();
  }
}

function defaultMetadata(): RunMetadata {
  return {
    pinned: false,
    archived: false,
    tags: [],
    note: "",
  };
}

function resolveRunDir(stateDirInput: string, runId: string): string | null {
  const stateDir = resolve(stateDirInput);
  const runDir = resolve(stateDir, runId);
  if (!isValidRunId(runId) || !isPathInside(stateDir, runDir)) return null;
  return runDir;
}

function roundMoney(value: number): number {
  return Number(value.toFixed(4));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function number(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
