import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { startAppServer } from "../cli/app.js";
import { resetConfig, setConfig } from "../config.js";
import { captureIterationDiff, createRunWorktree, discardRun } from "../workspace/worktree.js";

export type StressScenario = "all" | "http" | "worktree" | "diff";

export interface StressOptions {
  scenario: StressScenario;
  iterations: number;
  concurrency: number;
  httpRequests: number;
  httpConcurrency: number;
  httpUrl?: string;
  maxP95Ms: number;
  keepTemp: boolean;
}

export interface StressRunResult {
  passed: boolean;
  durationMs: number;
  options: StressOptions;
  checks: StressCheckResult[];
}

export interface StressCheckResult {
  name: string;
  passed: boolean;
  durationMs: number;
  details: string;
  metrics?: Record<string, number | string>;
}

export interface HttpLoadOptions {
  baseUrl: string;
  paths: string[];
  requests: number;
  concurrency: number;
  timeoutMs?: number;
}

export interface HttpSample {
  status: number;
  durationMs: number;
  failed: boolean;
}

export interface HttpLoadResult {
  total: number;
  failed: number;
  statusCounts: Record<number, number>;
  minMs: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  requestsPerSecond: number;
}

const DEFAULT_OPTIONS: StressOptions = {
  scenario: "all",
  iterations: 20,
  concurrency: 4,
  httpRequests: 100,
  httpConcurrency: 10,
  maxP95Ms: 1000,
  keepTemp: false,
};

const SCENARIOS = new Set<StressScenario>(["all", "http", "worktree", "diff"]);

export function parseStressArgs(args: string[]): StressOptions {
  const options: StressOptions = { ...DEFAULT_OPTIONS };

  for (const arg of args) {
    if (arg === "--keep-temp") {
      options.keepTemp = true;
      continue;
    }

    const [name, value] = splitOption(arg);
    switch (name) {
      case "--scenario": {
        if (!SCENARIOS.has(value as StressScenario)) {
          throw new Error(`Invalid scenario: ${value}`);
        }
        options.scenario = value as StressScenario;
        break;
      }
      case "--iterations":
        options.iterations = parsePositiveInt("iterations", value);
        break;
      case "--concurrency":
        options.concurrency = parsePositiveInt("concurrency", value);
        break;
      case "--http-requests":
      case "--requests":
        options.httpRequests = parsePositiveInt("http-requests", value);
        break;
      case "--http-concurrency":
        options.httpConcurrency = parsePositiveInt("http-concurrency", value);
        break;
      case "--http-url":
      case "--url":
        options.httpUrl = value;
        break;
      case "--max-p95-ms":
        options.maxP95Ms = parsePositiveInt("max-p95-ms", value);
        break;
      default:
        throw new Error(`Unknown stress option: ${name}`);
    }
  }

  return options;
}

export async function runStress(options: StressOptions): Promise<StressRunResult> {
  const started = performance.now();
  const checks: StressCheckResult[] = [];

  if (options.scenario === "all" || options.scenario === "http") {
    checks.push(await runCheck("app-http-load", () => runAppHttpStress(options)));
  }

  if (options.scenario === "all" || options.scenario === "worktree") {
    checks.push(await runCheck("worktree-cleanup", () => runWorktreeCleanupStress(options)));
  }

  if (options.scenario === "all" || options.scenario === "diff") {
    checks.push(await runCheck("untracked-diff", () => runUntrackedDiffStress(options)));
  }

  return {
    passed: checks.every((check) => check.passed),
    durationMs: Math.round(performance.now() - started),
    options,
    checks,
  };
}

export function formatStressReport(result: StressRunResult): string {
  const lines = [
    "",
    "Verdikt stress report",
    `Result: ${result.passed ? "passed" : "failed"} in ${result.durationMs}ms`,
    `Scenario: ${result.options.scenario}`,
    "",
  ];

  for (const check of result.checks) {
    lines.push(`${check.passed ? "PASS" : "FAIL"} ${check.name} (${check.durationMs}ms)`);
    lines.push(`  ${check.details}`);
    if (check.metrics) {
      const metrics = Object.entries(check.metrics)
        .map(([key, value]) => `${key}=${value}`)
        .join(", ");
      lines.push(`  ${metrics}`);
    }
  }

  return lines.join("\n");
}

export async function runHttpLoad(options: HttpLoadOptions): Promise<HttpLoadResult> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const samples: HttpSample[] = [];
  let next = 0;
  const started = performance.now();

  async function worker(): Promise<void> {
    while (true) {
      const index = next;
      next += 1;
      if (index >= options.requests) return;

      const path = options.paths[index % options.paths.length];
      samples.push(await fetchSample(options.baseUrl, path, timeoutMs));
    }
  }

  const workerCount = Math.min(options.concurrency, options.requests);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return summarizeHttpSamples(samples, performance.now() - started);
}

