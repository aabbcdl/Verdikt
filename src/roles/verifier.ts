/**
 * Verifier role — invokes Claude Code as the skeptical QA.
 *
 * The verifier is fed the objective judge results and must:
 * 1. Interpret what still fails
 * 2. Generate actionable next-step instructions
 * 3. Declare done/not-done (but judge has final say)
 */

import { type StreamCallbacks, callClaude } from "../claude/driver.js";
import type {
  AgentTermination,
  DriverFailure,
  JudgeResult,
  TaskSpec,
  UsageSummary,
  VerifierVerdict,
} from "../types.js";
import { STAGE_VERIFIER_SYSTEM, VERIFIER_SYSTEM } from "./prompts.js";

export interface VerifierResult {
  verdict: VerifierVerdict;
  costUsd?: number;
  usage?: UsageSummary;
  failure?: DriverFailure;
  termination?: AgentTermination;
}

export interface VerifierOptions {
  completionGoal?: string;
  requireJudgePass?: boolean;
  streamCallbacks?: StreamCallbacks;
}

/**
 * Run the verifier for one iteration.
 *
 * Returns a structured VerifierVerdict plus cost tracking.
 * If parsing fails, defaults to not-done.
 */
export async function runVerifier(
  task: TaskSpec,
  judge: JudgeResult,
  executorOutput: string,
  signal?: AbortSignal,
  options: VerifierOptions = {},
): Promise<VerifierResult> {
  const userPrompt = buildVerifierPrompt(task, judge, executorOutput, options);

  const input = {
    systemPrompt: options.requireJudgePass === false ? STAGE_VERIFIER_SYSTEM : VERIFIER_SYSTEM,
    userPrompt,
    cwd: task.repoPath,
    allowedTools: ["Read", "Glob", "Grep"], // Read-only ? verifier cannot modify code
    timeoutMs: task.execution?.idleTimeoutMs,
    softTimeoutMs: task.execution?.softTimeoutMs,
    absoluteTimeoutMs: task.execution?.hardTimeoutMs,
    signal,
  };
  const result = await (options.streamCallbacks
    ? callClaude(input, options.streamCallbacks)
    : callClaude(input));

  if (result.failure) {
    return {
      verdict: verifierExecutionFailureVerdict(judge, result.failure.message),
      costUsd: result.costUsd,
      usage: result.usage,
      failure: result.failure,
      termination: result.termination,
    };
  }

  if (result.timedOut || isDriverFailure(result.text)) {
    return {
      verdict: verifierExecutionFailureVerdict(
        judge,
        result.timedOut ? "Verifier timed out" : "Verifier process failed",
      ),
      costUsd: result.costUsd,
      usage: result.usage,
      termination: result.termination,
    };
  }

  return {
    verdict: parseVerifierOutput(result.text, judge, options.requireJudgePass !== false),
    costUsd: result.costUsd,
    usage: result.usage,
    termination: result.termination,
  };
}

