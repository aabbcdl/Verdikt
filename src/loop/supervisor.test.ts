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

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { rejectRequest } from "../approval/store.js";
import { readRunEvents } from "../trace/events.js";
import { queueRunNote, readRunNotes } from "../trace/notes.js";
import type { DriverOutput, JudgeResult, TaskSpec } from "../types.js";
import { resumeSupervisorLoop, runSupervisorLoop } from "./supervisor.js";

const { TEST_STATE_DIR } = vi.hoisted(() => ({
  TEST_STATE_DIR: `${process.env.TMPDIR ?? process.env.TEMP ?? "/tmp"}/verdikt-supervisor-tests-${process.pid}`,
}));

// ── Mock data ────────────────────────────────────────────────────────────────

const TASK: TaskSpec = {
  id: "mock-multi-round",
  goal: "Fix all tests in the calculator module",
  repoPath: "/tmp/mock-repo",
  acceptance: { testCommand: "npm test" },
  maxIterations: 5,
  runSource: "test",
};

const RESUME_TASK: TaskSpec = {
  ...TASK,
  repoPath: "/tmp/original-repo",
  maxIterations: 2,
};

const JUDGE_FAIL: JudgeResult = {
  passed: false,
  checks: [
    {
      name: "test",
      passed: false,
      output: "FAIL: sum(2,3) expected 5 got -1",
      exitCode: 1,
      durationMs: 100,
    },
  ],
};

const JUDGE_PARTIAL: JudgeResult = {
  passed: false,
  checks: [
    {
      name: "test",
      passed: false,
      output: "FAIL: sum(0,5) expected 5 got 0",
      exitCode: 1,
      durationMs: 100,
    },
  ],
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

vi.mock("../evidence/manifest.js", () => ({
  createEvidenceManifest: vi.fn().mockResolvedValue({ version: 1, files: [] }),
}));

// Mock the judges
vi.mock("../judges/runJudges.js", () => ({
  runJudges: vi.fn(),
}));

// Mock workspace evidence collection
vi.mock("../workspace/collectEvidence.js", () => ({
  collectEvidence: vi.fn().mockResolvedValue(["src/sum.ts"]),
}));

vi.mock("../workspace/applyPatch.js", () => ({
  applyProtectedPatch: vi.fn().mockResolvedValue(undefined),
}));

// Mock expensive recorder writes, but keep initRun real so run directories exist.
vi.mock("../trace/recorder.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../trace/recorder.js")>();
  return {
    ...actual,
    createRunId: () => "mock-run-001",
    recordIteration: vi.fn().mockResolvedValue(undefined),
    writeSummary: vi.fn().mockResolvedValue(undefined),
    clearRunState: vi.fn().mockResolvedValue(undefined),
    loadRunState: vi.fn().mockResolvedValue(null),
    loadRecordedIterations: vi.fn().mockResolvedValue([]),
    validateResumeState: vi.fn().mockResolvedValue({ valid: true }),
    saveRunState: vi.fn().mockResolvedValue(undefined),
  };
});

// Mock config
vi.mock("../config.js", () => ({
  getConfig: () => ({
    model: "sonnet",
    defaultMaxIterations: 5,
    defaultTimeoutMs: 300_000,
    stateDir: TEST_STATE_DIR,
    concurrency: 1,
  }),
}));

// Mock worktree (not needed for integration tests)
vi.mock("../workspace/worktree.js", () => ({
  createRunWorktree: vi.fn(),
  captureIterationDiff: vi.fn().mockResolvedValue({
    patchPath: "/tmp/saved-run/evidence/iteration.patch",
    changedFiles: ["src/sum.ts"],
    linesAdded: 1,
    linesDeleted: 1,
  }),
  checkpointIteration: vi.fn().mockResolvedValue("def456"),
  discardRun: vi.fn(),
  writeFinalPatch: vi.fn(),
  getHeadCommit: vi.fn().mockResolvedValue("def456"),
}));

// Mock integrity (not needed for integration tests)
vi.mock("../workspace/integrity.js", () => ({
  captureTestBaseline: vi.fn(),
  checkTestIntegrity: vi.fn(),
  loadTestBaseline: vi.fn(),
  saveTestBaseline: vi.fn(),
}));

// Import the mocked modules to configure their behavior
import { callClaude } from "../claude/driver.js";
import { runJudges } from "../judges/runJudges.js";
import {
  loadRecordedIterations,
  loadRunState,
  saveRunState,
  validateResumeState,
  writeSummary,
} from "../trace/recorder.js";
import { applyProtectedPatch } from "../workspace/applyPatch.js";
import {
  captureTestBaseline,
  checkTestIntegrity,
  loadTestBaseline,
  saveTestBaseline,
} from "../workspace/integrity.js";
import { acquireLock, checkLock, releaseLock } from "../workspace/lock.js";
import { createRunWorktree, discardRun, writeFinalPatch } from "../workspace/worktree.js";

const mockCallClaude = vi.mocked(callClaude);
const mockRunJudges = vi.mocked(runJudges);
const mockLoadRunState = vi.mocked(loadRunState);
const mockLoadRecordedIterations = vi.mocked(loadRecordedIterations);
const mockValidateResumeState = vi.mocked(validateResumeState);
const mockSaveRunState = vi.mocked(saveRunState);
const mockWriteSummary = vi.mocked(writeSummary);
const mockCaptureTestBaseline = vi.mocked(captureTestBaseline);
const mockCheckTestIntegrity = vi.mocked(checkTestIntegrity);
const mockLoadTestBaseline = vi.mocked(loadTestBaseline);
const mockSaveTestBaseline = vi.mocked(saveTestBaseline);
const mockWriteFinalPatch = vi.mocked(writeFinalPatch);
const mockCreateRunWorktree = vi.mocked(createRunWorktree);
const mockApplyProtectedPatch = vi.mocked(applyProtectedPatch);
const mockDiscardRun = vi.mocked(discardRun);

// ── Tests ────────────────────────────────────────────────────────────────────