export function summarizeHttpSamples(
  samples: HttpSample[],
  totalDurationMs: number,
): HttpLoadResult {
  if (samples.length === 0) {
    return {
      total: 0,
      failed: 0,
      statusCounts: {},
      minMs: 0,
      avgMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      maxMs: 0,
      requestsPerSecond: 0,
    };
  }

  const durations = samples.map((sample) => sample.durationMs).sort((a, b) => a - b);
  const totalDuration = durations.reduce((sum, duration) => sum + duration, 0);
  const statusCounts: Record<number, number> = {};
  for (const sample of samples) {
    statusCounts[sample.status] = (statusCounts[sample.status] ?? 0) + 1;
  }

  return {
    total: samples.length,
    failed: samples.filter((sample) => sample.failed).length,
    statusCounts,
    minMs: Math.round(durations[0]),
    avgMs: Math.round(totalDuration / durations.length),
    p50Ms: Math.round(percentile(durations, 50)),
    p95Ms: Math.round(percentile(durations, 95)),
    maxMs: Math.round(durations[durations.length - 1]),
    requestsPerSecond: Number(
      (samples.length / Math.max(totalDurationMs / 1000, 0.001)).toFixed(2),
    ),
  };
}

async function runAppHttpStress(
  options: StressOptions,
): Promise<Omit<StressCheckResult, "name" | "durationMs">> {
  let tempStateDir: string | undefined;
  let app: Awaited<ReturnType<typeof startAppServer>> | undefined;

  try {
    if (!options.httpUrl) {
      tempStateDir = await mkdtemp(join(tmpdir(), "verdikt-stress-state-"));
      setConfig({ stateDir: tempStateDir });
      app = await startAppServer({ port: 0, logStartup: false, terminalRunTtlMs: 1_000 });
    }

    const result = await runHttpLoad({
      baseUrl: options.httpUrl ?? app?.url ?? "",
      paths: ["/", "/api/runs", "/api/stats", "/favicon.ico"],
      requests: options.httpRequests,
      concurrency: options.httpConcurrency,
    });
    const latencyOk = result.p95Ms <= options.maxP95Ms;

    return {
      passed: result.failed === 0 && latencyOk,
      details:
        result.failed === 0 && latencyOk
          ? `HTTP load completed with p95 ${result.p95Ms}ms`
          : `HTTP load had ${result.failed} failed responses or p95 ${result.p95Ms}ms over ${options.maxP95Ms}ms`,
      metrics: {
        requests: result.total,
        failed: result.failed,
        p50Ms: result.p50Ms,
        p95Ms: result.p95Ms,
        maxMs: result.maxMs,
        rps: result.requestsPerSecond,
      },
    };
  } finally {
    if (app) await app.close();
    if (tempStateDir) {
      resetConfig();
      if (!options.keepTemp) await rm(tempStateDir, { recursive: true, force: true });
    }
  }
}

async function runWorktreeCleanupStress(
  options: StressOptions,
): Promise<Omit<StressCheckResult, "name" | "durationMs">> {
  const root = await mkdtemp(join(tmpdir(), "verdikt-stress-worktree-"));
  let completed = 0;

  try {
    await runBounded(options.iterations, options.concurrency, async (index) => {
      const repoPath = join(root, `repo-${index}`);
      const runDir = join(root, `run-${index}`);
      const workspacePath = resolve(join(runDir, "workspace"));

      await createGitFixture(repoPath);

      let failedAsExpected = false;
      try {
        await createRunWorktree(repoPath, runDir, "bad..branch");
      } catch {
        failedAsExpected = true;
      }

      if (!failedAsExpected) {
        throw new Error("Invalid worktree branch unexpectedly succeeded");
      }
      if (existsSync(workspacePath)) {
        throw new Error(`Workspace was left behind: ${workspacePath}`);
      }

      const worktreeList = await git(repoPath, ["worktree", "list", "--porcelain"]);
      if (normalize(worktreeList).includes(normalize(workspacePath))) {
        throw new Error(`Git still lists removed workspace: ${workspacePath}`);
      }
      completed += 1;
    });

    return {
      passed: true,
      details: `${completed} failed-startup attempts left no workspace behind`,
      metrics: { iterations: completed, concurrency: options.concurrency },
    };
  } finally {
    if (!options.keepTemp) await rm(root, { recursive: true, force: true });
  }
}