function buildVerifierPrompt(
  task: TaskSpec,
  judge: JudgeResult,
  executorOutput: string,
  options: VerifierOptions,
): string {
  const judgeSummary = buildJudgeSummary(judge);

  return [
    options.completionGoal ? "## Current Stage Goal" : null,
    options.completionGoal ?? null,
    options.completionGoal ? "" : null,
    "## Acceptance Criteria",
    JSON.stringify(task.acceptance, null, 2),
    "",
    "## Judge Results (GROUND TRUTH)",
    `Overall: ${buildOverallJudgeLabel(judge)}`,
    "",
    judgeSummary,
    "",
    "## Executor Claims",
    executorOutput.slice(-3000), // Last 3k chars
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function buildOverallJudgeLabel(judge: JudgeResult): string {
  if (judge.stepResults) {
    return judge.passed ? "REQUIRED CHECKS PASSED" : "REQUIRED FAILURES EXIST";
  }
  return judge.passed ? "ALL PASSED" : "FAILURES EXIST";
}

function buildJudgeSummary(judge: JudgeResult): string {
  if (!judge.stepResults) {
    return judge.checks
      .map(
        (c) =>
          `[${c.passed ? "PASS" : "FAIL"}] ${c.name} (exit ${c.exitCode}, ${c.durationMs}ms)${c.passed ? "" : `\n${c.output.slice(-2000)}`}`,
      )
      .join("\n\n");
  }

  const requiredSteps = judge.stepResults.filter((step) => step.required);
  const optionalSteps = judge.stepResults.filter((step) => !step.required);
  const stepIds = new Set(judge.stepResults.map((step) => step.id));
  const extraBlockingChecks = judge.checks.filter((check) => !stepIds.has(check.name));

  const sections = [
    "Required Judge Checks:",
    requiredSteps.length > 0
      ? requiredSteps.map((step) => formatStructuredStep(step, false)).join("\n\n")
      : "(none configured; acceptance should fail until at least one required step exists)",
  ];

  if (extraBlockingChecks.length > 0) {
    sections.push(
      "",
      "Additional Blocking Judge Checks:",
      extraBlockingChecks
        .map(
          (c) =>
            `[${c.passed ? "PASS" : "FAIL"}] ${c.name} (exit ${c.exitCode}, ${c.durationMs}ms)${c.passed ? "" : `\n${c.output.slice(-2000)}`}`,
        )
        .join("\n\n"),
    );
  }

  if (optionalSteps.length > 0) {
    sections.push(
      "",
      "Optional Judge Diagnostics (non-blocking):",
      optionalSteps.map((step) => formatStructuredStep(step, true)).join("\n\n"),
    );
  }

  return sections.join("\n");
}

function formatStructuredStep(
  step: NonNullable<JudgeResult["stepResults"]>[number],
  optional: boolean,
): string {
  const status = optional
    ? step.passed
      ? "OPTIONAL PASS"
      : "OPTIONAL FAIL"
    : step.passed
      ? "PASS"
      : "FAIL";
  const output = [step.stdout, step.stderr].filter(Boolean).join("\n").slice(-2000);
  return `[${status}] ${step.id} (exit ${step.exitCode}, ${step.durationMs}ms)${step.passed || !output ? "" : `\n${output}`}`;
}

/**
 * Parse verifier's JSON output. Falls back gracefully on parse failure.
 */
function parseVerifierOutput(
  text: string,
  judge: JudgeResult,
  requireJudgePass = true,
): VerifierVerdict {
  const parsed = parseFirstValidJson(text);
  if (!isRecord(parsed) || typeof parsed.done !== "boolean") {
    return fallbackVerdict(judge, { verifierMalformed: true });
  }

  const problems = Array.isArray(parsed.problems)
    ? parsed.problems.map(String).filter(Boolean)
    : [];
  const fallback = fallbackVerdict(judge);
  const done = (!requireJudgePass || judge.passed) && parsed.done;
  const nextInstruction =
    typeof parsed.nextInstruction === "string" && parsed.nextInstruction.trim().length > 0
      ? parsed.nextInstruction
      : fallback.nextInstruction || "Address the verifier's remaining problems and rerun checks.";

  return {
    done,
    problems,
    nextInstruction,
  };
}

function parseFirstValidJson(text: string): unknown {
  for (const candidate of jsonCandidates(text)) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function jsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  const fencePattern = /```(?:json)?\s*([\s\S]*?)```/gi;

  for (const match of text.matchAll(fencePattern)) {
    const candidate = match[1]?.trim();
    if (candidate) candidates.push(candidate);
  }

  const trimmed = text.trim();
  if (trimmed) candidates.push(trimmed);

  candidates.push(...extractBalancedObjects(text));

  return [...new Set(candidates)];
}

function extractBalancedObjects(text: string): string[] {
  const objects: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      if (depth === 0) start = i;
      depth++;
      continue;
    }

    if (char === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        objects.push(text.slice(start, i + 1));
        start = -1;
      } else if (depth < 0) {
        depth = 0;
        start = -1;
      }
    }
  }

  return objects;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDriverFailure(text: string): boolean {
  return text.includes("[DRIVER ERROR]") || text.includes("[CANCELLED]");
}

/**
 * Fallback when verifier output can't be parsed.
 * Defers to judge: if judge failed, task is not done.
 */
function fallbackVerdict(
  judge: JudgeResult,
  options: { verifierMalformed?: boolean } = {},
): VerifierVerdict {
  const failures = blockingFailedChecks(judge);

  if (options.verifierMalformed && judge.passed) {
    return {
      done: false,
      problems: ["Verifier output could not be parsed"],
      nextInstruction:
        "Objective checks passed, but the verifier did not return valid JSON. Preserve the current fix, rerun the checks if needed, and wait for a valid verifier verdict.",
    };
  }

  return {
    done: judge.passed,
    problems: failures.map((f) => `${f.name} failed (exit ${f.exitCode})`),
    nextInstruction: judge.passed
      ? ""
      : `Fix the failing checks: ${failures.map((f) => f.name).join(", ")}. Read the test output carefully and make the minimal correct fix.`,
  };
}

function blockingFailedChecks(judge: JudgeResult): JudgeResult["checks"] {
  const optionalStepIds = new Set(
    judge.stepResults?.filter((step) => !step.required).map((step) => step.id) ?? [],
  );
  return judge.checks.filter((check) => !check.passed && !optionalStepIds.has(check.name));
}

function verifierExecutionFailureVerdict(judge: JudgeResult, problem: string): VerifierVerdict {
  const fallback = fallbackVerdict(judge);
  return {
    done: false,
    problems: judge.passed ? [problem] : [...fallback.problems, problem],
    nextInstruction: judge.passed
      ? "Objective checks passed, but the verifier did not complete successfully. Preserve the current fix, rerun the checks if needed, and wait for a valid verifier verdict."
      : fallback.nextInstruction,
  };
}
