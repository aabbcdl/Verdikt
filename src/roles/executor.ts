/**
 * Executor role — invokes Claude Code as the "doer".
 */

import { callClaude, type StreamCallbacks } from "../claude/driver.js";
import { buildAllowedTools } from "../claude/platform.js";
import type { DriverOutput, TaskSpec } from "../types.js";
import { EXECUTOR_SYSTEM } from "./prompts.js";

/**
 * Run the executor for one iteration.
 *
 * @param task   The task specification
 * @param instruction  What the executor should do this round (task goal or verifier's feedback)
 * @param streamCallbacks  Optional callbacks for real-time output streaming
 * @returns The executor's raw output
 */
export async function runExecutor(
  task: TaskSpec,
  instruction: string,
  streamCallbacks?: StreamCallbacks,
): Promise<DriverOutput> {
  const userPrompt = buildExecutorPrompt(task, instruction);

  return callClaude({
    systemPrompt: EXECUTOR_SYSTEM,
    userPrompt,
    cwd: task.repoPath,
    allowedTools: buildAllowedTools(["Read", "Edit", "Write", "Glob", "Grep"]),
  }, streamCallbacks);
}

function buildExecutorPrompt(task: TaskSpec, instruction: string): string {
  return [
    `## Task Goal`,
    task.goal,
    ``,
    `## Acceptance Criteria`,
    `- Tests: ${task.acceptance.testCommand}`,
    task.acceptance.buildCommand ? `- Build: ${task.acceptance.buildCommand}` : null,
    task.acceptance.lintCommand ? `- Lint: ${task.acceptance.lintCommand}` : null,
    ``,
    `## This Round`,
    instruction,
  ]
    .filter(Boolean)
    .join("\n");
}