async function runUntrackedDiffStress(
  options: StressOptions,
): Promise<Omit<StressCheckResult, "name" | "durationMs">> {
  const root = await mkdtemp(join(tmpdir(), "verdikt-stress-diff-"));
  let completed = 0;

  try {
    await runBounded(options.iterations, options.concurrency, async (index) => {
      const repoPath = join(root, `repo-${index}`);
      const runDir = join(root, `run-${index}`);
      await createGitFixture(repoPath);

      const worktree = await createRunWorktree(repoPath, runDir, `stress-${index}`);
      try {
        const filePath = join(worktree.worktreePath, "src", `new-risk-${index}.ts`);
        await mkdir(join(worktree.worktreePath, "src"), { recursive: true });
        await writeFile(filePath, `export const risk${index} = ${index};\n`, "utf-8");

        const diff = await captureIterationDiff(
          worktree.worktreePath,
          worktree.evidenceDir,
          index,
          worktree.baseCommit,
        );
        const patch = await readFile(diff.patchPath, "utf-8");
        const expectedFile = `src/new-risk-${index}.ts`;

        if (!diff.changedFiles.includes(expectedFile)) {
          throw new Error(`Changed files missed ${expectedFile}`);
        }
        if (!patch.includes(expectedFile)) {
          throw new Error(`Patch missed ${expectedFile}`);
        }
        completed += 1;
      } finally {
        await discardRun(repoPath, worktree.worktreePath, worktree.branchName);
      }
    });

    return {
      passed: true,
      details: `${completed} untracked-file patches were captured`,
      metrics: { iterations: completed, concurrency: options.concurrency },
    };
  } finally {
    if (!options.keepTemp) await rm(root, { recursive: true, force: true });
  }
}

async function runCheck(
  name: string,
  fn: () => Promise<Omit<StressCheckResult, "name" | "durationMs">>,
): Promise<StressCheckResult> {
  const started = performance.now();
  try {
    const result = await fn();
    return { name, durationMs: Math.round(performance.now() - started), ...result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      name,
      passed: false,
      durationMs: Math.round(performance.now() - started),
      details: message,
    };
  }
}

async function fetchSample(baseUrl: string, path: string, timeoutMs: number): Promise<HttpSample> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();

  try {
    const response = await fetch(new URL(path, baseUrl), { signal: controller.signal });
    const body = await response.arrayBuffer();
    void body;
    return {
      status: response.status,
      durationMs: performance.now() - started,
      failed: response.status < 200 || response.status >= 400,
    };
  } catch {
    return {
      status: 0,
      durationMs: performance.now() - started,
      failed: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function runBounded(
  count: number,
  concurrency: number,
  fn: (index: number) => Promise<void>,
): Promise<void> {
  let next = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = next;
      next += 1;
      if (index >= count) return;
      await fn(index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(count, concurrency) }, () => worker()));
}

async function createGitFixture(repoPath: string): Promise<void> {
  await mkdir(repoPath, { recursive: true });
  await git(repoPath, ["init"]);
  await git(repoPath, ["config", "user.name", "Verdikt Stress"]);
  await git(repoPath, ["config", "user.email", "stress@verdikt.test"]);
  await mkdir(join(repoPath, "src"), { recursive: true });
  await writeFile(join(repoPath, "src", "app.ts"), "export const value = 1;\n", "utf-8");
  await git(repoPath, ["add", "."]);
  await git(repoPath, ["commit", "--no-gpg-sign", "-m", "initial"]);
}

async function git(cwd: string, args: string[]): Promise<string> {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    execFile(
      "git",
      args,
      { cwd, encoding: "utf-8", timeout: 120_000 },
      (err: Error | null, stdout: string, stderr: string) => {
        if (err) {
          rejectPromise(new Error(`git ${args.join(" ")} failed:\n${stderr || err.message}`));
          return;
        }
        resolvePromise(stdout ?? "");
      },
    );
  });
}

function splitOption(arg: string): [string, string] {
  const equalsIndex = arg.indexOf("=");
  if (equalsIndex === -1) {
    throw new Error(`Option requires a value: ${arg}`);
  }
  return [arg.slice(0, equalsIndex), arg.slice(equalsIndex + 1)];
}

function parsePositiveInt(name: string, value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || String(parsed) !== value) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return parsed;
}

function percentile(sortedValues: number[], p: number): number {
  const index = Math.min(sortedValues.length - 1, Math.ceil((p / 100) * sortedValues.length) - 1);
  return sortedValues[index] ?? 0;
}

function normalize(value: string): string {
  return value.replace(/\\/g, "/");
}