describe("SupervisorLoop multi-round convergence", () => {
  beforeEach(async () => {
    await rm(TEST_STATE_DIR, { recursive: true, force: true });
    await mkdir(TEST_STATE_DIR, { recursive: true });
    mockCallClaude.mockReset();
    mockRunJudges.mockReset();
    mockLoadRunState.mockReset();
    mockLoadRecordedIterations.mockReset();
    mockValidateResumeState.mockReset();
    mockSaveRunState.mockClear();
    mockWriteSummary.mockClear();
    mockCaptureTestBaseline.mockReset();
    mockCheckTestIntegrity.mockReset();
    mockLoadTestBaseline.mockReset();
    mockSaveTestBaseline.mockReset();
    mockApplyProtectedPatch.mockReset();
    mockDiscardRun.mockReset();
    mockCaptureTestBaseline.mockResolvedValue({
      fileHashes: new Map(),
      assertionCounts: new Map(),
      configHashes: new Map(),
    });
    mockCheckTestIntegrity.mockResolvedValue({ passed: true, violations: [] });
    mockLoadTestBaseline.mockResolvedValue({
      fileHashes: new Map(),
      assertionCounts: new Map(),
      configHashes: new Map(),
    });
    mockSaveTestBaseline.mockResolvedValue(undefined);
    mockWriteFinalPatch.mockReset();
    // Faithful to the real contract: writeFinalPatch streams the diff to outputPath.
    mockWriteFinalPatch.mockImplementation(async (_worktreePath, _baseCommit, outputPath) => {
      await writeFile(outputPath, "diff --git a/src/sum.ts b/src/sum.ts\n", "utf-8");
    });
    mockApplyProtectedPatch.mockResolvedValue(undefined);
    mockCreateRunWorktree.mockResolvedValue({
      worktreePath: join(TEST_STATE_DIR, "mock-worktree"),
      branchName: "verdikt/mock-run-001",
      baseCommit: "abc123",
      evidenceDir: join(TEST_STATE_DIR, "mock-run", "evidence"),
    });
    callLog.length = 0;
    mockLoadRunState.mockResolvedValue(null);
    mockLoadRecordedIterations.mockResolvedValue([]);
    mockValidateResumeState.mockResolvedValue({ valid: true });
    mockDiscardRun.mockResolvedValue(undefined);
  });

  it("creates a read-only plan and waits for confirmation before execution", async () => {
    const runId = "mock-plan-required";
    const runDir = join(TEST_STATE_DIR, runId);
    mockCallClaude.mockResolvedValue({
      text: "# Plan\n1. Inspect the calculator.\n2. Fix the implementation.\n3. Run tests.",
      timedOut: false,
      durationMs: 20,
      costUsd: 0.1,
      usage: { status: "complete", costUsd: 0.1 },
    });

    try {
      const result = await runSupervisorLoop(
        { ...TASK, planning: { mode: "required", requireApproval: true } },
        { runId, skipWorktree: true, skipIntegrity: true, stream: false },
      );

      expect(result.reason).toBe("approval_required");
      expect(result.approvalRequest?.stageId).toBe("__plan__");
      expect(mockRunJudges).not.toHaveBeenCalled();
      expect(mockCallClaude).toHaveBeenCalledOnce();
      expect(mockCallClaude.mock.calls[0][0].allowedTools).toEqual(["Read", "Glob", "Grep"]);
      expect(await readFile(join(runDir, "plan.md"), "utf-8")).toContain("Inspect the calculator");
      const eventTypes = (await readRunEvents(runDir)).map((event) => event.type);
      expect(eventTypes).toEqual(
        expect.arrayContaining([
          "workspace_ready",
          "plan_started",
          "plan_completed",
          "approval_requested",
        ]),
      );
      expect(mockSaveRunState).toHaveBeenLastCalledWith(
        expect.stringContaining(runId),
        expect.objectContaining({
          phase: "waiting_approval",
          instruction: expect.stringContaining("Implementation plan"),
        }),
      );
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
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
            costUsd: 0.5,
          };
        }
        if (executorCallCount === 2) {
          return {
            text: "Fixed the zero handling edge case. sum(0,5) now returns 5.",
            timedOut: false,
            durationMs: 4000,
            costUsd: 0.4,
          };
        }
        return {
          text: "All fixes applied. Tests should pass now.",
          timedOut: false,
          durationMs: 3000,
          costUsd: 0.3,
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
            nextInstruction:
              "The sum function uses subtraction (a-b). Change it to addition (a+b) in src/sum.ts.",
          }),
          timedOut: false,
          durationMs: 3000,
          costUsd: 0.2,
        };
      }
      if (verifierCallCount === 2) {
        return {
          text: JSON.stringify({
            done: false,
            problems: [
              "sum(0,5) returns 0 instead of 5 — the zero input case is not handled correctly",
            ],
            nextInstruction:
              "The sum function now works for non-zero inputs but fails when first argument is 0. Check the implementation for edge cases with zero.",
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
    expect(result.iterations[0].costUsd).toBeCloseTo(0.7); // 0.50 + 0.20
    expect(result.iterations[1].costUsd).toBeCloseTo(0.58); // 0.40 + 0.18
    expect(result.iterations[2].costUsd).toBeCloseTo(0.45); // 0.30 + 0.15
    expect(result.totalCostUsd).toBeCloseTo(1.73); // sum of all

    // 8. Total duration is positive
    expect(result.totalDurationMs).toBeGreaterThan(0);

    // 9. Executor was called 3 times, verifier 3 times
    expect(executorCallCount).toBe(3);
    expect(verifierCallCount).toBe(3);
    expect(mockRunJudges).toHaveBeenCalledTimes(3);
  });

  it("emits live progress messages through the log callback", async () => {
    mockCallClaude.mockImplementation(async (input) => {
      if (input.systemPrompt.includes("EXECUTOR")) {
        return {
          text: "Fixed the issue.",
          timedOut: false,
          durationMs: 100,
          costUsd: 0.01,
        };
      }

      return {
        text: JSON.stringify({ done: true, problems: [], nextInstruction: "" }),
        timedOut: false,
        durationMs: 100,
        costUsd: 0.01,
      };
    });
    mockRunJudges.mockResolvedValueOnce(JUDGE_PASS);

    const messages: string[] = [];
    const options = {
      skipWorktree: true,
      skipIntegrity: true,
      onLog: (message: string) => messages.push(message),
    };

    await runSupervisorLoop(TASK, options);

    const logText = messages.join("\n");
    expect(logText).toContain("Executor running");
    expect(logText).toContain("Judges running");
    expect(logText).toContain("Verifier running");
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
        costUsd: 0.1,
      };
    });

    // Vary judge failures each round to avoid no_progress detection
    mockRunJudges.mockImplementation(async () => {
      judgeCallCount++;
      return {
        passed: false,
        checks: [
          {
            name: "test",
            passed: false,
            output: `FAIL: iteration ${judgeCallCount} — different error each round`,
            exitCode: 1,
            durationMs: 100,
          },
        ],
      };
    });

    const task: TaskSpec = { ...TASK, maxIterations: 3 };
    const result = await runSupervisorLoop(task, { skipWorktree: true, skipIntegrity: true });

    expect(result.reason).toBe("max_iterations");
    expect(result.iterations).toHaveLength(3);
    // 3 iterations × 2 calls each (executor + verifier) = 6
    expect(callCount).toBe(6);
  });

  it("does not pass when verifier output is malformed even after judges pass", async () => {
    mockCallClaude.mockImplementation(async (input) => {
      const isExecutor = input.systemPrompt.includes("EXECUTOR");
      if (isExecutor) {
        return { text: "Fixed something", timedOut: false, durationMs: 3000, costUsd: 0.3 };
      }
      // Return unparseable text — should trigger fallback
      return {
        text: "I think the task is done but I'm not sure.",
        timedOut: false,
        durationMs: 2000,
        costUsd: 0.15,
      };
    });

    mockRunJudges.mockResolvedValueOnce(JUDGE_FAIL).mockResolvedValue(JUDGE_PASS);

    const task: TaskSpec = { ...TASK, maxIterations: 3 };
    const result = await runSupervisorLoop(task, { skipWorktree: true, skipIntegrity: true });

    expect(result.reason).toBe("max_iterations");
    expect(result.iterations).toHaveLength(3);

    // First iteration: judge failed, fallback should say not done
    expect(result.iterations[0].verifierVerdict.done).toBe(false);
    expect(result.iterations[0].verifierVerdict.problems.length).toBeGreaterThan(0);
    expect(result.iterations[0].verifierVerdict.nextInstruction).toBeTruthy();

    // Later iterations: judge passed, but malformed verifier output is not a review confirmation.
    expect(result.iterations[1].judge.passed).toBe(true);
    expect(result.iterations[1].verifierVerdict.done).toBe(false);
    expect(result.iterations[1].verifierVerdict.problems).toContain(
      "Verifier output could not be parsed",
    );
  });

  it("continues when judges pass but verifier still reports review problems", async () => {
    let executorCallCount = 0;
    let verifierCallCount = 0;

    mockCallClaude.mockImplementation(async (input) => {
      if (input.systemPrompt.includes("EXECUTOR")) {
        executorCallCount++;
        return {
          text:
            executorCallCount === 1
              ? "Tests pass, but I did not address the empty input case."
              : "Handled the empty input case and reran tests.",
          timedOut: false,
          durationMs: 100,
          costUsd: 0.01,
        };
      }

      verifierCallCount++;
      if (verifierCallCount === 1) {
        return {
          text: JSON.stringify({
            done: false,
            problems: ["The empty input acceptance point is still missing."],
            nextInstruction: "Handle the empty input acceptance point, then rerun the checks.",
          }),
          timedOut: false,
          durationMs: 100,
          costUsd: 0.01,
        };
      }

      return {
        text: JSON.stringify({ done: true, problems: [], nextInstruction: "" }),
        timedOut: false,
        durationMs: 100,
        costUsd: 0.01,
      };
    });

    mockRunJudges.mockResolvedValue(JUDGE_PASS);

    const result = await runSupervisorLoop(TASK, { skipWorktree: true, skipIntegrity: true });

    expect(result.reason).toBe("passed");
    expect(result.iterations).toHaveLength(2);
    expect(executorCallCount).toBe(2);
    expect(verifierCallCount).toBe(2);
    expect(result.iterations[0].verifierVerdict.done).toBe(false);
    expect(result.iterations[1].verifierVerdict.done).toBe(true);
  });

  it("does not pass when integrity has critical violations even if judges and verifier pass", async () => {
    mockCheckTestIntegrity.mockResolvedValue({
      passed: false,
      violations: [
        {
          severity: "warning",
          rule: "suspicious-file-changed",
          file: "scripts/check.ts",
          detail: "Suspicious file changed: scripts/check.ts",
        },
        {
          severity: "critical",
          rule: "test-file-modified",
          file: "test/sum.test.ts",
          detail: "Test file was modified: test/sum.test.ts",
        },
      ],
    });

    mockCallClaude.mockImplementation(async (input) => {
      if (input.systemPrompt.includes("EXECUTOR")) {
        return {
          text: "Changed the tests and made the command pass.",
          timedOut: false,
          durationMs: 100,
          costUsd: 0.01,
        };
      }

      return {
        text: JSON.stringify({ done: true, problems: [], nextInstruction: "" }),
        timedOut: false,
        durationMs: 100,
        costUsd: 0.01,
      };
    });
    mockRunJudges.mockResolvedValueOnce(JUDGE_PASS);

    const result = await runSupervisorLoop(
      { ...TASK, maxIterations: 1 },
      { skipWorktree: true, skipIntegrity: false },
    );

    expect(result.reason).toBe("max_iterations");
    expect(result.integritySummary).toEqual({
      status: "violations",
      criticalCount: 1,
      warningCount: 1,
      issues: [
        {
          severity: "warning",
          rule: "suspicious-file-changed",
          detail: "Suspicious file changed: scripts/check.ts",
        },
        {
          severity: "critical",
          rule: "test-file-modified",
          detail: "Test file was modified: test/sum.test.ts",
        },
      ],
    });
    expect(result.iterations[0].judge.passed).toBe(false);
    expect(
      result.iterations[0].judge.checks.some(
        (c) => c.name === "integrity" && !c.passed && c.output.includes("test-file-modified"),
      ),
    ).toBe(true);
    expect(result.iterations[0].verifierVerdict.done).toBe(false);
  });

  it("stops as no_progress when verifier repeats the same objection despite passing judges", async () => {
    mockCallClaude.mockImplementation(async (input) => {
      if (input.systemPrompt.includes("EXECUTOR")) {
        return {
          text: "Reran checks; they pass.",
          timedOut: false,
          durationMs: 100,
          costUsd: 0.01,
        };
      }

      return {
        text: JSON.stringify({
          done: false,
          problems: ["The empty state is still not handled."],
          nextInstruction: "Handle the empty state before finishing.",
        }),
        timedOut: false,
        durationMs: 100,
        costUsd: 0.01,
      };
    });

    mockRunJudges.mockResolvedValue(JUDGE_PASS);

    const result = await runSupervisorLoop(TASK, {
      skipWorktree: true,
      skipIntegrity: true,
    });

    expect(result.reason).toBe("no_progress");
    expect(result.iterations).toHaveLength(3);
  });

  it("uses a caller-provided run id for externally tracked runs", async () => {
    mockCallClaude.mockResolvedValue({
      text: JSON.stringify({ done: true, problems: [], nextInstruction: "" }),
      timedOut: false,
      durationMs: 100,
      costUsd: 0.01,
    } satisfies DriverOutput);
    mockRunJudges.mockResolvedValueOnce(JUDGE_PASS);

    const result = await runSupervisorLoop(TASK, {
      skipWorktree: true,
      skipIntegrity: true,
      runId: "ui-run-001",
    });

    expect(result.runId).toBe("ui-run-001");
  });

  it("returns a cancelled result when the caller aborts the run", async () => {
    const controller = new AbortController();
    mockCallClaude.mockImplementationOnce(async (input) => {
      controller.abort();
      expect(input.signal?.aborted).toBe(true);
      return {
        text: "[CANCELLED] Claude Code run cancelled",
        timedOut: false,
        durationMs: 10,
        costUsd: 0,
      };
    });

    const result = await runSupervisorLoop(TASK, {
      skipWorktree: true,
      skipIntegrity: true,
      runId: "cancelled-run-001",
      signal: controller.signal,
    });

    expect(result.reason).toBe("cancelled");
    expect(result.runId).toBe("cancelled-run-001");
    expect(result.iterations).toHaveLength(0);
    expect(mockRunJudges).not.toHaveBeenCalled();
    expect(mockWriteSummary).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ reason: "cancelled", runId: "cancelled-run-001" }),
    );
  });

  it("preserves resumable state when the app shuts down", async () => {
    const controller = new AbortController();
    mockCallClaude.mockImplementationOnce(async () => {
      controller.abort("app_shutdown");
      return {
        text: "[INTERRUPTED] App is shutting down",
        timedOut: false,
        durationMs: 10,
        costUsd: 0,
      };
    });

    const result = await runSupervisorLoop(TASK, {
      skipWorktree: false,
      skipIntegrity: true,
      runId: "interrupted-run-001",
      signal: controller.signal,
    });

    expect(result.reason).toBe("interrupted");
    expect(result.applyStatus).toBe("pending");
    expect(mockSaveRunState).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ phase: "interrupted" }),
    );
    expect(mockWriteSummary).toHaveBeenCalledWith(
      expect.stringContaining("interrupted-run-001"),
      expect.objectContaining({ reason: "interrupted", resumable: true, applyStatus: "pending" }),
    );
    expect(mockDiscardRun).not.toHaveBeenCalled();
  });

  it("does not write a passed summary before the final patch is saved", async () => {
    mockCallClaude.mockResolvedValue({
      text: JSON.stringify({ done: true, problems: [], nextInstruction: "" }),
      timedOut: false,
      durationMs: 100,
      costUsd: 0.01,
    } satisfies DriverOutput);
    mockRunJudges.mockResolvedValueOnce(JUDGE_PASS);
    mockWriteFinalPatch.mockRejectedValueOnce(new Error("diff failed"));

    await expect(
      runSupervisorLoop(TASK, { skipWorktree: false, skipIntegrity: true }),
    ).rejects.toThrow("diff failed");

    expect(mockWriteSummary).not.toHaveBeenCalled();
  });

  it("releases the repository lock when isolated workspace creation fails", async () => {
    const repoPath = "/tmp/worktree-create-failure-repo";
    releaseLock(TEST_STATE_DIR, repoPath);
    mockCreateRunWorktree.mockRejectedValueOnce(new Error("worktree add failed"));

    await expect(
      runSupervisorLoop(
        { ...TASK, repoPath, maxIterations: 1 },
        { skipWorktree: false, skipIntegrity: true, runId: "worktree-fail-run" },
      ),
    ).rejects.toThrow("worktree add failed");

    expect(checkLock(TEST_STATE_DIR, repoPath)).toBeNull();
  });

  it("records final patch line counts from captured iteration diffs", async () => {
    mockCallClaude.mockResolvedValue({
      text: JSON.stringify({ done: true, problems: [], nextInstruction: "" }),
      timedOut: false,
      durationMs: 100,
      costUsd: 0.01,
    } satisfies DriverOutput);
    mockRunJudges.mockResolvedValueOnce(JUDGE_PASS);

    const result = await runSupervisorLoop(TASK, { skipWorktree: false, skipIntegrity: true });

    expect(result.reason).toBe("passed");
    expect(result.patch?.linesAdded).toBe(1);
    expect(result.patch?.linesDeleted).toBe(1);
    expect(mockWriteSummary).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        patch: expect.objectContaining({ linesAdded: 1, linesDeleted: 1 }),
      }),
    );
  });

  it("records auto-applied runs as applied instead of pending", async () => {
    mockCallClaude.mockResolvedValue({
      text: JSON.stringify({ done: true, problems: [], nextInstruction: "" }),
      timedOut: false,
      durationMs: 100,
      costUsd: 0.01,
    } satisfies DriverOutput);
    mockRunJudges.mockResolvedValueOnce(JUDGE_PASS);

    const result = await runSupervisorLoop(TASK, {
      skipWorktree: false,
      skipIntegrity: true,
      autoApply: true,
    });

    expect(mockApplyProtectedPatch).toHaveBeenCalledOnce();
    expect(result.reason).toBe("passed");
    expect(result.applyStatus).toBe("applied");
    expect(mockWriteSummary).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ reason: "passed", applyStatus: "applied" }),
    );
  });

  it("resumes isolated runs inside the saved worktree instead of the original repository", async () => {
    const savedRunDir = join(TEST_STATE_DIR, "saved-run");
    const savedWorktreeDir = join(TEST_STATE_DIR, "saved-worktree");
    mockLoadRunState.mockResolvedValueOnce({
      task: RESUME_TASK,
      instruction: "Continue from saved verifier feedback",
      nextIteration: 1,
      totalCostUsd: 0,
      totalDurationMs: 0,
      lastSavedAt: "2026-01-01T00:00:00Z",
      useWorktree: true,
      useIntegrity: false,
      worktree: {
        worktreePath: savedWorktreeDir,
        branchName: "verdikt/saved-run",
        baseCommit: "abc123",
        evidenceDir: join(savedRunDir, "evidence"),
      },
    });

    mockCallClaude.mockResolvedValue({
      text: JSON.stringify({ done: true, problems: [], nextInstruction: "" }),
      timedOut: false,
      durationMs: 100,
      costUsd: 0.01,
    } satisfies DriverOutput);
    mockRunJudges.mockResolvedValueOnce(JUDGE_PASS);

    const result = await runSupervisorLoop(RESUME_TASK, {
      resumeFrom: savedRunDir,
      skipIntegrity: true,
    });

    expect(result.reason).toBe("passed");
    expect(mockCallClaude).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: savedWorktreeDir }),
      expect.anything(),
    );
    expect(mockRunJudges).toHaveBeenCalledWith(RESUME_TASK.acceptance, savedWorktreeDir, undefined);
    expect(result.workspace?.path).toBe(savedWorktreeDir);
  });

  it("refuses to resume an integrity-enabled run when its original baseline is missing", async () => {
    const savedRunDir = join(TEST_STATE_DIR, "missing-integrity-baseline");
    mockLoadRunState.mockResolvedValueOnce({
      task: { ...RESUME_TASK, id: "missing-integrity-baseline", maxIterations: 1 },
      instruction: "continue",
      nextIteration: 0,
      totalCostUsd: 0,
      totalDurationMs: 0,
      lastSavedAt: "2026-07-18T00:00:00Z",
      useWorktree: false,
      useIntegrity: true,
    });
    mockLoadTestBaseline.mockResolvedValueOnce(null);

    await expect(resumeSupervisorLoop(savedRunDir, { skipIntegrity: true })).rejects.toThrow(
      "integrity-baseline.json is missing or unreadable",
    );
    expect(mockCallClaude).not.toHaveBeenCalled();
    expect(mockCaptureTestBaseline).not.toHaveBeenCalled();
  });

  it("uses the saved integrity setting during resume even when the caller tries to skip it", async () => {
    const savedRunDir = join(TEST_STATE_DIR, "saved-integrity-setting");
    mockLoadRunState.mockResolvedValueOnce({
      task: { ...RESUME_TASK, id: "saved-integrity-setting", maxIterations: 1 },
      instruction: "continue",
      nextIteration: 0,
      totalCostUsd: 0,
      totalDurationMs: 0,
      lastSavedAt: "2026-07-18T00:00:00Z",
      useWorktree: false,
      useIntegrity: true,
    });
    mockLoadTestBaseline.mockResolvedValueOnce({
      fileHashes: new Map(),
      assertionCounts: new Map(),
      configHashes: new Map(),
    });
    mockCallClaude
      .mockResolvedValueOnce({
        text: "fixed",
        timedOut: false,
        durationMs: 10,
        costUsd: 0.01,
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({ done: true, problems: [], nextInstruction: "" }),
        timedOut: false,
        durationMs: 10,
        costUsd: 0.01,
      });
    mockRunJudges.mockResolvedValueOnce(JUDGE_PASS);

    const result = await resumeSupervisorLoop(savedRunDir, { skipIntegrity: true, stream: false });

    expect(result.reason).toBe("passed");
    expect(mockLoadTestBaseline).toHaveBeenCalledOnce();
    expect(mockCheckTestIntegrity).toHaveBeenCalled();
    expect(mockCaptureTestBaseline).not.toHaveBeenCalled();
  });

  it("refuses to resume when another run holds the repository lock", async () => {
    const savedRunDir = join(TEST_STATE_DIR, "locked-resume");
    const lockedTask = {
      ...RESUME_TASK,
      repoPath: "/tmp/original-repo-locked",
      maxIterations: 1,
    };
    releaseLock(TEST_STATE_DIR, lockedTask.repoPath);
    expect(acquireLock(TEST_STATE_DIR, lockedTask.repoPath, "other-run")).toBe(true);
    mockLoadRunState.mockResolvedValueOnce({
      task: lockedTask,
      instruction: "Continue from saved verifier feedback",
      nextIteration: 0,
      totalCostUsd: 0,
      totalDurationMs: 0,
      lastSavedAt: "2026-01-01T00:00:00Z",
      useWorktree: false,
      useIntegrity: false,
    });
    mockCallClaude.mockResolvedValue({
      text: JSON.stringify({ done: true, problems: [], nextInstruction: "" }),
      timedOut: false,
      durationMs: 100,
      costUsd: 0.01,
    } satisfies DriverOutput);
    mockRunJudges.mockResolvedValueOnce(JUDGE_PASS);

    try {
      await expect(resumeSupervisorLoop(savedRunDir, { skipWorktree: true })).rejects.toThrow(
        "already locked by run other-run",
      );
      expect(mockCallClaude).not.toHaveBeenCalled();
    } finally {
      releaseLock(TEST_STATE_DIR, lockedTask.repoPath);
    }
  });

  it("rejects resume directories outside the configured state directory", async () => {
    mockLoadRunState.mockResolvedValueOnce({
      task: { ...RESUME_TASK, maxIterations: 0 },
      instruction: "continue",
      nextIteration: 0,
      totalCostUsd: 0,
      totalDurationMs: 0,
      lastSavedAt: "2026-01-01T00:00:00Z",
      useWorktree: false,
      useIntegrity: false,
    });

    await expect(resumeSupervisorLoop("../outside-run")).rejects.toThrow(
      "outside the state directory",
    );
    expect(mockLoadRunState).not.toHaveBeenCalled();
  });

  it("rejects resume directories with invalid run IDs", async () => {
    const invalidRunDir = join(TEST_STATE_DIR, "bad run id");
    mockLoadRunState.mockResolvedValueOnce({
      task: { ...RESUME_TASK, repoPath: "/tmp/bad-run-id-repo", maxIterations: 0 },
      instruction: "continue",
      nextIteration: 0,
      totalCostUsd: 0,
      totalDurationMs: 0,
      lastSavedAt: "2026-01-01T00:00:00Z",
      useWorktree: false,
      useIntegrity: false,
    });

    await expect(resumeSupervisorLoop(invalidRunDir, { skipWorktree: true })).rejects.toThrow(
      "Invalid run ID",
    );
    expect(mockCallClaude).not.toHaveBeenCalled();
  });

  it("restores prior iterations into decisions and final summaries", async () => {
    const savedRunDir = join(TEST_STATE_DIR, "history-resume");
    const savedWorktreeDir = join(TEST_STATE_DIR, "history-worktree");
    const priorIteration = {
      index: 0,
      executorOutput: "partial fix",
      changedFiles: ["src/sum.ts"],
      judge: JUDGE_FAIL,
      verifierVerdict: {
        done: false,
        problems: ["sum still fails"],
        nextInstruction: "fix the remaining sum case",
      },
      durationMs: 100,
      costUsd: 0.2,
    };
    mockLoadRunState.mockResolvedValueOnce({
      task: RESUME_TASK,
      instruction: "fix the remaining sum case",
      nextIteration: 1,
      totalCostUsd: 0.2,
      totalDurationMs: 100,
      lastSavedAt: "2026-07-16T00:00:00Z",
      useWorktree: true,
      useIntegrity: false,
      worktree: {
        worktreePath: savedWorktreeDir,
        branchName: "verdikt/history-resume",
        baseCommit: "abc123",
        evidenceDir: join(savedRunDir, "evidence"),
      },
    });
    mockLoadRecordedIterations.mockResolvedValueOnce([priorIteration]);
    mockCallClaude
      .mockResolvedValueOnce({ text: "fixed", timedOut: false, durationMs: 100, costUsd: 0.1 })
      .mockResolvedValueOnce({
        text: JSON.stringify({ done: true, problems: [], nextInstruction: "" }),
        timedOut: false,
        durationMs: 100,
        costUsd: 0.1,
      });
    mockRunJudges.mockResolvedValueOnce(JUDGE_PASS);

    const result = await resumeSupervisorLoop(savedRunDir, { skipIntegrity: true });

    expect(result.iterations.map((iteration) => iteration.index)).toEqual([0, 1]);
    expect(mockWriteSummary).toHaveBeenCalledWith(
      expect.stringContaining(join(TEST_STATE_DIR, "history-resume")),
      expect.objectContaining({ iterations: expect.arrayContaining([priorIteration]) }),
    );
  });

  it("applies queued notes to the next executor round and records consumption", async () => {
    const runId = "note-consume-run";
    const runDir = join(TEST_STATE_DIR, runId);
    await queueRunNote(runDir, "不要修改公共接口");

    mockCallClaude
      .mockResolvedValueOnce({ text: "did work", timedOut: false, durationMs: 5, costUsd: 0.01 })
      .mockResolvedValueOnce({
        text: JSON.stringify({ done: true, problems: [], nextInstruction: "" }),
        timedOut: false,
        durationMs: 5,
        costUsd: 0.01,
      });
    mockRunJudges.mockResolvedValueOnce(JUDGE_PASS);

    const result = await runSupervisorLoop(
      { ...TASK, maxIterations: 1 },
      { skipWorktree: true, skipIntegrity: true, runId },
    );

    expect(result.reason).toBe("passed");
    const executorPrompt = mockCallClaude.mock.calls[0][0].userPrompt;
    expect(executorPrompt).toContain("用户补充说明");
    expect(executorPrompt).toContain("不要修改公共接口");

    const notes = await readRunNotes(runDir);
    expect(notes.queued).toHaveLength(0);
    expect(notes.history).toHaveLength(1);
    expect(notes.history[0]?.consumedAt).toBeTruthy();
    expect(notes.history[0]?.iteration).toBe(0);

    const events = await readRunEvents(runDir);
    expect(events.some((event) => event.type === "note_consumed")).toBe(true);
  });

  it("does not consume queued notes when resuming a round whose executor already ran", async () => {
    const runId = "note-resume-partial";
    const runDir = join(TEST_STATE_DIR, runId);
    await queueRunNote(runDir, "留给下一个新轮次的说明");

    mockLoadRunState.mockResolvedValueOnce({
      task: RESUME_TASK,
      instruction: "continue the fix",
      nextIteration: 1,
      totalCostUsd: 0.1,
      totalDurationMs: 100,
      lastSavedAt: "2026-07-16T00:00:00Z",
      useWorktree: false,
      useIntegrity: false,
      partialIteration: { index: 1, executorOutput: "already done", changedFiles: ["src/sum.ts"] },
    });
    mockCallClaude.mockResolvedValueOnce({
      text: JSON.stringify({ done: true, problems: [], nextInstruction: "" }),
      timedOut: false,
      durationMs: 5,
      costUsd: 0.01,
    });
    mockRunJudges.mockResolvedValueOnce(JUDGE_PASS);

    const result = await resumeSupervisorLoop(runDir, { skipIntegrity: true });

    expect(result.reason).toBe("passed");
    const notes = await readRunNotes(runDir);
    expect(notes.queued).toHaveLength(1);
    expect(notes.history).toHaveLength(0);
  });

  it("skips the verifier when the budget is exhausted and the judges failed", async () => {
    mockCallClaude.mockResolvedValueOnce({
      text: "expensive attempt",
      timedOut: false,
      durationMs: 5,
      costUsd: 0.2,
      usage: { status: "complete", costUsd: 0.2 },
    });
    mockRunJudges.mockResolvedValueOnce(JUDGE_FAIL);

    const result = await runSupervisorLoop(
      { ...TASK, maxBudgetUsd: 0.1 },
      { skipWorktree: true, skipIntegrity: true, runId: "budget-skip-verifier" },
    );

    expect(result.reason).toBe("budget_exceeded");
    // Executor only — the verifier call was skipped to avoid extra spend.
    expect(mockCallClaude).toHaveBeenCalledTimes(1);
    expect(result.iterations[0]?.verifierVerdict.done).toBe(false);
    expect(result.iterations[0]?.verifierVerdict.problems.join(" ")).toContain("预算");
  });

  it("warns once that the budget cap cannot be enforced when cost data is incomplete", async () => {
    const runId = "budget-unknown-usage";
    mockCallClaude
      .mockResolvedValueOnce({ text: "attempt", timedOut: false, durationMs: 5 })
      .mockResolvedValueOnce({
        text: JSON.stringify({ done: true, problems: [], nextInstruction: "" }),
        timedOut: false,
        durationMs: 5,
      });
    mockRunJudges.mockResolvedValueOnce(JUDGE_PASS);

    const result = await runSupervisorLoop(
      { ...TASK, maxIterations: 1, maxBudgetUsd: 5 },
      { skipWorktree: true, skipIntegrity: true, runId },
    );

    expect(result.reason).toBe("passed");
    expect(mockCallClaude).toHaveBeenCalledTimes(2);
    const events = await readRunEvents(join(TEST_STATE_DIR, runId));
    const budgetWarnings = events.filter(
      (event) => event.type === "log" && String(event.data?.message ?? "").includes("无法严格执行"),
    );
    expect(budgetWarnings).toHaveLength(1);
  });

  it("persists verifier feedback as the instruction for the next iteration", async () => {
    const task = { ...TASK, maxIterations: 2 };
    mockCallClaude
      .mockResolvedValueOnce({
        text: "first attempt",
        timedOut: false,
        durationMs: 100,
        costUsd: 0.1,
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          done: false,
          problems: ["one case remains"],
          nextInstruction: "Use the verifier's precise next instruction",
        }),
        timedOut: false,
        durationMs: 100,
        costUsd: 0.1,
      })
      .mockResolvedValueOnce({
        text: "second attempt",
        timedOut: false,
        durationMs: 100,
        costUsd: 0.1,
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({ done: true, problems: [], nextInstruction: "" }),
        timedOut: false,
        durationMs: 100,
        costUsd: 0.1,
      });
    mockRunJudges.mockResolvedValueOnce(JUDGE_FAIL).mockResolvedValueOnce(JUDGE_PASS);

    await runSupervisorLoop(task, { skipWorktree: true, skipIntegrity: true });

    expect(mockSaveRunState).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        nextIteration: 1,
        instruction: "Use the verifier's precise next instruction",
      }),
    );
  });

  it("stops before judges when the provider reports an actionable error", async () => {
    const runId = "provider-credit-error";
    mockCallClaude.mockResolvedValueOnce({
      text: "[DRIVER ERROR] Claude exited with code 1\nAPI Error: 402 Insufficient credit",
      timedOut: false,
      durationMs: 10,
      usage: { status: "unknown" },
      failure: {
        kind: "provider_error",
        category: "insufficient_credit",
        statusCode: 402,
        message: "Insufficient credit",
        retryable: false,
      },
    });

    const result = await runSupervisorLoop(
      { ...TASK, id: runId },
      { skipWorktree: true, skipIntegrity: true, runId },
    );

    expect(result.reason).toBe("provider_error");
    expect(result.resumable).toBe(true);
    expect(result.providerError).toEqual(
      expect.objectContaining({ category: "insufficient_credit", statusCode: 402 }),
    );
    expect(mockRunJudges).not.toHaveBeenCalled();
    expect(mockWriteSummary).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ reason: "provider_error", resumable: true }),
    );
    const eventTypes = (await readRunEvents(join(TEST_STATE_DIR, runId))).map(
      (event) => event.type,
    );
    expect(eventTypes).toContain("provider_error");
    expect(eventTypes).not.toContain("judges_started");
  });

  it("stops in planning when the planner reports a provider error", async () => {
    const runId = "planner-provider-error";
    mockCallClaude.mockResolvedValue({
      text: "[DRIVER ERROR] API Error: 402 Insufficient credit",
      timedOut: false,
      durationMs: 10,
      usage: { status: "unknown" },
      failure: {
        kind: "provider_error",
        category: "insufficient_credit",
        statusCode: 402,
        message: "Insufficient credit",
        retryable: false,
      },
    });

    const result = await runSupervisorLoop(
      {
        ...TASK,
        id: runId,
        planning: { mode: "required", requireApproval: false },
      },
      { skipWorktree: true, skipIntegrity: true, runId, stream: false },
    );

    expect(result.reason).toBe("provider_error");
    expect(result.currentPhase).toBe("planning");
    expect(mockCallClaude).toHaveBeenCalledOnce();
    expect(mockRunJudges).not.toHaveBeenCalled();
  });

  it("stops in verification when the verifier reports a provider error", async () => {
    const runId = "verifier-provider-error";
    mockCallClaude
      .mockResolvedValueOnce({
        text: "Implemented the requested change.",
        timedOut: false,
        durationMs: 10,
        usage: { status: "complete", costUsd: 0.01 },
      })
      .mockResolvedValueOnce({
        text: "[DRIVER ERROR] API Error: 429 Rate limited",
        timedOut: false,
        durationMs: 10,
        usage: { status: "unknown" },
        failure: {
          kind: "provider_error",
          category: "rate_limited",
          statusCode: 429,
          message: "Rate limited",
          retryable: true,
        },
      });
    mockRunJudges.mockResolvedValueOnce(JUDGE_PASS);

    const result = await runSupervisorLoop(
      { ...TASK, id: runId, maxIterations: 1 },
      { skipWorktree: true, skipIntegrity: true, runId, stream: false },
    );

    expect(result.reason).toBe("provider_error");
    expect(result.currentPhase).toBe("verifier");
    expect(result.providerError).toMatchObject({ category: "rate_limited", statusCode: 429 });
    expect(mockCallClaude).toHaveBeenCalledTimes(2);
  });

  it("keeps an isolated workspace after a recoverable supervisor error", async () => {
    mockCallClaude.mockRejectedValueOnce(new Error("temporary provider failure"));

    await expect(
      runSupervisorLoop(TASK, {
        skipWorktree: false,
        skipIntegrity: true,
        runId: "recoverable-error",
      }),
    ).rejects.toThrow("temporary provider failure");

    expect(mockSaveRunState).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ worktree: expect.any(Object), nextIteration: 0 }),
    );
    expect(mockDiscardRun).not.toHaveBeenCalled();
  });

  it("keeps working inside a stage until that stage is actually reviewed as complete", async () => {
    const stagedTask: TaskSpec = {
      ...TASK,
      id: "true-stages",
      maxIterations: 3,
      stages: [
        { id: "diagnose", title: "Diagnose", goal: "Identify the root cause", maxIterations: 2 },
        { id: "verify", title: "Verify", goal: "Pass final acceptance" },
      ],
    };
    mockCallClaude
      .mockResolvedValueOnce({ text: "investigating", timedOut: false, durationMs: 10 })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          done: false,
          problems: ["root cause not proven"],
          nextInstruction: "collect stronger evidence",
        }),
        timedOut: false,
        durationMs: 10,
      })
      .mockResolvedValueOnce({ text: "root cause found", timedOut: false, durationMs: 10 })
      .mockResolvedValueOnce({
        text: JSON.stringify({ done: true, problems: [], nextInstruction: "" }),
        timedOut: false,
        durationMs: 10,
      })
      .mockResolvedValueOnce({ text: "final verification", timedOut: false, durationMs: 10 })
      .mockResolvedValueOnce({
        text: JSON.stringify({ done: true, problems: [], nextInstruction: "" }),
        timedOut: false,
        durationMs: 10,
      });
    mockRunJudges
      .mockResolvedValueOnce(JUDGE_FAIL)
      .mockResolvedValueOnce(JUDGE_FAIL)
      .mockResolvedValueOnce(JUDGE_PASS);

    const result = await runSupervisorLoop(stagedTask, {
      skipWorktree: true,
      skipIntegrity: true,
      runId: "true-stages",
    });

    expect(result.reason).toBe("passed");
    expect(result.iterations.map((iteration) => iteration.stageId)).toEqual([
      "diagnose",
      "diagnose",
      "verify",
    ]);
    expect(result.stageProgress?.completedStageIds).toEqual(["diagnose", "verify"]);
  });

  it("releases the repository lock after a rejected approval is finalized", async () => {
    const suffix = `${process.pid}-${Date.now()}`;
    const runId = `approval-rejected-${suffix}`;
    const task = {
      ...TASK,
      id: "rejected-release",
      goal: "Deploy this change to production",
      repoPath: `/tmp/rejected-release-repo-${suffix}`,
      riskPolicy: { mode: "confirm" as const },
    };

    try {
      const waiting = await runSupervisorLoop(task, {
        skipWorktree: true,
        skipIntegrity: true,
        runId,
      });
      expect(waiting.reason).toBe("approval_required");
      await rejectRequest(join(TEST_STATE_DIR, runId), "not allowed");

      const result = await runSupervisorLoop(task, {
        skipWorktree: true,
        skipIntegrity: true,
        runId,
      });

      expect(result.reason).toBe("approval_rejected");
      expect(checkLock(TEST_STATE_DIR, task.repoPath)).toBeNull();
      expect(mockCallClaude).not.toHaveBeenCalled();
    } finally {
      releaseLock(TEST_STATE_DIR, task.repoPath, runId);
      await rm(join(TEST_STATE_DIR, runId), { recursive: true, force: true });
    }
  });

  it("pauses before unapproved high-risk work instead of starting the executor", async () => {
    const riskyTask: TaskSpec = {
      ...TASK,
      id: "production-release",
      goal: "Deploy this change to production",
    };

    const result = await runSupervisorLoop(riskyTask, {
      skipWorktree: true,
      skipIntegrity: true,
      runId: "approval-required",
    });

    expect(result.reason).toBe("approval_required");
    expect(result.approvalRequest?.categories).toEqual(
      expect.arrayContaining(["deployment", "production"]),
    );
    expect(mockCallClaude).not.toHaveBeenCalled();
    expect(mockSaveRunState).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ phase: "waiting_approval" }),
    );
  });

  it("preserves executor, patch, and judge facts when stopped during verifier", async () => {
    const controller = new AbortController();
    const runId = "mock-stop-during-verifier";
    mockCreateRunWorktree.mockResolvedValueOnce({
      worktreePath: join(TEST_STATE_DIR, "stop-during-verifier-worktree"),
      branchName: "verdikt/mock-stop-during-verifier",
      baseCommit: "abc123",
      evidenceDir: join(TEST_STATE_DIR, runId, "evidence"),
    });
    mockCallClaude.mockImplementation(async (input) => {
      if (input.systemPrompt.includes("EXECUTOR")) {
        return {
          text: "Fixed src/sum.ts",
          timedOut: false,
          durationMs: 100,
          costUsd: 0.2,
          usage: { status: "complete", costUsd: 0.2 },
        };
      }
      controller.abort("user_cancel");
      return {
        text: JSON.stringify({ done: true, problems: [], nextInstruction: "" }),
        timedOut: false,
        durationMs: 50,
        costUsd: 0.1,
        usage: { status: "complete", costUsd: 0.1 },
      };
    });
    mockRunJudges.mockResolvedValueOnce(JUDGE_PASS);

    const result = await runSupervisorLoop(
      { ...TASK, id: "stop-during-verifier", maxIterations: 1 },
      { runId, signal: controller.signal, stream: false },
    );

    expect(result.reason).toBe("cancelled");
    expect(result.resumable).toBe(true);
    expect(result.applyStatus).toBe("pending");
    expect(result.partialIteration).toEqual(
      expect.objectContaining({
        index: 0,
        executorOutput: "Fixed src/sum.ts",
        changedFiles: ["src/sum.ts"],
        judge: expect.objectContaining({ passed: true }),
      }),
    );
    expect(mockDiscardRun).not.toHaveBeenCalled();
    expect(mockSaveRunState).toHaveBeenLastCalledWith(
      expect.stringContaining(runId),
      expect.objectContaining({
        phase: "stopped",
        currentPhase: "verifier",
        partialIteration: expect.objectContaining({
          judge: expect.objectContaining({ passed: true }),
        }),
      }),
    );
    const eventTypes = (await readRunEvents(join(TEST_STATE_DIR, runId))).map(
      (event) => event.type,
    );
    expect(eventTypes).toEqual(
      expect.arrayContaining([
        "iteration_started",
        "executor_started",
        "executor_completed",
        "patch_ready",
        "judges_started",
        "judges_completed",
        "verifier_started",
        "run_cancelled",
      ]),
    );
  });

  it("reports planner and verifier stalls with their exact phase", async () => {
    const stalls: Array<{ phase?: string }> = [];
    mockCallClaude.mockImplementation(async (input, streamCallbacks) => {
      if (input.systemPrompt.includes("PLANNER")) {
        streamCallbacks?.onStall?.({ elapsedMs: 200, outputIdleMs: 150 });
        return { text: "# Plan\nFix it.", timedOut: false, durationMs: 10, costUsd: 0.01 };
      }
      if (input.systemPrompt.includes("EXECUTOR")) {
        return { text: "Fixed it", timedOut: false, durationMs: 10, costUsd: 0.01 };
      }
      streamCallbacks?.onStall?.({ elapsedMs: 300, outputIdleMs: 250 });
      return {
        text: JSON.stringify({ done: true, problems: [], nextInstruction: "" }),
        timedOut: false,
        durationMs: 10,
        costUsd: 0.01,
      };
    });
    mockRunJudges.mockResolvedValueOnce(JUDGE_PASS);

    await runSupervisorLoop(
      {
        ...TASK,
        id: "phase-stall",
        maxIterations: 1,
        planning: { mode: "required", requireApproval: false },
      },
      {
        runId: "mock-phase-stall",
        skipWorktree: true,
        skipIntegrity: true,
        stream: false,
        onStall: (stall) => stalls.push(stall),
      },
    );

    expect(stalls.map((stall) => stall.phase)).toEqual(["planning", "verifier"]);
    const stalledEvents = (await readRunEvents(join(TEST_STATE_DIR, "mock-phase-stall"))).filter(
      (event) => event.type === "phase_stalled",
    );
    expect(stalledEvents.map((event) => event.data?.phase)).toEqual(["planning", "verifier"]);
  });

  it("resumes a stopped verifier phase without repeating executor or judges", async () => {
    const runId = "resume-partial-verifier";
    const savedRunDir = join(TEST_STATE_DIR, runId);
    const savedWorktreeDir = join(TEST_STATE_DIR, "resume-partial-worktree");
    mockLoadRunState.mockResolvedValueOnce({
      task: { ...RESUME_TASK, id: "resume-partial", maxIterations: 1 },
      instruction: "Finish verification",
      nextIteration: 0,
      totalCostUsd: 0.2,
      totalDurationMs: 100,
      usageStatus: "complete",
      usage: { status: "complete", costUsd: 0.2 },
      lastSavedAt: "2026-07-18T00:00:00Z",
      useWorktree: true,
      useIntegrity: false,
      phase: "stopped",
      currentPhase: "verifier",
      stageRuntime: { stageIndex: -1, stageIteration: 0, stageCostUsd: 0, completedStageIds: [] },
      partialIteration: {
        index: 0,
        executorOutput: "Fixed src/sum.ts",
        executorDurationMs: 100,
        executorUsage: { status: "complete", costUsd: 0.2 },
        changedFiles: ["src/sum.ts"],
        patchPath: join(savedRunDir, "evidence", "iteration-0.patch"),
        linesAdded: 1,
        linesDeleted: 1,
        judge: JUDGE_PASS,
      },
      worktree: {
        worktreePath: savedWorktreeDir,
        branchName: "verdikt/resume-partial-verifier",
        baseCommit: "abc123",
        evidenceDir: join(savedRunDir, "evidence"),
      },
    });
    mockCallClaude.mockResolvedValueOnce({
      text: JSON.stringify({ done: true, problems: [], nextInstruction: "" }),
      timedOut: false,
      durationMs: 20,
      costUsd: 0.05,
      usage: { status: "complete", costUsd: 0.05 },
    });

    const result = await resumeSupervisorLoop(savedRunDir, { skipIntegrity: true, stream: false });

    expect(result.reason).toBe("passed");
    expect(mockCallClaude).toHaveBeenCalledOnce();
    expect(mockCallClaude.mock.calls[0][0].systemPrompt).toContain("VERIFIER");
    expect(mockRunJudges).not.toHaveBeenCalled();
    expect(result.iterations[0]).toEqual(
      expect.objectContaining({ changedFiles: ["src/sum.ts"], judge: JUDGE_PASS }),
    );
  });
});

afterAll(async () => {
  await rm(TEST_STATE_DIR, { recursive: true, force: true });
});
