/**
 * Verifier role — invokes Claude Code as the skeptical QA.
 *
 * The verifier is fed the objective judge results and must:
 * 1. Interpret what still fails
 * 2. Generate actionable next-step instructions
 * 3. Declare done/not-done (but judge has final say)
 */

import { callClaude } from "../claude/driver.js";
import type { JudgeResult, TaskSpec, VerifierVerdict } from "../types.js";
import { VERIFIER_SYSTEM } from "./prompts.js";

export interface VerifierResult {
  verdict: VerifierVerdict;
  costUsd?: number;
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
): Promise<VerifierResult> {
  const userPrompt = buildVerifierPrompt(task, judge, executorOutput);

  const result = await callClaude({
    systemPrompt: VERIFIER_SYSTEM,
    userPrompt,
    cwd: task.repoPath,
    allowedTools: ["Read", "Glob", "Grep"], // Read-only — verifier cannot modify code
  });

  return {
    verdict: parseVerifierOutput(result.text, judge),
    costUsd: result.costUsd,
  };
}

function buildVerifierPrompt(
  task: TaskSpec,
  judge: JudgeResult,
  executorOutput: string,
): string {
  const judgeSummary = judge.checks
    .map(
      (c) =>
        `[${c.passed ? "PASS" : "FAIL"}] ${c.name} (exit ${c.exitCode}, ${c.durationMs}ms)` +
        (c.passed ? "" : `\n${c.output.slice(-2000)}`), // Last 2k chars for failures
    )
    .join("\n\n");

  // M4.2: Include structured step results if available
  const stepSummary = judge.stepResults
    ? `\n\nStructured Steps:\n${judge.stepResults.map((s) =>
        `  ${s.passed ? "✅" : "❌"} ${s.id} (exit ${s.exitCode}, ${s.durationMs}ms, ${s.required ? "required" : "optional"})` +
        (s.passed ? "" : `\n    stderr: ${s.stderr.slice(-500)}`)
      ).join("\n")}`
    : "";

  return [
    `## Acceptance Criteria`,
    JSON.stringify(task.acceptance, null, 2),
    ``,
    `## Judge Results (GROUND TRUTH)`,
    `Overall: ${judge.passed ? "ALL PASSED" : "FAILURES EXIST"}`,
    ``,
    judgeSummary,
    stepSummary,
    ``,
    `## Executor Claims`,
    executorOutput.slice(-3000), // Last 3k chars
  ].join("\n");
}

/**
 * Parse verifier's JSON output. Falls back gracefully on parse failure.
 */
function parseVerifierOutput(text: string, judge: JudgeResult): VerifierVerdict {
  try {
    // Extract JSON from potential markdown wrapping
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return fallbackVerdict(judge);

    const parsed = JSON.parse(jsonMatch[0]);

    return {
      done: Boolean(parsed.done),
      problems: Array.isArray(parsed.problems) ? parsed.problems.map(String) : [],
      nextInstruction:
        typeof parsed.nextInstruction === "string"
          ? parsed.nextInstruction
          : "Continue fixing the remaining test failures.",
    };
  } catch {
    return fallbackVerdict(judge);
  }
}

/**
 * Fallback when verifier output can't be parsed.
 * Defers to judge: if judge failed, task is not done.
 */
function fallbackVerdict(judge: JudgeResult): VerifierVerdict {
  const failures = judge.checks.filter((c) => !c.passed);
  return {
    done: judge.passed,
    problems: failures.map((f) => `${f.name} failed (exit ${f.exitCode})`),
    nextInstruction: judge.passed
      ? ""
      : `Fix the failing checks: ${failures.map((f) => f.name).join(", ")}. Read the test output carefully and make the minimal correct fix.`,
  };
}
