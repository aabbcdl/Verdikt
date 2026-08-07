/**
 * StopCondition — deterministic decision logic for when to halt the loop.
 *
 * This is pure code, no LLM. Four stop conditions:
 * 1. Judge all green → passed
 * 2. Cost stop target reached → budget_exceeded
 * 3. Max iterations → max_iterations
 * 4. No progress (consecutive identical failures) → no_progress
 */

import type { IterationRecord, JudgeResult, StopReason, TaskSpec } from "../types.js";

export interface StopDecision {
  stop: boolean;
  reason?: StopReason;
}

/**
 * Decide whether to stop the iteration loop.
 */
export function decideStop(
  iterations: IterationRecord[],
  task: TaskSpec,
  totalCost: number,
): StopDecision {
  if (iterations.length === 0) return { stop: false };

  const last = iterations[iterations.length - 1];

  // 1. Success requires objective checks plus reviewer confirmation.
  if (
    last.judge.passed &&
    (last.integrity?.criticalCount ?? 0) === 0 &&
    last.verifierVerdict.done &&
    last.verifierVerdict.problems.length === 0
  ) {
    return { stop: true, reason: "passed" };
  }

  // 2. Cost stop target reached
  if (task.maxBudgetUsd != null && totalCost >= task.maxBudgetUsd) {
    return { stop: true, reason: "budget_exceeded" };
  }

  // 3. Max iterations reached
  if (iterations.length >= task.maxIterations) {
    return { stop: true, reason: "max_iterations" };
  }

  // 4. No progress — consecutive iterations with identical failure signatures
  if (iterations.length >= 3) {
    const beforePrev = iterations[iterations.length - 3];
    const prev = iterations[iterations.length - 2];
    const curr = iterations[iterations.length - 1];
    if (
      (sameFailures(beforePrev.judge, prev.judge) && sameFailures(prev.judge, curr.judge)) ||
      (sameVerifierObjections(beforePrev, prev) && sameVerifierObjections(prev, curr))
    ) {
      return { stop: true, reason: "no_progress" };
    }
  }

  return { stop: false };
}

/**
 * Compare two judge results to detect identical failure patterns.
 * Returns true if the exact same checks failed with the same error signatures.
 */
export function sameFailures(a: JudgeResult, b: JudgeResult): boolean {
  const aFails = blockingFailedChecks(a);
  const bFails = blockingFailedChecks(b);

  // Different number of failing checks → not stuck
  if (aFails.length !== bFails.length) return false;

  // If no failures in either, not stuck (shouldn't happen — judge.passed would be true)
  if (aFails.length === 0) return false;

  // Compare each failing check by name and error signature
  for (let i = 0; i < aFails.length; i++) {
    const af = aFails[i];
    const bf = bFails[i];

    // Different check name
    if (af.name !== bf.name) return false;

    // Compare last 500 chars of output as error signature
    // (early output may vary due to timestamps, line numbers, etc.)
    const sigA = af.output.slice(-500).trim();
    const sigB = bf.output.slice(-500).trim();
    if (sigA !== sigB) return false;
  }

  return true;
}

function blockingFailedChecks(judge: JudgeResult): JudgeResult["checks"] {
  const optionalStepIds = new Set(
    judge.stepResults?.filter((step) => !step.required).map((step) => step.id) ?? [],
  );
  return judge.checks.filter((check) => !check.passed && !optionalStepIds.has(check.name));
}

function sameVerifierObjections(a: IterationRecord, b: IterationRecord): boolean {
  const aProblems = a.verifierVerdict.problems.map((p) => p.trim()).filter(Boolean);
  const bProblems = b.verifierVerdict.problems.map((p) => p.trim()).filter(Boolean);

  if (aProblems.length === 0 || aProblems.length !== bProblems.length) return false;
  if (a.verifierVerdict.done || b.verifierVerdict.done) return false;

  for (let i = 0; i < aProblems.length; i++) {
    if (aProblems[i] !== bProblems[i]) return false;
  }

  return true;
}
