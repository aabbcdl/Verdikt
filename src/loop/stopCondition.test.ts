/**
 * Tests for StopCondition — the four stop reason branches.
 */

import { describe, it, expect } from "vitest";
import { decideStop, sameFailures } from "./stopCondition.js";
import type { IterationRecord, JudgeResult, TaskSpec } from "../types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id: "test-task",
    goal: "fix tests",
    repoPath: "/tmp/test",
    acceptance: { testCommand: "npm test" },
    maxIterations: 5,
    ...overrides,
  };
}

function makeIteration(overrides: Partial<IterationRecord> = {}): IterationRecord {
  return {
    index: 0,
    executorOutput: "did stuff",
    changedFiles: [],
    judge: { passed: false, checks: [{ name: "test", passed: false, output: "fail", exitCode: 1, durationMs: 100 }] },
    verifierVerdict: { done: false, problems: ["fail"], nextInstruction: "fix it" },
    durationMs: 1000,
    ...overrides,
  };
}

function makeJudge(passed: boolean, checkName = "test"): JudgeResult {
  return {
    passed,
    checks: [{ name: checkName, passed, output: passed ? "ok" : "FAIL", exitCode: passed ? 0 : 1, durationMs: 100 }],
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("decideStop", () => {
  it("returns stop=false when no iterations yet", () => {
    const result = decideStop([], makeTask(), 0);
    expect(result.stop).toBe(false);
  });

  it("stops with 'passed' when judge is all green", () => {
    const iterations = [makeIteration({ judge: makeJudge(true) })];
    const result = decideStop(iterations, makeTask(), 0);
    expect(result.stop).toBe(true);
    expect(result.reason).toBe("passed");
  });

  it("stops with 'max_iterations' when iteration count reached", () => {
    const task = makeTask({ maxIterations: 2 });
    const iterations = [
      makeIteration({ index: 0 }),
      makeIteration({ index: 1 }),
    ];
    const result = decideStop(iterations, task, 0);
    expect(result.stop).toBe(true);
    expect(result.reason).toBe("max_iterations");
  });

  it("stops with 'budget_exceeded' when cost exceeds limit", () => {
    const task = makeTask({ maxBudgetUsd: 1.0 });
    const iterations = [makeIteration()];
    const result = decideStop(iterations, task, 1.5);
    expect(result.stop).toBe(true);
    expect(result.reason).toBe("budget_exceeded");
  });

  it("stops with 'no_progress' when consecutive failures are identical", () => {
    const judge = makeJudge(false);
    const iterations = [
      makeIteration({ index: 0, judge }),
      makeIteration({ index: 1, judge: { ...judge, checks: [...judge.checks] } }),
    ];
    const result = decideStop(iterations, makeTask(), 0);
    expect(result.stop).toBe(true);
    expect(result.reason).toBe("no_progress");
  });

  it("continues when failures differ between iterations", () => {
    const iter1 = makeIteration({ index: 0, judge: makeJudge(false, "test") });
    // Second iteration fails differently
    const iter2 = makeIteration({
      index: 1,
      judge: {
        passed: false,
        checks: [{ name: "build", passed: false, output: "compile error xyz", exitCode: 1, durationMs: 100 }],
      },
    });
    const result = decideStop([iter1, iter2], makeTask(), 0);
    expect(result.stop).toBe(false);
  });

  it("continues when making progress (failures improve)", () => {
    const iter1 = makeIteration({
      index: 0,
      judge: {
        passed: false,
        checks: [
          { name: "test", passed: false, output: "3 failures", exitCode: 1, durationMs: 100 },
          { name: "build", passed: false, output: "compile error", exitCode: 1, durationMs: 100 },
        ],
      },
    });
    const iter2 = makeIteration({
      index: 1,
      judge: {
        passed: false,
        checks: [
          { name: "test", passed: false, output: "1 failure", exitCode: 1, durationMs: 100 },
          { name: "build", passed: true, output: "ok", exitCode: 0, durationMs: 100 },
        ],
      },
    });
    const result = decideStop([iter1, iter2], makeTask(), 0);
    expect(result.stop).toBe(false);
  });

  it("prioritizes 'passed' over budget check", () => {
    const task = makeTask({ maxBudgetUsd: 0.001 });
    const iterations = [makeIteration({ judge: makeJudge(true) })];
    const result = decideStop(iterations, task, 999);
    expect(result.stop).toBe(true);
    expect(result.reason).toBe("passed");
  });
});

describe("sameFailures", () => {
  it("returns true when same checks fail with same output", () => {
    const a: JudgeResult = {
      passed: false,
      checks: [{ name: "test", passed: false, output: "AssertionError: expected 3 got 2", exitCode: 1, durationMs: 100 }],
    };
    const b: JudgeResult = {
      passed: false,
      checks: [{ name: "test", passed: false, output: "AssertionError: expected 3 got 2", exitCode: 1, durationMs: 100 }],
    };
    expect(sameFailures(a, b)).toBe(true);
  });

  it("returns false when different checks fail", () => {
    const a: JudgeResult = {
      passed: false,
      checks: [{ name: "test", passed: false, output: "fail", exitCode: 1, durationMs: 100 }],
    };
    const b: JudgeResult = {
      passed: false,
      checks: [{ name: "build", passed: false, output: "fail", exitCode: 1, durationMs: 100 }],
    };
    expect(sameFailures(a, b)).toBe(false);
  });

  it("returns false when no failures in either (edge case)", () => {
    const a: JudgeResult = {
      passed: true,
      checks: [{ name: "test", passed: true, output: "ok", exitCode: 0, durationMs: 100 }],
    };
    const b: JudgeResult = {
      passed: true,
      checks: [{ name: "test", passed: true, output: "ok", exitCode: 0, durationMs: 100 }],
    };
    expect(sameFailures(a, b)).toBe(false);
  });

  it("returns false when failure output differs in tail", () => {
    const a: JudgeResult = {
      passed: false,
      checks: [{ name: "test", passed: false, output: "x".repeat(600) + "TAIL_A", exitCode: 1, durationMs: 100 }],
    };
    const b: JudgeResult = {
      passed: false,
      checks: [{ name: "test", passed: false, output: "x".repeat(600) + "TAIL_B", exitCode: 1, durationMs: 100 }],
    };
    expect(sameFailures(a, b)).toBe(false);
  });
});
