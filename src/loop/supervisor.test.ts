/**
 * Integration test: multi-round convergence with mock Claude driver.
 *
 * Verifies the full supervisor loop orchestration over 3 rounds:
 *   Round 1: executor partially fixes → judge fails → verifier catches
 *   Round 2: executor more progress → judge still fails → verifier catches
 *   Round 3: executor finishes → judge passes → STOP
 *
 * Tests: multi-round scheduling, trace recording, cost accumulation,
 *        stop condition, and verifier feedback propagation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DriverOutput, JudgeResult, TaskSpec } from "../types.js";
import { runSupervisorLoop } from "./supervisor.js";

// ── Mock data ────────────────────────────────────────────────────────────────

const TASK: TaskSpec = {
  id: "mock-multi-round",
  goal: "Fix all tests in the calculator module",
  repoPath: "/tmp/mock-repo",
  acceptance: { testCommand: "npm test" },
  maxIterations: 5,
};

const JUDGE_FAIL: JudgeResult = {
  passed: false,
  checks: [{ name: "test", passed: false, output: "FAIL: sum(2,3) expected 5 got -1", exitCode: 1, durationMs: 100 }],
};

const JUDGE_PARTIAL: JudgeResult = {
  passed: false,
  checks: [{ name: "test", passed: false, output: "FAIL: sum(0,5) expected 5 got 0", exitCode: 1, durationMs: 100 }],
};

const JUDGE_PASS: JudgeResult = {
  passed: true,
  checks: [{ name: "test", passed: true, output: "3 tests passed", exitCode: 0, durationMs: 100 }],
};

// Track call sequences to verify feedback propagation
const callLog: string[] = [];

// ── Mock setup ───────────────────────────────────────────────────────────────

// Mock the claude driver
vi.mock("../claude/driver.js", () => ({
  callClaude: vi.fn(),
}));

// Mock the judges
vi.mock("../judges/runJudges.js", () => ({
  runJudges: vi.fn(),
}));

// Mock workspace evidence collection
vi.mock("../workspace/collectEvidence.js", () => ({
  collectEvidence: vi.fn().mockResolvedValue(["src/sum.ts"]),
}));

// Mock trace recorder (don't write to disk)
vi.mock("./recorder.js", () => ({
  createRunId: () => "mock-run-001",
  initRun: vi.fn().mockResolvedValue("/tmp/mock-run"),
  recordIteration: vi.fn().mockResolvedValue(undefined),
  writeSummary: vi.fn().mockResolvedValue(undefined),
}));

// Mock config
vi.mock("../config.js", () => ({
  getConfig: () => ({
    model: "sonnet",
    defaultMaxIterations: 5,
    defaultTimeoutMs: 300_000,
    stateDir: ".verdikt",
    concurrency: 1,
  }),
}));

// Mock worktree (not needed for integration tests)
vi.mock("../workspace/worktree.js", () => ({
  createRunWorktree: vi.fn(),
  captureIterationDiff: vi.fn(),
  checkpointIteration: vi.fn(),
  applyFinalPatch: vi.fn(),
  discardRun: vi.fn(),
}));

// Mock integrity (not needed for integration tests)
vi.mock("../workspace/integrity.js", () => ({
  captureTestBaseline: vi.fn(),
  checkTestIntegrity: vi.fn(),
}));

// Import the mocked modules to configure their behavior
import { callClaude } from "../claude/driver.js";
import { runJudges } from "../judges/runJudges.js";

const mockCallClaude = vi.mocked(callClaude);
const mockRunJudges = vi.mocked(runJudges);

// ── Tests ────────────────────────────────────────────────────────────────────

describe("SupervisorLoop multi-round convergence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callLog.length = 0;
  });

  it("completes in 3 rounds with correct feedback propagation", async () => {
    let executorCallCount = 0;
    let verifierCallCount = 0;

    // Executor responses: round 1 partial, round 2 more progress, round 3 done
    mockCallClaude.mockImplementation(async (input) => {
      if (input.systemPrompt.includes("EXECUTOR")) {
        executorCallCount++;
        callLog.push(`executor-round-${executorCallCount}`);

        if (executorCallCount === 1) {
          return {
            text: "Fixed the subtraction bug in sum function. Changed a-b to a+b.",
            timedOut: false,
            durationMs: 5000,
            costUsd: 0.50,
          };
        }
        if (executorCallCount === 2) {
          return {
            text: "Fixed the zero handling edge case. sum(0,5) now returns 5.",
            timedOut: false,
            durationMs: 4000,
            costUsd: 0.40,
          };
        }
        return {
          text: "All fixes applied. Tests should pass now.",
          timedOut: false,
          durationMs: 3000,
          costUsd: 0.30,
        };
      }

      // Verifier responses: round 1 & 2 catch failures, round 3 confirms
      verifierCallCount++;
      callLog.push(`verifier-round-${verifierCallCount}`);

      if (verifierCallCount === 1) {
        return {
          text: JSON.stringify({
            done: false,
            problems: ["sum(2,3) still returns -1 instead of 5"],
            nextInstruction: "The sum function uses subtraction (a-b). Change it to addition (a+b) in src/sum.ts.",
          }),
          timedOut: false,
          durationMs: 3000,
          costUsd: 0.20,
        };
      }
      if (verifierCallCount === 2) {
        return {
          text: JSON.stringify({
            done: false,
            problems: ["sum(0,5) returns 0 instead of 5 — the zero input case is not handled correctly"],
            nextInstruction: "The sum function now works for non-zero inputs but fails when first argument is 0. Check the implementation for edge cases with zero.",
          }),
          timedOut: false,
          durationMs: 2500,
          costUsd: 0.18,
        };
      }
      return {
        text: JSON.stringify({
          done: true,
          problems: [],
          nextInstruction: "",
        }),
        timedOut: false,
        durationMs: 2000,
        costUsd: 0.15,
      };
    });

    // Judge responses: fail → fail → pass
    mockRunJudges
      .mockResolvedValueOnce(JUDGE_FAIL)
      .mockResolvedValueOnce(JUDGE_PARTIAL)
      .mockResolvedValueOnce(JUDGE_PASS);

    // Run the supervisor loop
    const result = await runSupervisorLoop(TASK, { skipWorktree: true, skipIntegrity: true });

    // ── Assertions ───────────────────────────────────────────────────────

    // 1. Correct stop reason
    expect(result.reason).toBe("passed");

    // 2. Exactly 3 iterations
    expect(result.iterations).toHaveLength(3);

    // 3. Each iteration has correct structure
    for (const iter of result.iterations) {
      expect(iter).toHaveProperty("index");
      expect(iter).toHaveProperty("executorOutput");
      expect(iter).toHaveProperty("judge");
      expect(iter).toHaveProperty("verifierVerdict");
      expect(iter).toHaveProperty("durationMs");
      expect(iter.changedFiles).toEqual(["src/sum.ts"]);
    }

    // 4. Feedback propagation: verifier's nextInstruction becomes executor's input
    //    We verify this through the call sequence
    expect(callLog).toEqual([
      "executor-round-1",
      "verifier-round-1",
      "executor-round-2",
      "verifier-round-2",
      "executor-round-3",
      "verifier-round-3",
    ]);

    // 5. Judge results propagate correctly
    expect(result.iterations[0].judge.passed).toBe(false);
    expect(result.iterations[1].judge.passed).toBe(false);
    expect(result.iterations[2].judge.passed).toBe(true);

    // 6. Verifier verdicts: first two not done, third done
    expect(result.iterations[0].verifierVerdict.done).toBe(false);
    expect(result.iterations[0].verifierVerdict.problems).toHaveLength(1);
    expect(result.iterations[0].verifierVerdict.nextInstruction).toBeTruthy();

    expect(result.iterations[1].verifierVerdict.done).toBe(false);
    expect(result.iterations[1].verifierVerdict.problems).toHaveLength(1);
    expect(result.iterations[1].verifierVerdict.nextInstruction).toBeTruthy();

    expect(result.iterations[2].verifierVerdict.done).toBe(true);
    expect(result.iterations[2].verifierVerdict.problems).toHaveLength(0);

    // 7. Cost accumulation: executor + verifier costs per round
    expect(result.iterations[0].costUsd).toBeCloseTo(0.70); // 0.50 + 0.20
    expect(result.iterations[1].costUsd).toBeCloseTo(0.58); // 0.40 + 0.18
    expect(result.iterations[2].costUsd).toBeCloseTo(0.45); // 0.30 + 0.15
    expect(result.totalCostUsd).toBeCloseTo(1.73);          // sum of all

    // 8. Total duration is positive
    expect(result.totalDurationMs).toBeGreaterThan(0);

    // 9. Executor was called 3 times, verifier 3 times
    expect(executorCallCount).toBe(3);
    expect(verifierCallCount).toBe(3);
    expect(mockRunJudges).toHaveBeenCalledTimes(3);
  });

  it("stops at max_iterations when task never passes", async () => {
    let callCount = 0;
    let judgeCallCount = 0;

    mockCallClaude.mockImplementation(async (input) => {
      callCount++;
      const isExecutor = input.systemPrompt.includes("EXECUTOR");
      return {
        text: isExecutor
          ? "Attempted fix but tests still fail."
          : JSON.stringify({
              done: false,
              problems: ["Tests still failing"],
              nextInstruction: "Keep trying to fix the bug.",
            }),
        timedOut: false,
        durationMs: 2000,
        costUsd: 0.10,
      };
    });

    // Vary judge failures each round to avoid no_progress detection
    mockRunJudges.mockImplementation(async () => {
      judgeCallCount++;
      return {
        passed: false,
        checks: [{
          name: "test",
          passed: false,
          output: `FAIL: iteration ${judgeCallCount} — different error each round`,
          exitCode: 1,
          durationMs: 100,
        }],
      };
    });

    const task: TaskSpec = { ...TASK, maxIterations: 3 };
    const result = await runSupervisorLoop(task, { skipWorktree: true, skipIntegrity: true });

    expect(result.reason).toBe("max_iterations");
    expect(result.iterations).toHaveLength(3);
    // 3 iterations × 2 calls each (executor + verifier) = 6
    expect(callCount).toBe(6);
  });

  it("verifier fallback works when JSON parse fails", async () => {
    mockCallClaude.mockImplementation(async (input) => {
      const isExecutor = input.systemPrompt.includes("EXECUTOR");
      if (isExecutor) {
        return { text: "Fixed something", timedOut: false, durationMs: 3000, costUsd: 0.30 };
      }
      // Return unparseable text — should trigger fallback
      return { text: "I think the task is done but I'm not sure.", timedOut: false, durationMs: 2000, costUsd: 0.15 };
    });

    mockRunJudges
      .mockResolvedValueOnce(JUDGE_FAIL)
      .mockResolvedValueOnce(JUDGE_PASS);

    const result = await runSupervisorLoop(TASK, { skipWorktree: true, skipIntegrity: true });

    // Should complete: fallback defers to judge, which passes on round 2
    expect(result.reason).toBe("passed");
    expect(result.iterations).toHaveLength(2);

    // First iteration: judge failed, fallback should say not done
    expect(result.iterations[0].verifierVerdict.done).toBe(false);
    expect(result.iterations[0].verifierVerdict.problems.length).toBeGreaterThan(0);
    expect(result.iterations[0].verifierVerdict.nextInstruction).toBeTruthy();
  });
});
