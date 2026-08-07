import { describe, expect, it } from "vitest";
import type { JudgeResult, TaskSpec, VerifierVerdict } from "../types.js";
import {
  advanceStage,
  createStageRuntime,
  getActiveStage,
  isStageComplete,
  stageLimitFailure,
} from "./stagePlan.js";

const JUDGE_PASS: JudgeResult = { passed: true, checks: [] };
const JUDGE_FAIL: JudgeResult = {
  passed: false,
  checks: [{ name: "test", passed: false, output: "failed", exitCode: 1, durationMs: 1 }],
};
const DONE: VerifierVerdict = { done: true, problems: [], nextInstruction: "" };

const TASK: TaskSpec = {
  id: "staged",
  goal: "Ship a fix",
  repoPath: "/repo",
  acceptance: { steps: [{ id: "test", command: "npm", args: ["test"] }] },
  maxIterations: 8,
  stages: [
    { id: "diagnose", title: "Diagnose", goal: "Identify the root cause", maxIterations: 2 },
    {
      id: "fix",
      title: "Fix",
      goal: "Implement the correction",
      acceptance: { steps: [{ id: "unit", command: "npm", args: ["test"] }] },
      maxIterations: 3,
    },
    { id: "verify", title: "Verify", goal: "Pass final acceptance" },
  ],
};

describe("stage plan", () => {
  it("keeps the current stage until its completion rule passes", () => {
    const runtime = createStageRuntime(TASK);
    expect(getActiveStage(TASK, runtime)?.id).toBe("diagnose");
    expect(
      isStageComplete({
        task: TASK,
        runtime,
        judge: JUDGE_FAIL,
        verdict: { ...DONE, done: false },
      }),
    ).toBe(false);
    expect(getActiveStage(TASK, runtime)?.id).toBe("diagnose");
  });

  it("allows a reviewed non-final stage to complete even while final tests still fail", () => {
    const runtime = createStageRuntime(TASK);
    expect(isStageComplete({ task: TASK, runtime, judge: JUDGE_FAIL, verdict: DONE })).toBe(true);
    expect(getActiveStage(TASK, advanceStage(TASK, runtime))?.id).toBe("fix");
  });

  it("requires objective acceptance for a stage with its own acceptance commands", () => {
    const runtime = { ...createStageRuntime(TASK), stageIndex: 1 };
    expect(isStageComplete({ task: TASK, runtime, judge: JUDGE_FAIL, verdict: DONE })).toBe(false);
    expect(isStageComplete({ task: TASK, runtime, judge: JUDGE_PASS, verdict: DONE })).toBe(true);
  });

  it("requires final acceptance for the final stage", () => {
    const runtime = { ...createStageRuntime(TASK), stageIndex: 2 };
    expect(isStageComplete({ task: TASK, runtime, judge: JUDGE_FAIL, verdict: DONE })).toBe(false);
    expect(isStageComplete({ task: TASK, runtime, judge: JUDGE_PASS, verdict: DONE })).toBe(true);
  });

  it("reports stage iteration limits and cost stop targets without silently advancing", () => {
    const iterationLimited = { ...createStageRuntime(TASK), stageIteration: 2 };
    expect(stageLimitFailure(TASK, iterationLimited)).toContain("iteration");

    const budgetTask: TaskSpec = {
      ...TASK,
      stages: [{ id: "one", title: "One", goal: "One", maxBudgetUsd: 1 }],
    };
    expect(
      stageLimitFailure(budgetTask, { ...createStageRuntime(budgetTask), stageCostUsd: 1.1 }),
    ).toContain("cost stop target");
  });
});
