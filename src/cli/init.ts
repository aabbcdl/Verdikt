/**
 * CLI handler for `verdikt init` command.
 */

import { resolve } from "node:path";
import { hasFlag, parseArgs } from "./parseArgs.js";

export async function handleInit(args: string[]): Promise<void> {
  const parsed = parseArgs(args, {
    boolean: ["suite"],
    positional: { max: 2, names: ["id", "repo-path"] },
  });
  const { writeFile: wf } = await import("node:fs/promises");

  // init --suite creates a benchmark suite template
  if (hasFlag(parsed, "suite")) {
    if (parsed.positional.length > 0) {
      throw new Error("verdikt init --suite does not accept positional arguments");
    }
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
    console.log("\nEdit the file to add your tasks and configure the suite.");
    console.log(`Then run: verdikt benchmark --suite ${filename}`);
    return;
  }

  const id = parsed.positional[0] || "my-task";
  const repoPath = parsed.positional[1] || ".";

  const task = {
    id,
    goal: "Describe what the executor should accomplish",
    repoPath: resolve(repoPath),
    acceptance: {
      steps: [{ id: "test", command: "npm", args: ["test"] }],
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
  console.log("\nEdit the file to set:");
  console.log("  • goal      — what to accomplish");
  console.log("  • repoPath  — path to the target repository");
  console.log("  • acceptance.steps — test commands to verify success");
  console.log(`\nThen run: verdikt run --task ${filename}`);
}
