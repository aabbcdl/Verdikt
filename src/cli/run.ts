/**
 * CLI handler for `verdikt run` command.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runSupervisorLoop } from "../loop/supervisor.js";
import type { TaskSpec } from "../types.js";

export async function handleRun(args: string[]): Promise<void> {
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
    console.error("\nCreate one with: verdikt init <task-id> <repo-path>");
    process.exit(1);
  }

  let task: TaskSpec;
  try {
    const raw = readFileSync(taskPath, "utf-8");
    task = JSON.parse(raw) as TaskSpec;
  } catch (err) {
    console.error(`\n❌ Invalid JSON in task file: ${taskPath}`);
    console.error(`   ${err instanceof Error ? err.message : String(err)}`);
    console.error("\nFix the JSON syntax, or create a fresh task: verdikt init");
    process.exit(1);
  }

  // Resolve relative repoPath against task file location
  if (task.repoPath && !task.repoPath.startsWith("/") && !task.repoPath.match(/^[A-Z]:\\/i)) {
    const taskDir = resolve(taskPath, "..");
    task.repoPath = resolve(taskDir, task.repoPath);
  }

  // Validate task spec
  const { validateTaskSpec } = await import("../validation.js");
  const validation = validateTaskSpec(task, taskPath);

  if (validation.warnings.length > 0) {
    for (const w of validation.warnings) {
      console.warn(`⚠️  ${w.message}`);
      console.warn(`   Fix: ${w.fix}`);
    }
  }

  if (!validation.valid) {
    console.error("\n❌ Task validation failed:\n");
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
    const { setConfig } = await import("../config.js");
    setConfig({ verbose: true });
  }

  // Dry-run mode: show what would happen without executing
  if (dryRun) {
    console.log("\n🔍 DRY RUN — no Claude calls will be made\n");
    console.log(`Task:     ${task.id}`);
    console.log(`Goal:     ${task.goal}`);
    console.log(`Repo:     ${task.repoPath}`);
    console.log(`Max iter: ${task.maxIterations ?? 5}`);
    console.log(`Budget:   ${task.maxBudgetUsd ? `$${task.maxBudgetUsd}` : "unlimited"}`);
    console.log(`Worktree: ${!skipWorktree ? "yes" : "no"}`);
    console.log(`Integrity: ${!skipIntegrity ? "yes" : "no"}`);

    if (task.acceptance.steps) {
      console.log("\nJudge steps:");
      for (const step of task.acceptance.steps) {
        console.log(`  • [${step.id}] ${step.command} ${(step.args ?? []).join(" ")}`);
      }
    } else {
      console.log(`\nJudge command: ${task.acceptance.testCommand}`);
    }

    if (task.integrity) {
      console.log("\nIntegrity policy:");
      console.log(`  allowTestChanges: ${task.integrity.allowTestChanges ?? false}`);
      console.log(`  allowConfigChanges: ${task.integrity.allowConfigChanges ?? false}`);
    }

    if (task.semantic) {
      console.log(`\nSemantic gate: maxRisk=${task.semantic.maxRisk}`);
    }

    console.log("\n✅ Dry run complete. Task config is valid.");
    process.exit(0);
  }

  if (!jsonOutput) {
    console.log("\n🚀 Verdikt starting...");
    console.log(`   Task: ${task.id}`);
    console.log(`   Goal: ${task.goal}`);
    console.log(`   Repo: ${task.repoPath}`);
    console.log(`   Max iterations: ${task.maxIterations}\n`);
  }

  const result = await runSupervisorLoop(task, {
    skipWorktree,
    skipIntegrity,
    autoApply,
    stream: !jsonOutput,
  });

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
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
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

  const files = (await readdirFs(tasksDir)).filter((f) => f.endsWith(".json")).sort();

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

  const results: Array<{
    taskId: string;
    passed: boolean;
    reason: string;
    iterations: number;
    costUsd: number;
  }> = [];

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

    const result = await runSupervisorLoop(task, {
      skipWorktree,
      skipIntegrity,
      autoApply,
      stream: !jsonOutput,
    });

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
    process.stdout.write(
      `${JSON.stringify({ total: results.length, passed, failed: results.length - passed, totalCostUsd: totalCost, results }, null, 2)}\n`,
    );
  } else {
    console.log(`\n${"═".repeat(60)}`);
    console.log(
      `📊 Batch Summary: ${passed}/${results.length} passed | Cost: $${totalCost.toFixed(4)}`,
    );
    console.log(`${"═".repeat(60)}`);
    for (const r of results) {
      const icon = r.passed ? "✅" : "❌";
      console.log(
        `  ${icon} ${r.taskId}: ${r.reason} (${r.iterations} iter, $${r.costUsd.toFixed(4)})`,
      );
    }
    console.log();
  }

  process.exit(passed === results.length ? 0 : 1);
}
