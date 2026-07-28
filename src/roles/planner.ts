import { type StreamCallbacks, callClaude } from "../claude/driver.js";
import type { DriverOutput, TaskSpec } from "../types.js";
import { PLANNER_SYSTEM } from "./prompts.js";

export async function runPlanner(
  task: TaskSpec,
  signal?: AbortSignal,
  streamCallbacks?: StreamCallbacks,
): Promise<DriverOutput> {
  const input = {
    systemPrompt: PLANNER_SYSTEM,
    userPrompt: [
      "## Task",
      task.goal,
      "",
      "## Acceptance",
      JSON.stringify(task.acceptance, null, 2),
      "",
      "Create a read-only implementation plan. Do not modify the repository.",
    ].join("\n"),
    cwd: task.repoPath,
    allowedTools: ["Read", "Glob", "Grep"],
    timeoutMs: task.execution?.idleTimeoutMs,
    softTimeoutMs: task.execution?.softTimeoutMs,
    absoluteTimeoutMs: task.execution?.hardTimeoutMs,
    signal,
  };
  return streamCallbacks ? callClaude(input, streamCallbacks) : callClaude(input);
}
