/**
 * Executor role — invokes Claude Code as the "doer".
 */

import { type StreamCallbacks, callClaude } from "../claude/driver.js";
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
  signal?: AbortSignal,
  runtime: { runDir?: string } = {},
): Promise<DriverOutput> {
  const userPrompt = buildExecutorPrompt(task, instruction);

  return callClaude(
    {
      systemPrompt: EXECUTOR_SYSTEM,
      userPrompt,
      cwd: task.repoPath,
      allowedTools: buildAllowedTools(["Read", "Edit", "Write", "Glob", "Grep"]),
      commandPolicy: {
        repoRoot: task.repoPath,
        approvedCategories: task.riskPolicy?.approvedCategories ?? [],
        allowAll: task.riskPolicy?.mode === "allow",
        runDir: runtime.runDir,
      },
      timeoutMs: task.execution?.idleTimeoutMs,
      softTimeoutMs: task.execution?.softTimeoutMs,
      absoluteTimeoutMs: task.execution?.hardTimeoutMs,
      signal,
    },
    streamCallbacks,
  );
}

function buildExecutorPrompt(task: TaskSpec, instruction: string): string {
  return [
    "## Task Goal",
    task.goal,
    "",
    "## Acceptance Criteria",
    ...formatAcceptance(task.acceptance),
    "",
    "## This Round",
    instruction,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatAcceptance(acceptance: TaskSpec["acceptance"]): string[] {
  if (acceptance.steps && acceptance.steps.length > 0) {
    return acceptance.steps.map((step) => {
      const command = [step.command, ...(step.args ?? [])].join(" ");
      const required = step.required === false ? "optional" : "required";
      return `- ${step.id}: ${command} (${required})`;
    });
  }

  if (acceptance.custom) {
    return [`- Custom judge: node ${acceptance.custom.script}`];
  }

  return [
    acceptance.testCommand ? `- Tests: ${acceptance.testCommand}` : null,
    acceptance.buildCommand ? `- Build: ${acceptance.buildCommand}` : null,
    acceptance.lintCommand ? `- Lint: ${acceptance.lintCommand}` : null,
  ].filter((line): line is string => Boolean(line));
}
