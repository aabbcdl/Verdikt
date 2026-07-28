/**
 * Tests for StopCondition — the four stop reason branches.
 */

import { describe, expect, it } from "vitest";
import type { IterationRecord, JudgeResult, TaskSpec } from "../types.js";
import { decideStop, sameFailures } from "./stopCondition.js";

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
    judge: {
      passed: false,
      checks: [{ name: "test", passed: false, output: "fail", exitCode: 1, durationMs: 100 }],
    },
    verifierVerdict: { done: false, problems: ["fail"], nextInstruction: "fix it" },
    durationMs: 1000,
    ...overrides,
  };
}

function makeJudge(passed: boolean, checkName = "test"): JudgeResult {
  return {
    passed,
    checks: [
      {
        name: checkName,
        passed,
        output: passed ? "ok" : "FAIL",
        exitCode: passed ? 0 : 1,
        durationMs: 100,
      },
    ],
  };
}

function makeJudgeWithOptionalFailure(): JudgeResult {
  return {
    passed: true,
    checks: [
      {
        name: "test",
        passed: true,
        output: "ok",
        exitCode: 0,
        durationMs: 100,
      },
      {
        name: "diagnostics",
        passed: false,
        output: "optional diagnostic failed",
        exitCode: 1,
        durationMs: 100,
      },
    ],
    stepResults: [
      {
        id: "test",
        passed: true,
        exitCode: 0,
        stdout: "ok",
        stderr: "",
        durationMs: 100,
        required: true,
      },
      {
        id: "diagnostics",
        passed: false,
        exitCode: 1,
        stdout: "",
        stderr: "optional diagnostic failed",
        durationMs: 100,
        required: false,
      },
    ],
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("decideStop", () => {
  it("returns stop=false when no iterations yet", () => {
    const result = decideStop([], makeTask(), 0);
    expect(result.stop).toBe(false);
  });

  it("stops with 'passed' when judge is all green and verifier confirms", () => {
    const iterations = [
      makeIteration({
        judge: makeJudge(true),
        verifierVerdict: { done: true, problems: [], nextInstruction: "" },
      }),
    ];
    const result = decideStop(iterations, makeTask(), 0);
    expect(result.stop).toBe(true);
    expect(result.reason).toBe("passed");
  });

  it("continues when judge passes but verifier still reports problems", () => {
    const iterations = [
      makeIteration({
        judge: makeJudge(true),
        verifierVerdict: {
          done: false,
          problems: ["The edge case is not covered yet"],
          nextInstruction: "Add the missing edge case and rerun checks.",
        },
      }),
    ];
    const result = decideStop(iterations, makeTask(), 0);
    expect(result.stop).toBe(false);
  });

  it("continues when verifier says done but still lists problems", () => {
    const iterations = [
      makeIteration({
        judge: makeJudge(true),
        verifierVerdict: {
          done: true,
          problems: ["The review is internally inconsistent"],
          nextInstruction: "Resolve the remaining review problem.",
        },
      }),
    ];
    const result = decideStop(iterations, makeTask(), 0);
    expect(result.stop).toBe(false);
  });

  it("continues when integrity has critical violations even if judge and verifier pass", () => {
    const iterations = [
      makeIteration({
        judge: makeJudge(true),
        verifierVerdict: { done: true, problems: [], nextInstruction: "" },
        integrity: {
          status: "violations",
          criticalCount: 1,
          warningCount: 0,
          issues: [{ rule: "test-file-modified", detail: "Test file was modified" }],
        },
      }),
    ];
    const result = decideStop(iterations, makeTask(), 0);
    expect(result.stop).toBe(false);
  });

  it("stops with 'max_iterations' when iteration count reached", () => {
    const task = makeTask({ maxIterations: 2 });
    const iterations = [makeIteration({ index: 0 }), makeIteration({ index: 1 })];
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

  it("continues after two identical failures to allow verifier feedback another round", () => {
    const judge = makeJudge(false);
    const iterations = [
      makeIteration({ index: 0, judge }),
      makeIteration({ index: 1, judge: { ...judge, checks: [...judge.checks] } }),
    ];
    const result = decideStop(iterations, makeTask(), 0);
    expect(result.stop).toBe(false);
  });

  it("stops with 'no_progress' after three identical failures", () => {
    const judge = makeJudge(false);
    const iterations = [
      makeIteration({ index: 0, judge }),
      makeIteration({ index: 1, judge: { ...judge, checks: [...judge.checks] } }),
      makeIteration({ index: 2, judge: { ...judge, checks: [...judge.checks] } }),
    ];
    const result = decideStop(iterations, makeTask(), 0);
    expect(result.stop).toBe(true);
    expect(result.reason).toBe("no_progress");
  });

  it("stops with 'no_progress' after three identical verifier objections", () => {
    const judge = makeJudge(true);
    const verdict = {
      done: false,
      problems: ["The empty state is still not handled"],
      nextInstruction: "Handle the empty state before finishing.",
    };
    const iterations = [
      makeIteration({ index: 0, judge, verifierVerdict: verdict }),
      makeIteration({
        index: 1,
        judge: { ...judge, checks: [...judge.checks] },
        verifierVerdict: verdict,
      }),
      makeIteration({
        index: 2,
        judge: { ...judge, checks: [...judge.checks] },
        verifierVerdict: verdict,
      }),
    ];

    const result = decideStop(iterations, makeTask(), 0);

    expect(result.stop).toBe(true);
    expect(result.reason).toBe("no_progress");
  });

  it("does not stop for repeated optional structured step failures when verifier feedback changes", () => {
    const judge = makeJudgeWithOptionalFailure();
    const iterations = [
      makeIteration({
        index: 0,
        judge,
        verifierVerdict: {
          done: false,
          problems: ["The empty state is still not handled"],
          nextInstruction: "Handle empty state.",
        },
      }),
      makeIteration({
        index: 1,
        judge: { ...judge, checks: [...judge.checks], stepResults: [...(judge.stepResults ?? [])] },
        verifierVerdict: {
          done: false,
          problems: ["The loading state is still not handled"],
          nextInstruction: "Handle loading state.",
        },
      }),
      makeIteration({
        index: 2,
        judge: { ...judge, checks: [...judge.checks], stepResults: [...(judge.stepResults ?? [])] },
        verifierVerdict: {
          done: false,
          problems: ["The error state is still not handled"],
          nextInstruction: "Handle error state.",
        },
      }),
    ];

    const result = decideStop(iterations, makeTask(), 0);

    expect(result.stop).toBe(false);
  });

  it("continues when failures differ between iterations", () => {
    const iter1 = makeIteration({ index: 0, judge: makeJudge(false, "test") });
    // Second iteration fails differently
    const iter2 = makeIteration({
      index: 1,
      judge: {
        passed: false,
        checks: [
          {
            name: "build",
            passed: false,
            output: "compile error xyz",
            exitCode: 1,
            durationMs: 100,
          },
        ],
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
    const iterations = [
      makeIteration({
        judge: makeJudge(true),
        verifierVerdict: { done: true, problems: [], nextInstruction: "" },
      }),
    ];
    const result = decideStop(iterations, task, 999);
    expect(result.stop).toBe(true);
    expect(result.reason).toBe("passed");
  });
});

describe("sameFailures", () => {
  it("returns true when same checks fail with same output", () => {
    const a: JudgeResult = {
      passed: false,
      checks: [
        {
          name: "test",
          passed: false,
          output: "AssertionError: expected 3 got 2",
          exitCode: 1,
          durationMs: 100,
        },
      ],
    };
    const b: JudgeResult = {
      passed: false,
      checks: [
        {
          name: "test",
          passed: false,
          output: "AssertionError: expected 3 got 2",
          exitCode: 1,
          durationMs: 100,
        },
      ],
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
      checks: [
        {
          name: "test",
          passed: false,
          output: `${"x".repeat(600)}TAIL_A`,
          exitCode: 1,
          durationMs: 100,
        },
      ],
    };
    const b: JudgeResult = {
      passed: false,
      checks: [
        {
          name: "test",
          passed: false,
          output: `${"x".repeat(600)}TAIL_B`,
          exitCode: 1,
          durationMs: 100,
        },
      ],
    };
    expect(sameFailures(a, b)).toBe(false);
  });
});
