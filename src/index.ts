#!/usr/bin/env node
/**
 * Verdikt CLI — entry point.
 *
 * Usage:
 *   verdikt run --task <task-file>
 *   verdikt doctor
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import type { ExecException } from "node:child_process";
import { runSupervisorLoop } from "./loop/supervisor.js";
import type { TaskSpec } from "./types.js";

const USAGE = `
Verdikt — Autonomous Iterative Coder

Usage:
  verdikt run --task <task-file> [options]  Run an autonomous loop
  verdikt run --tasks <directory> [options] Run multiple tasks from directory
  verdikt benchmark --suite <file>          Run a benchmark suite
  verdikt list                              List past runs and benchmarks
  verdikt view <run-id>                     Open run detail UI
  verdikt init [id] [repo-path]             Create a task spec template
  verdikt apply <run-id>                    Apply a passed run's patch
  verdikt discard <run-id>                  Discard a run's worktree
  verdikt compare <run1> <run2>             Compare two runs
  verdikt resume <run-id>                   Resume an interrupted run
  verdikt dashboard                         Open web dashboard
  verdikt analyze                           Analyze runs for improvement
  verdikt doctor                            Check environment health
  verdikt --help                            Show this help

Options (run):
  --no-worktree    Skip git worktree isolation
  --no-integrity   Skip anti-cheating checks
  --auto-apply     Auto-apply patch on pass
  --verbose        Enable debug logging
  --json           Machine-readable JSON output (for CI)
  --dry-run        Show task config without executing

Examples:
  verdikt init my-task ./my-repo
  verdikt run --task my-task.task.json
  verdikt list
  verdikt view run-20260604-160148-cn5f
  verdikt apply run-20260604-160148-cn5f
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    process.exit(0);
  }

  const command = args[0];

  switch (command) {
    case "run":
      await handleRun(args.slice(1));
      break;
    case "view":
      await handleView(args.slice(1));
      break;
    case "benchmark":
      await handleBenchmark(args.slice(1));
      break;
    case "list":
      await handleList();
      break;
    case "init":
      await handleInit(args.slice(1));
      break;
    case "apply":
      await handleApply(args.slice(1));
      break;
    case "compare":
      await handleCompare(args.slice(1));
      break;
    case "discard":
      await handleDiscard(args.slice(1));
      break;
    case "resume":
      await handleResume(args.slice(1));
      break;
    case "doctor":
      await handleDoctor();
      break;
    case "dashboard":
      await handleDashboard();
      break;
    case "analyze":
      await handleAnalyze();
      break;
    default:
      console.error(`\n❌ Unknown command: ${command}`);
      console.log(USAGE);
      process.exit(1);
  }
}

async function handleRun(args: string[]): Promise<void> {
  // Check for batch mode: --tasks <directory>
  const tasksIdx = args.indexOf("--tasks");
  if (tasksIdx !== -1 && args[tasksIdx + 1]) {
    return handleBatchRun(args, resolve(args[tasksIdx + 1]));
  }

  const taskIdx = args.indexOf("--task");
  if (taskIdx === -1 || !args[taskIdx + 1]) {
    console.error("Error: --task <file> is required");
    console.error("Usage: verdikt run --task <task-file>");
    process.exit(1);
  }

  const taskPath = resolve(args[taskIdx + 1]);

  // Check file exists before trying to read
  if (!existsSync(taskPath)) {
    console.error(`\n❌ Task file not found: ${taskPath}`);
    const dir = resolve(taskPath, "..");
    if (existsSync(dir)) {
      const { readdirSync } = await import("node:fs");
      const jsonFiles = readdirSync(dir).filter((f: string) => f.endsWith(".json"));
      if (jsonFiles.length > 0) {
        console.error(`\nAvailable JSON files in ${dir}:`);
        for (const f of jsonFiles.slice(0, 10)) {
          console.error(`  • ${f}`);
        }
      }
    }
    console.error(`\nCreate one with: verdikt init <task-id> <repo-path>`);
    process.exit(1);
  }

  let task: TaskSpec;
  try {
    const raw = readFileSync(taskPath, "utf-8");
    task = JSON.parse(raw) as TaskSpec;
  } catch (err) {
    console.error(`\n❌ Invalid JSON in task file: ${taskPath}`);
    console.error(`   ${err instanceof Error ? err.message : String(err)}`);
    console.error(`\nFix the JSON syntax, or create a fresh task: verdikt init`);
    process.exit(1);
  }

  // Resolve relative repoPath against task file location
  if (task.repoPath && !task.repoPath.startsWith("/") && !task.repoPath.match(/^[A-Z]:\\/i)) {
    const taskDir = resolve(taskPath, "..");
    task.repoPath = resolve(taskDir, task.repoPath);
  }

  // Validate task spec
  const { validateTaskSpec } = await import("./validation.js");
  const validation = validateTaskSpec(task, taskPath);

  if (validation.warnings.length > 0) {
    for (const w of validation.warnings) {
      console.warn(`⚠️  ${w.message}`);
      console.warn(`   Fix: ${w.fix}`);
    }
  }

  if (!validation.valid) {
    console.error(`\n❌ Task validation failed:\n`);
    for (const e of validation.errors) {
      console.error(`  • [${e.field}] ${e.message}`);
      console.error(`    Fix: ${e.fix}`);
    }
    console.error(`\nEdit ${taskPath} and try again.`);
    process.exit(1);
  }

  // Apply defaults
  task.maxIterations = task.maxIterations ?? 5;

  // Parse M2 options
  const skipWorktree = args.includes("--no-worktree");
  const skipIntegrity = args.includes("--no-integrity");
  const autoApply = args.includes("--auto-apply");
  const verbose = args.includes("--verbose");
  const jsonOutput = args.includes("--json");
  const dryRun = args.includes("--dry-run");

  // Enable verbose logging if requested
  if (verbose) {
    const { setConfig } = await import("./config.js");
    setConfig({ verbose: true });
  }

  // Dry-run mode: show what would happen without executing
  if (dryRun) {
    console.log(`\n🔍 DRY RUN — no Claude calls will be made\n`);
    console.log(`Task:     ${task.id}`);
    console.log(`Goal:     ${task.goal}`);
    console.log(`Repo:     ${task.repoPath}`);
    console.log(`Max iter: ${task.maxIterations ?? 5}`);
    console.log(`Budget:   ${task.maxBudgetUsd ? `$${task.maxBudgetUsd}` : "unlimited"}`);
    console.log(`Worktree: ${!skipWorktree ? "yes" : "no"}`);
    console.log(`Integrity: ${!skipIntegrity ? "yes" : "no"}`);

    if (task.acceptance.steps) {
      console.log(`\nJudge steps:`);
      for (const step of task.acceptance.steps) {
        console.log(`  • [${step.id}] ${step.command} ${(step.args ?? []).join(" ")}`);
      }
    } else {
      console.log(`\nJudge command: ${task.acceptance.testCommand}`);
    }

    if (task.integrity) {
      console.log(`\nIntegrity policy:`);
      console.log(`  allowTestChanges: ${task.integrity.allowTestChanges ?? false}`);
      console.log(`  allowConfigChanges: ${task.integrity.allowConfigChanges ?? false}`);
    }

    if (task.semantic) {
      console.log(`\nSemantic gate: maxRisk=${task.semantic.maxRisk}`);
    }

    console.log(`\n✅ Dry run complete. Task config is valid.`);
    process.exit(0);
  }

  if (!jsonOutput) {
    console.log(`\n🚀 Verdikt starting...`);
    console.log(`   Task: ${task.id}`);
    console.log(`   Goal: ${task.goal}`);
    console.log(`   Repo: ${task.repoPath}`);
    console.log(`   Max iterations: ${task.maxIterations}\n`);
  }

  const result = await runSupervisorLoop(task, { skipWorktree, skipIntegrity, autoApply, stream: !jsonOutput });

  // JSON output for CI
  if (jsonOutput) {
    const output = {
      taskId: task.id,
      goal: task.goal,
      repoPath: task.repoPath,
      passed: result.reason === "passed",
      stopReason: result.reason,
      iterations: result.iterations.length,
      totalCostUsd: result.totalCostUsd,
      totalDurationMs: result.totalDurationMs,
      runId: result.runId ?? null,
    };
    process.stdout.write(JSON.stringify(output, null, 2) + "\n");
  }

  // Exit code: 0=passed, 1=task failed, 2=budget exceeded
  if (result.reason === "passed") {
    if (!jsonOutput) console.log("✅ Task completed successfully!");
    process.exit(0);
  } else if (result.reason === "budget_exceeded") {
    if (!jsonOutput) console.log(`❌ Task stopped: ${result.reason}`);
    process.exit(2);
  } else {
    if (!jsonOutput) console.log(`⚠️  Task stopped: ${result.reason}`);
    process.exit(1);
  }
}

async function handleBatchRun(args: string[], tasksDir: string): Promise<void> {
  const { readdir: readdirFs, readFile: readFileFs } = await import("node:fs/promises");

  if (!existsSync(tasksDir)) {
    console.error(`\n❌ Tasks directory not found: ${tasksDir}`);
    process.exit(1);
  }

  const files = (await readdirFs(tasksDir))
    .filter((f) => f.endsWith(".json"))
    .sort();

  if (files.length === 0) {
    console.error(`\n❌ No .json files found in ${tasksDir}`);
    process.exit(1);
  }

  const jsonOutput = args.includes("--json");
  const skipWorktree = args.includes("--no-worktree");
  const skipIntegrity = args.includes("--no-integrity");
  const autoApply = args.includes("--auto-apply");

  if (!jsonOutput) {
    console.log(`\n📦 Batch run: ${files.length} tasks from ${tasksDir}\n`);
  }

  const results: Array<{ taskId: string; passed: boolean; reason: string; iterations: number; costUsd: number }> = [];

  for (const file of files) {
    const taskPath = resolve(tasksDir, file);
    let task: TaskSpec;
    try {
      task = JSON.parse(await readFileFs(taskPath, "utf-8")) as TaskSpec;
    } catch (err) {
      console.error(`\n⚠️  Skipping ${file}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    // Resolve relative repoPath
    if (task.repoPath && !task.repoPath.startsWith("/") && !task.repoPath.match(/^[A-Z]:\\/i)) {
      task.repoPath = resolve(tasksDir, task.repoPath);
    }

    task.maxIterations = task.maxIterations ?? 5;

    if (!jsonOutput) {
      console.log(`${"─".repeat(60)}`);
      console.log(`📋 ${task.id}: ${task.goal}`);
    }

    const result = await runSupervisorLoop(task, { skipWorktree, skipIntegrity, autoApply, stream: !jsonOutput });

    results.push({
      taskId: task.id,
      passed: result.reason === "passed",
      reason: result.reason,
      iterations: result.iterations.length,
      costUsd: result.totalCostUsd,
    });
  }

  // Summary
  const passed = results.filter((r) => r.passed).length;
  const totalCost = results.reduce((sum, r) => sum + r.costUsd, 0);

  if (jsonOutput) {
    process.stdout.write(JSON.stringify({ total: results.length, passed, failed: results.length - passed, totalCostUsd: totalCost, results }, null, 2) + "\n");
  } else {
    console.log(`\n${"═".repeat(60)}`);
    console.log(`📊 Batch Summary: ${passed}/${results.length} passed | Cost: $${totalCost.toFixed(4)}`);
    console.log(`${"═".repeat(60)}`);
    for (const r of results) {
      const icon = r.passed ? "✅" : "❌";
      console.log(`  ${icon} ${r.taskId}: ${r.reason} (${r.iterations} iter, $${r.costUsd.toFixed(4)})`);
    }
    console.log();
  }

  process.exit(passed === results.length ? 0 : 1);
}

async function handleList(): Promise<void> {
  const config = (await import("./config.js")).getConfig();
  const { readdir, stat, readFile } = await import("node:fs/promises");
  const stateDir = resolve(config.stateDir);

  let entries: string[];
  try {
    entries = await readdir(stateDir);
  } catch {
    console.log("No runs found. Run `verdikt run --task <file>` first.");
    return;
  }

  // Separate runs and benchmarks
  const runs: Array<{ id: string; time: string; status: string; task: string }> = [];
  const benchmarks: Array<{ id: string; time: string; tasks: number; status: string }> = [];

  for (const entry of entries.sort().reverse()) {
    const dir = join(stateDir, entry);
    try {
      const summaryPath = join(dir, "summary.json");
      const benchmarkPath = join(dir, "benchmark.json");

      const summaryStat = await stat(summaryPath).catch(() => null);
      const benchmarkStat = await stat(benchmarkPath).catch(() => null);

      if (summaryStat) {
        const summary = JSON.parse(await readFile(summaryPath, "utf-8"));
        runs.push({
          id: entry,
          time: summary.timestamp || "—",
          status: summary.stopReason || summary.status || "—",
          task: summary.taskId || "—",
        });
      } else if (benchmarkStat) {
        const bench = JSON.parse(await readFile(benchmarkPath, "utf-8"));
        benchmarks.push({
          id: entry,
          time: bench.completedAt || bench.startedAt || "—",
          tasks: bench.totals?.tasks || 0,
          status: bench.status || "—",
        });
      }
    } catch {
      // Skip unreadable entries
    }
  }

  if (benchmarks.length > 0) {
    console.log("\n📊 Benchmarks:");
    console.log("  ID                                    Tasks  Status      Time");
    console.log("  " + "─".repeat(70));
    for (const b of benchmarks) {
      console.log(`  ${b.id.padEnd(36)} ${String(b.tasks).padStart(4)}   ${b.status.padEnd(10)}  ${b.time}`);
    }
  }

  if (runs.length > 0) {
    console.log("\n🏃 Runs:");
    console.log("  ID                                    Task                  Status          Time");
    console.log("  " + "─".repeat(90));
    for (const r of runs.slice(0, 20)) { // Show last 20
      console.log(`  ${r.id.padEnd(36)} ${r.task.padEnd(20)}  ${r.status.padEnd(14)}  ${r.time}`);
    }
    if (runs.length > 20) {
      console.log(`  ... and ${runs.length - 20} more`);
    }
  }

  if (runs.length === 0 && benchmarks.length === 0) {
    console.log("No runs or benchmarks found. Run `verdikt run --task <file>` first.");
  }
}

async function handleInit(args: string[]): Promise<void> {
  const { writeFile: wf } = await import("node:fs/promises");

  // init --suite creates a benchmark suite template
  if (args.includes("--suite")) {
    const suite = {
      id: "my-benchmark",
      name: "My Benchmark Suite",
      description: "Describe what this benchmark measures",
      tasks: [
        {
          taskId: "task-1",
          taskFile: "tasks/task-1.task.json",
          expect: "pass" as const,
          tags: ["feature"],
        },
      ],
    };

    const filename = "benchmark.suite.json";
    await wf(filename, JSON.stringify(suite, null, 2));
    console.log(`\n✅ Benchmark suite template created: ${filename}`);
    console.log(`\nEdit the file to add your tasks and configure the suite.`);
    console.log(`Then run: verdikt benchmark --suite ${filename}`);
    return;
  }

  const id = args[0] || "my-task";
  const repoPath = args[1] || ".";

  const task = {
    id,
    goal: "Describe what the executor should accomplish",
    repoPath: resolve(repoPath),
    acceptance: {
      steps: [
        { id: "test", command: "npm", args: ["test"] },
      ],
    },
    maxIterations: 5,
    maxBudgetUsd: 10,
    integrity: {
      allowTestChanges: false,
      allowConfigChanges: false,
    },
    semantic: {
      maxRisk: "low",
    },
  };

  const filename = `${id}.task.json`;
  await wf(filename, JSON.stringify(task, null, 2));
  console.log(`\n✅ Task spec created: ${filename}`);
  console.log(`\nEdit the file to set:`);
  console.log(`  • goal      — what to accomplish`);
  console.log(`  • repoPath  — path to the target repository`);
  console.log(`  • acceptance.steps — test commands to verify success`);
  console.log(`\nThen run: verdikt run --task ${filename}`);
}

async function handleBenchmark(args: string[]): Promise<void> {
  const suiteIdx = args.indexOf("--suite");
  if (suiteIdx === -1 || !args[suiteIdx + 1]) {
    console.error("Error: --suite <file> is required");
    console.error("Usage: verdikt benchmark --suite <suite-file.json>");
    process.exit(1);
  }

  const suitePath = resolve(args[suiteIdx + 1]);

  if (!existsSync(suitePath)) {
    console.error(`\n❌ Suite file not found: ${suitePath}`);
    console.error(`\nCreate one with: verdikt init --suite`);
    console.error(`Or use an existing: benchmarks/m4-hard.json`);
    process.exit(1);
  }

  const dryRun = args.includes("--dry-run");
  const outDir = args.includes("--out") ? resolve(args[args.indexOf("--out") + 1]) : undefined;

  const { loadSuite, runBenchmark } = await import("./benchmark/runner.js");

  let suite;
  try {
    suite = loadSuite(suitePath);
  } catch (err) {
    console.error(`\n❌ Invalid suite file: ${suitePath}`);
    console.error(`   ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  console.log(`\n📊 Benchmark: ${suite.id}`);
  console.log(`   Tasks: ${suite.tasks.length}`);
  if (dryRun) console.log("   Mode: DRY RUN (no execution)");

  const result = await runBenchmark(suite, { outDir, dryRun });

  // Exit code: 0 if all matched expectations, 1 if any unexpected
  const hasUnexpected = result.totals.unexpectedFailures > 0 || result.totals.unexpectedPasses > 0;
  process.exit(hasUnexpected ? 1 : 0);
}

async function handleView(args: string[]): Promise<void> {
  const id = args[0];
  if (!id) {
    console.error("Error: run-id or benchmark-id is required");
    console.error("Usage: verdikt view <run-id|benchmark-id>");
    process.exit(1);
  }

  const config = (await import("./config.js")).getConfig();
  const itemDir = resolve(config.stateDir, id);
  const summaryPath = join(itemDir, "summary.json");
  const benchmarkPath = join(itemDir, "benchmark.json");

  const isBenchmark = existsSync(benchmarkPath);
  const isRun = existsSync(summaryPath);

  if (!isBenchmark && !isRun) {
    console.error(`\n❌ Run or benchmark not found: ${id}`);
    console.error(`\nUse "verdikt list" to see available runs and benchmarks.`);
    process.exit(1);
  }

  // Serve the UI
  const { createServer } = await import("node:http");
  const { readFile: readFileFs } = await import("node:fs/promises");
  const runUiPath = resolve(import.meta.dirname, "../apps/ui/index.html");
  const benchUiPath = resolve(import.meta.dirname, "../apps/ui/benchmark.html");
  const htmlPath = isBenchmark ? benchUiPath : runUiPath;

  const port = 3847;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = await readFileFs(htmlPath, "utf-8");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    } else if (url.pathname.startsWith("/data/")) {
      // Serve run/benchmark data files
      const filePath = resolve(itemDir, url.pathname.replace("/data/", ""));
      try {
        const content = await readFileFs(filePath, "utf-8");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(content);
      } catch {
        res.writeHead(404);
        res.end("Not found");
      }
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  server.listen(port, () => {
    const label = isBenchmark ? "Benchmark Viewer" : "Run Viewer";
    console.log(`\n🌐 Verdikt ${label}`);
    console.log(`   ${isBenchmark ? "Benchmark" : "Run"}: ${id}`);
    console.log(`   URL: http://localhost:${port}?dir=/data`);
    console.log(`\n   Press Ctrl+C to stop.\n`);
  });
}

async function handleApply(args: string[]): Promise<void> {
  const runId = args[0];
  if (!runId) {
    console.error("Error: run-id is required");
    console.error("Usage: verdikt apply <run-id>");
    process.exit(1);
  }

  const config = (await import("./config.js")).getConfig();
  const runDir = resolve(config.stateDir, runId);
  const summaryPath = join(runDir, "summary.json");
  const patchPath = join(runDir, "evidence", "final.patch");

  if (!existsSync(summaryPath)) {
    console.error(`\n❌ Run not found: ${runId}`);
    console.error(`\nUse "verdikt list" to see available runs.`);
    process.exit(1);
  }

  const summary = JSON.parse(readFileSync(summaryPath, "utf-8"));
  if (summary.stopReason !== "passed") {
    console.error(`\n❌ Cannot apply: run stopped with reason "${summary.stopReason}", not "passed".`);
    console.error(`Only passing runs can be applied. Use "verdikt view ${runId}" to see details.`);
    process.exit(1);
  }

  if (!existsSync(patchPath)) {
    console.error(`\n❌ No final patch found for run ${runId}.`);
    console.error(`This run may have used --auto-apply or --no-worktree (changes applied immediately).`);
    process.exit(1);
  }

  // Read the task to get the repo path
  const taskPath = join(runDir, "task.json");
  let repoPath: string;
  if (existsSync(taskPath)) {
    const task = JSON.parse(readFileSync(taskPath, "utf-8"));
    repoPath = task.repoPath;
  } else {
    // Fallback: try to find repoPath from the summary
    console.error("Warning: task.json not found, patch will be applied to current directory");
    repoPath = process.cwd();
  }

  const { applyFinalPatch, getFinalPatch } = await import("./workspace/worktree.js");

  // Apply the patch using git apply
  const { exec } = await import("node:child_process");
  await new Promise<void>((resolve, reject) => {
    exec(`git apply "${patchPath}"`, { cwd: repoPath }, (err, _s, stderr) => {
      if (err) {
        reject(new Error(`Failed to apply patch: ${stderr || err.message}`));
      } else {
        resolve();
      }
    });
  });

  console.log(`✅ Patch applied from run ${runId}`);
  console.log(`   Repo: ${repoPath}`);
  console.log(`   Patch: ${patchPath}`);
}

async function handleResume(args: string[]): Promise<void> {
  const runId = args[0];
  if (!runId) {
    console.error(`\n❌ Run ID is required`);
    console.error(`Usage: verdikt resume <run-id>`);
    console.error(`\nUse "verdikt list" to see available runs.`);
    process.exit(1);
  }

  const config = (await import("./config.js")).getConfig();
  const runDir = resolve(config.stateDir, runId);
  const statePath = join(runDir, "state.json");
  const summaryPath = join(runDir, "summary.json");

  if (!existsSync(statePath)) {
    if (existsSync(summaryPath)) {
      console.error(`\n❌ Run ${runId} already completed (has summary.json). Cannot resume.`);
    } else {
      console.error(`\n❌ Run ${runId} not found or has no saved state.`);
    }
    console.error(`\nUse "verdikt list" to see available runs.`);
    process.exit(1);
  }

  const jsonOutput = args.includes("--json");

  if (!jsonOutput) {
    const { loadRunState } = await import("./trace/recorder.js");
    const state = await loadRunState(runDir);
    if (state) {
      console.log(`\n🔄 Resuming run ${runId}`);
      console.log(`   Task: ${state.task.id}`);
      console.log(`   From iteration: ${state.nextIteration + 1}`);
      console.log(`   Cost so far: $${state.totalCostUsd.toFixed(4)}`);
      console.log(`   Last saved: ${state.lastSavedAt}\n`);
    }
  }

  const result = await runSupervisorLoop({} as any, { resumeFrom: runDir, stream: !jsonOutput });

  if (jsonOutput) {
    const output = {
      taskId: result.taskId,
      passed: result.reason === "passed",
      stopReason: result.reason,
      iterations: result.iterations.length,
      totalCostUsd: result.totalCostUsd,
      totalDurationMs: result.totalDurationMs,
      runId: result.runId ?? null,
    };
    process.stdout.write(JSON.stringify(output, null, 2) + "\n");
  }

  if (result.reason === "passed") {
    if (!jsonOutput) console.log("✅ Task completed successfully!");
    process.exit(0);
  } else {
    if (!jsonOutput) console.log(`⚠️  Task stopped: ${result.reason}`);
    process.exit(1);
  }
}

async function handleDiscard(args: string[]): Promise<void> {
  const runId = args[0];
  if (!runId) {
    console.error("Error: run-id is required");
    console.error("Usage: verdikt discard <run-id>");
    process.exit(1);
  }

  const config = (await import("./config.js")).getConfig();
  const runDir = resolve(config.stateDir, runId);
  const worktreePath = join(runDir, "workspace");

  if (!existsSync(runDir)) {
    console.error(`\n❌ Run not found: ${runId}`);
    console.error(`\nUse "verdikt list" to see available runs.`);
    process.exit(1);
  }

  if (existsSync(worktreePath)) {
    const { discardRun } = await import("./workspace/worktree.js");

    // Try to get repoPath from task.json
    const taskPath = join(runDir, "task.json");
    let repoPath = process.cwd();
    if (existsSync(taskPath)) {
      const task = JSON.parse(readFileSync(taskPath, "utf-8"));
      repoPath = task.repoPath;
    }

    const branchName = `verdikt/${runId}`;
    await discardRun(repoPath, worktreePath, branchName);
    console.log(`✅ Workspace discarded for run ${runId}`);
  } else {
    console.log(`No workspace found for run ${runId} (already cleaned up)`);
  }
}

async function handleCompare(args: string[]): Promise<void> {
  const run1Id = args[0];
  const run2Id = args[1];
  if (!run1Id || !run2Id) {
    console.error(`\n❌ Two run IDs are required`);
    console.error(`Usage: verdikt compare <run1> <run2>`);
    console.error(`\nUse "verdikt list" to see available runs.`);
    process.exit(1);
  }

  const config = (await import("./config.js")).getConfig();
  const { readFile: readFileFs } = await import("node:fs/promises");

  const run1Dir = resolve(config.stateDir, run1Id);
  const run2Dir = resolve(config.stateDir, run2Id);

  const run1SummaryPath = join(run1Dir, "summary.json");
  const run2SummaryPath = join(run2Dir, "summary.json");

  if (!existsSync(run1SummaryPath)) {
    console.error(`\n❌ Run not found: ${run1Id}`);
    process.exit(1);
  }
  if (!existsSync(run2SummaryPath)) {
    console.error(`\n❌ Run not found: ${run2Id}`);
    process.exit(1);
  }

  const run1 = JSON.parse(await readFileFs(run1SummaryPath, "utf-8"));
  const run2 = JSON.parse(await readFileFs(run2SummaryPath, "utf-8"));

  const pad = (s: string, n: number) => s.padEnd(n);
  const col = 22;

  console.log(`\n📊 Run Comparison\n`);
  console.log(`${"Metric".padEnd(col)} ${run1Id.slice(0, 20).padEnd(22)} ${run2Id.slice(0, 20).padEnd(22)} Delta`);
  console.log(`${"─".repeat(col)} ${"─".repeat(22)} ${"─".repeat(22)} ${"─".repeat(12)}`);

  const rows: Array<[string, string, string, string]> = [
    ["Status", run1.stopReason, run2.stopReason, run1.stopReason === run2.stopReason ? "=" : "≠"],
    ["Task", run1.taskId ?? "?", run2.taskId ?? "?", ""],
    ["Iterations", String(run1.iterations), String(run2.iterations), diffNum(run1.iterations, run2.iterations)],
    ["Cost (USD)", `$${(run1.totalCostUsd ?? 0).toFixed(4)}`, `$${(run2.totalCostUsd ?? 0).toFixed(4)}`, diffCost(run1.totalCostUsd ?? 0, run2.totalCostUsd ?? 0)],
    ["Duration", fmtDuration(run1.totalDurationMs), fmtDuration(run2.totalDurationMs), diffNum(run1.totalDurationMs, run2.totalDurationMs, "ms")],
    ["Files changed", String(run1.filesChanged ?? "?"), String(run2.filesChanged ?? "?"), ""],
  ];

  for (const [metric, v1, v2, delta] of rows) {
    console.log(`${pad(metric, col)} ${pad(v1, 22)} ${pad(v2, 22)} ${delta}`);
  }

  // Compare patches if both exist
  const patch1 = join(run1Dir, "evidence", "final.patch");
  const patch2 = join(run2Dir, "evidence", "final.patch");
  if (existsSync(patch1) && existsSync(patch2)) {
    const p1 = (await readFileFs(patch1, "utf-8")).split("\n").length;
    const p2 = (await readFileFs(patch2, "utf-8")).split("\n").length;
    console.log(`${pad("Patch lines", col)} ${pad(String(p1), 22)} ${pad(String(p2), 22)} ${diffNum(p1, p2)}`);
  }

  console.log();
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function diffNum(a: number, b: number, suffix = ""): string {
  const d = b - a;
  if (d === 0) return "=";
  const sign = d > 0 ? "+" : "";
  return `${sign}${d}${suffix}`;
}

function diffCost(a: number, b: number): string {
  const d = b - a;
  if (Math.abs(d) < 0.0001) return "=";
  const sign = d > 0 ? "+" : "";
  return `${sign}$${d.toFixed(4)}`;
}

async function handleDashboard(): Promise<void> {
  const config = (await import("./config.js")).getConfig();
  const { readdir, stat, readFile: readFileFs } = await import("node:fs/promises");
  const stateDir = resolve(config.stateDir);

  // Collect runs and benchmarks
  const runs: any[] = [];
  const benchmarks: any[] = [];

  let entries: string[];
  try {
    entries = await readdir(stateDir);
  } catch {
    entries = [];
  }

  for (const entry of entries.sort()) {
    const dir = join(stateDir, entry);
    try {
      const summaryPath = join(dir, "summary.json");
      const benchmarkPath = join(dir, "benchmark.json");

      const summaryStat = await stat(summaryPath).catch(() => null);
      const benchmarkStat = await stat(benchmarkPath).catch(() => null);

      if (summaryStat) {
        const summary = JSON.parse(await readFileFs(summaryPath, "utf-8"));
        runs.push({
          runId: entry,
          taskId: summary.taskId,
          stopReason: summary.stopReason,
          iterations: summary.totalIterations,
          totalCostUsd: summary.totalCostUsd,
          totalDurationMs: summary.totalDurationMs,
          timestamp: summary.timestamp,
        });
      }

      if (benchmarkStat) {
        const bench = JSON.parse(await readFileFs(benchmarkPath, "utf-8"));
        benchmarks.push({
          id: entry,
          tasks: bench.results?.length ?? 0,
          passed: bench.results?.filter((r: any) => r.matchedExpectation).length ?? 0,
          totalCostUsd: bench.metrics?.avgCostUsd ? bench.metrics.avgCostUsd * (bench.results?.length ?? 0) : 0,
          totalDurationMs: bench.metrics?.avgDurationMs ? bench.metrics.avgDurationMs * (bench.results?.length ?? 0) : 0,
        });
      }
    } catch {
      // Skip invalid entries
    }
  }

  // Aggregate stats
  const totalRuns = runs.length;
  const passedRuns = runs.filter((r) => r.stopReason === "passed").length;
  const totalCost = runs.reduce((sum, r) => sum + (r.totalCostUsd || 0), 0);
  const avgIterations = totalRuns > 0 ? runs.reduce((sum, r) => sum + (r.iterations || 0), 0) / totalRuns : 0;

  const dashboardData = {
    runs,
    benchmarks,
    stats: {
      totalRuns,
      totalBenchmarks: benchmarks.length,
      passRate: totalRuns > 0 ? passedRuns / totalRuns : 0,
      totalCost,
      avgIterations,
    },
  };

  // Serve dashboard
  const { createServer } = await import("node:http");
  const port = 3848;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = await readFileFs(resolve(import.meta.dirname, "../apps/ui/dashboard.html"), "utf-8");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    } else if (url.pathname === "/data/dashboard.json") {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(dashboardData));
    } else if (url.pathname.startsWith("/view/")) {
      const id = url.pathname.replace("/view/", "");
      const itemDir = join(stateDir, id);
      const isBenchmark = existsSync(join(itemDir, "benchmark.json"));
      const htmlPath = isBenchmark
        ? resolve(import.meta.dirname, "../apps/ui/benchmark.html")
        : resolve(import.meta.dirname, "../apps/ui/index.html");
      const html = await readFileFs(htmlPath, "utf-8");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    } else if (url.pathname.startsWith("/data/")) {
      const filePath = join(stateDir, url.pathname.replace("/data/", ""));
      try {
        const content = await readFileFs(filePath, "utf-8");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(content);
      } catch {
        res.writeHead(404);
        res.end("Not found");
      }
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  server.listen(port, () => {
    console.log(`\n📊 Verdikt Dashboard`);
    console.log(`   http://localhost:${port}`);
    console.log(`\n   ${totalRuns} runs · ${benchmarks.length} benchmarks · $${totalCost.toFixed(2)} total`);
    console.log(`\nPress Ctrl+C to stop.\n`);
  });
}

async function handleAnalyze(): Promise<void> {
  const config = (await import("./config.js")).getConfig();
  const { analyzeRuns } = await import("./improvement/analyzer.js");

  console.log(`\n🔍 Analyzing runs in ${config.stateDir}...\n`);

  const report = await analyzeRuns(config.stateDir);

  // Print summary
  console.log(`${"═".repeat(60)}`);
  console.log(`Improvement Report`);
  console.log(`${"═".repeat(60)}`);
  console.log(`\nTotal runs: ${report.totalRuns}`);
  console.log(`Passed: ${report.passedRuns} (${(report.passRate * 100).toFixed(0)}%)`);
  console.log(`Failed: ${report.totalRuns - report.passedRuns}`);

  // Print failure patterns
  if (report.failurePatterns.length > 0) {
    console.log(`\n${"─".repeat(60)}`);
    console.log(`Common Failure Patterns:`);
    console.log(`${"─".repeat(60)}`);
    for (const p of report.failurePatterns.slice(0, 10)) {
      const rate = (p.recoveryRate * 100).toFixed(0);
      console.log(`  ${p.pattern}: ${p.count} occurrences, ${rate}% recovery`);
    }
  }

  // Print recovery strategies
  if (report.recoveryStrategies.length > 0) {
    console.log(`\n${"─".repeat(60)}`);
    console.log(`Successful Recovery Strategies:`);
    console.log(`${"─".repeat(60)}`);
    for (const s of report.recoveryStrategies.slice(0, 5)) {
      console.log(`  Problem: ${s.problem}`);
      console.log(`  Solution: ${s.solution}`);
      console.log(`  Example: ${s.exampleRun}\n`);
    }
  }

  // Print recommendations
  if (report.recommendations.length > 0) {
    console.log(`\n${"─".repeat(60)}`);
    console.log(`Recommendations:`);
    console.log(`${"─".repeat(60)}`);
    for (const r of report.recommendations) {
      console.log(`  ${r}`);
    }
  }

  console.log();
}

async function handleDoctor(): Promise<void> {
  console.log("Verdikt Doctor — Environment Health Check\n");

  const { exec } = await import("node:child_process");
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  // Helper to run a command and check result
  async function check(name: string, cmd: string): Promise<void> {
    return new Promise<void>((resolve) => {
      exec(cmd, { encoding: "utf-8" }, (err: ExecException | null, stdout: string) => {
        if (err) {
          checks.push({ name, ok: false, detail: "not found" });
        } else {
          checks.push({ name, ok: true, detail: stdout.trim().split("\n")[0] });
        }
        resolve();
      });
    });
  }

  // Core tools
  await check("Node.js", "node --version");
  await check("Claude CLI", "claude --version");
  await check("Git", "git --version");
  await check("pnpm", "pnpm --version");

  // Git worktree support
  await check("Git worktree", "git worktree list");

  // API configuration
  const hasApiKey = !!process.env.ANTHROPIC_API_KEY;
  const baseUrl = process.env.ANTHROPIC_BASE_URL || "(default Anthropic)";
  const model = process.env.VERDIKT_MODEL || "sonnet";

  checks.push({ name: "ANTHROPIC_API_KEY", ok: hasApiKey, detail: hasApiKey ? "set" : "not set (will use OAuth/keychain)" });
  checks.push({ name: "ANTHROPIC_BASE_URL", ok: true, detail: baseUrl });
  checks.push({ name: "Model", ok: true, detail: model });

  // State directory
  const { getConfig } = await import("./config.js");
  const config = getConfig();
  checks.push({ name: "State dir", ok: true, detail: resolve(config.stateDir) });

  // Display results
  let allOk = true;
  for (const c of checks) {
    const icon = c.ok ? "✓" : "❌";
    console.log(`  ${c.name.padEnd(20)} ${c.detail} ${icon}`);
    if (!c.ok) allOk = false;
  }

  console.log(`\n${allOk ? "✅ All checks passed." : "⚠️  Some checks failed. Fix the issues above before running Verdikt."}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
