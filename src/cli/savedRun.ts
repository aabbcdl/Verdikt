import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { isPathInside } from "./localServer.js";

export function readSavedRunRepoPath(options: {
  stateDir: string;
  runDir: string;
  runId: string;
  action: "apply" | "discard";
}): string {
  const taskPaths = ["task.json", "normalizedTask.json"].map((fileName) =>
    join(options.runDir, fileName),
  );
  if (taskPaths.some((taskPath) => !isPathInside(options.stateDir, taskPath))) {
    throw new Error("Access denied");
  }

  const taskPath = taskPaths.find((candidate) => existsSync(candidate));
  if (!taskPath) {
    throw new Error(
      `Cannot ${options.action} run ${options.runId}: task.json is missing, so the target repo is unknown.`,
    );
  }

  let task: { repoPath?: unknown };
  try {
    task = JSON.parse(readFileSync(taskPath, "utf-8"));
  } catch {
    throw new Error(
      `Cannot ${options.action} run ${options.runId}: ${taskPath.endsWith("normalizedTask.json") ? "normalizedTask.json" : "task.json"} is unreadable, so the target repo is unknown.`,
    );
  }

  if (typeof task.repoPath !== "string" || task.repoPath.trim() === "") {
    throw new Error(`Cannot ${options.action} run ${options.runId}: repoPath is missing.`);
  }

  if (!isAbsolute(task.repoPath)) {
    throw new Error(`Cannot ${options.action} run ${options.runId}: repoPath must be absolute.`);
  }

  const repoPath = resolve(task.repoPath);
  if (!existsSync(repoPath) || !statSync(repoPath).isDirectory()) {
    throw new Error(`Cannot ${options.action} run ${options.runId}: repoPath is not accessible.`);
  }

  if (!existsSync(join(repoPath, ".git"))) {
    throw new Error(`Cannot ${options.action} run ${options.runId}: repoPath is not a git repo.`);
  }

  return repoPath;
}
