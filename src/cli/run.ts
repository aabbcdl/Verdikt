/**
 * CLI handler for `verdikt run` command.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { runSupervisorLoop } from "../loop/supervisor.js";
import type { TaskSpec, UsageSummary } from "../types.js";
import { formatCost, mergeUsage } from "../usage.js";
import type { ValidationResult } from "../validation.js";
import { type ParsedArgs, getFlag, hasFlag, parseArgs } from "./parseArgs.js";

export async function handleRun(args: string[]): Promise<void> {
  let parsed: ParsedArgs;
  try {
    parsed = parseRunArgs(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  const taskFile = getFlag(parsed, "task", "");
  const tasksDirectory = getFlag(parsed, "tasks", "");
  if (taskFile && tasksDirectory) {
    console.error("Use either --task or --tasks, not both.");
    process.exitCode = 1;
    return;
  }
  if (tasksDirectory) {
    return handleBatchRun(args, resolve(tasksDirectory));
  }

  if (!taskFile) {
    console.error("Error: --task <file> is required");
    console.error("Usage: verdikt run --task <task-file>");
    process.exit(1);
  }

  const taskPath = resolve(taskFile);

  if (!existsSync(taskPath)) {
    console.error(`\nTask file not found: ${taskPath}`);
    const dir = resolve(taskPath, "..");
    if (existsSync(dir)) {
      const { readdirSync } = await import("node:fs");
      const jsonFiles = readdirSync(dir).filter((f: string) => f.endsWith(".json"));
      if (jsonFiles.length > 0) {
        console.error(`\nAvailable JSON files in ${dir}:`);
        for (const f of jsonFiles.slice(0, 10)) {
          console.error(`  - ${f}`);
        }
      }
    }
    console.error("\nCreate one with: verdikt init <task-id> <repo-path>");
    process.exit(1);
  }

  let task: TaskSpec;
  try {
    task = readTaskFile(taskPath);
  } catch (err) {
    console.error(`\nInvalid JSON in task file: ${taskPath}`);
    console.error(`   ${err instanceof Error ? err.message : String(err)}`);
    console.error("\nFix the JSON syntax, or create a fresh task: verdikt init");
    process.exit(1);
  }

  const { validateTaskSpec } = await import("../validation.js");
  const validation = validateTaskSpec(task, taskPath);
  printValidation(validation);

  if (!validation.valid) {
    console.error(`\nEdit ${taskPath} and try again.`);
    process.exit(1);
  }

  const skipWorktree = hasFlag(parsed, "no-worktree");
  const skipIntegrity = hasFlag(parsed, "no-integrity");
  const autoApply = hasFlag(parsed, "auto-apply");
  const verbose = hasFlag(parsed, "verbose");
  const jsonOutput = hasFlag(parsed, "json");
  const dryRun = hasFlag(parsed, "dry-run");
  const allowDirty = hasFlag(parsed, "allow-dirty") || task.allowDirtyRepo === true;
  if (allowDirty) task.allowDirtyRepo = true;

  // Isolated runs snapshot HEAD and apply refuses dirty repos — fail fast at
  // zero cost instead of after a full paid run. Direct mode (--no-worktree)
  // works on the tree in place, so dirty is fine there.
  if (!skipWorktree && !dryRun) {
    const { checkRepoPreflight } = await import("./repoPreflight.js");
    const preflight = await checkRepoPreflight(task.repoPath, allowDirty);
    if (!preflight.ok) {
      console.error("\n目标仓库有未提交的改动，任务未开始。");
      console.error(`  ${preflight.message}`);
      console.error(`  处理方式：${preflight.fix}`);
      process.exit(1);
    }
  }

  if (verbose) {
    const { setConfig } = await import("../config.js");
    setConfig({ verbose: true });
  }

  if (dryRun) {
    printDryRun(task, { skipWorktree, skipIntegrity });
    process.exit(0);
  }

  if (!jsonOutput) {
    console.log("\nVerdikt starting...");
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

  if (jsonOutput) {
    const output = {
      taskId: task.id,
      goal: task.goal,
      repoPath: task.repoPath,
      passed: result.reason === "passed",
      stopReason: result.reason,
      iterations: result.iterations.length,
      totalCostUsd: result.totalCostUsd,
      usageStatus: result.usageStatus ?? result.usage?.status ?? "complete",
      usage: result.usage ?? null,
      totalDurationMs: result.totalDurationMs,
      runId: result.runId ?? null,
    };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  }

  if (result.reason === "passed") {
    if (!jsonOutput) console.log("Task completed successfully.");
    process.exit(0);
  } else if (result.reason === "budget_exceeded") {
    if (!jsonOutput) console.log(`Task stopped: ${result.reason}`);
    process.exit(2);
  } else {
    if (!jsonOutput) console.log(`Task stopped: ${result.reason}`);
    process.exit(1);
  }
}

async function handleBatchRun(args: string[], tasksDir: string): Promise<void> {
  let parsed: ParsedArgs;
  try {
    parsed = parseRunArgs(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  const { readdir: readdirFs } = await import("node:fs/promises");
  const { validateTaskSpec } = await import("../validation.js");

  if (!existsSync(tasksDir)) {
    console.error(`\nTasks directory not found: ${tasksDir}`);
    process.exit(1);
  }

  const files = (await readdirFs(tasksDir)).filter((f) => f.endsWith(".json")).sort();

  if (files.length === 0) {
    console.error(`\nNo .json files found in ${tasksDir}`);
    process.exit(1);
  }

  const jsonOutput = hasFlag(parsed, "json");
  const skipWorktree = hasFlag(parsed, "no-worktree");
  const skipIntegrity = hasFlag(parsed, "no-integrity");
  const autoApply = hasFlag(parsed, "auto-apply");

  if (!jsonOutput) {
    console.log(`\nBatch run: ${files.length} tasks from ${tasksDir}\n`);
  }

  const results: Array<{
    taskId: string;
    passed: boolean;
    reason: string;
    iterations: number;
    costUsd: number;
    usage: UsageSummary;
  }> = [];
  let skipped = 0;

  for (const file of files) {
    const taskPath = resolve(tasksDir, file);
    let task: TaskSpec;
    try {
      task = readTaskFile(taskPath);
    } catch (err) {
      skipped += 1;
      console.error(`\nSkipping ${file}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    const validation = validateTaskSpec(task, taskPath);
    printValidation(validation);
    if (!validation.valid) {
      skipped += 1;
      console.error(`\nSkipping ${file}: task validation failed.`);
      continue;
    }

    if (!skipWorktree) {
      const { checkRepoPreflight } = await import("./repoPreflight.js");
      const preflight = await checkRepoPreflight(task.repoPath, task.allowDirtyRepo === true);
      if (!preflight.ok) {
        skipped += 1;
        console.error(`\nSkipping ${file}: ${preflight.message}`);
        console.error(`  处理方式：${preflight.fix}`);
        continue;
      }
    }

    if (!jsonOutput) {
      console.log("-".repeat(60));
      console.log(`${task.id}: ${task.goal}`);
    }

    try {
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
        usage: result.usage ?? {
          status: result.usageStatus ?? "unknown",
          costUsd: result.totalCostUsd,
        },
      });
    } catch (err) {
      results.push({
        taskId: task.id,
        passed: false,
        reason: err instanceof Error ? err.message : String(err),
        iterations: 0,
        costUsd: 0,
        usage: { status: "unknown" },
      });
    }
  }

  const passed = results.filter((r) => r.passed).length;
  const totalUsage = mergeUsage(...results.map((result) => result.usage));
  const totalCost = totalUsage.costUsd ?? 0;
  const failed = results.length - passed;

  if (jsonOutput) {
    process.stdout.write(
      `${JSON.stringify({ total: results.length, passed, failed, skipped, totalCostUsd: totalCost, results }, null, 2)}\n`,
    );
  } else {
    console.log("");
    console.log("=".repeat(60));
    console.log(
      `Batch Summary: ${passed}/${results.length} passed | ${skipped} skipped | Cost: ${formatCost(totalUsage, 4)}`,
    );
    console.log("=".repeat(60));
    for (const r of results) {
      const icon = r.passed ? "OK" : "FAIL";
      console.log(
        `  ${icon} ${r.taskId}: ${r.reason} (${r.iterations} iter, ${formatCost(r.usage, 4)})`,
      );
    }
    console.log("");
  }

  const allRanAndPassed = skipped === 0 && results.length > 0 && passed === results.length;
  process.exit(allRanAndPassed ? 0 : 1);
}

function parseRunArgs(args: string[]): ParsedArgs {
  return parseArgs(args, {
    optional: ["task", "tasks"],
    boolean: [
      "no-worktree",
      "no-integrity",
      "auto-apply",
      "verbose",
      "json",
      "dry-run",
      "allow-dirty",
    ],
    positional: { max: 0 },
  });
}

function readTaskFile(taskPath: string): TaskSpec {
  const raw = readFileSync(taskPath, "utf-8");
  const task = JSON.parse(raw) as TaskSpec;

  if (task.repoPath && !isAbsolute(task.repoPath)) {
    task.repoPath = resolve(dirname(taskPath), task.repoPath);
  }

  task.maxIterations = task.maxIterations ?? 5;
  return task;
}

function printValidation(validation: ValidationResult): void {
  for (const warning of validation.warnings) {
    console.warn(`Warning: ${warning.message}`);
    console.warn(`   Fix: ${warning.fix}`);
  }

  if (!validation.valid) {
    console.error("\nTask validation failed:\n");
    for (const error of validation.errors) {
      console.error(`  [${error.field}] ${error.message}`);
      console.error(`    Fix: ${error.fix}`);
    }
  }
}

function printDryRun(
  task: TaskSpec,
  options: { skipWorktree: boolean; skipIntegrity: boolean },
): void {
  console.log("\nDRY RUN: no Claude calls will be made\n");
  console.log(`Task:     ${task.id}`);
  console.log(`Goal:     ${task.goal}`);
  console.log(`Repo:     ${task.repoPath}`);
  console.log(`Max iter: ${task.maxIterations ?? 5}`);
  console.log(`Budget:   ${task.maxBudgetUsd ? `$${task.maxBudgetUsd}` : "unlimited"}`);
  console.log(`Worktree: ${!options.skipWorktree ? "yes" : "no"}`);
  console.log(`Integrity: ${!options.skipIntegrity ? "yes" : "no"}`);

  if (task.acceptance.steps) {
    console.log("\nJudge steps:");
    for (const step of task.acceptance.steps) {
      console.log(`  - [${step.id}] ${step.command} ${(step.args ?? []).join(" ")}`);
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

  console.log("\nDry run complete. Task config is valid.");
}
