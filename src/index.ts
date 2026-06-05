#!/usr/bin/env node
/**
 * Verdikt CLI — entry point.
 *
 * Usage:
 *   verdikt run --task <task-file>
 *   verdikt doctor
 */

import {
  handleAnalyze,
  handleApply,
  handleBenchmark,
  handleCompare,
  handleDashboard,
  handleDiscard,
  handleDoctor,
  handleInit,
  handleList,
  handleResume,
  handleRun,
  handleView,
} from "./cli/index.js";

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

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
