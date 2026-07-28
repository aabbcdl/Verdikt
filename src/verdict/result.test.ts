import { describe, expect, it } from "vitest";
import type { RunResult, TaskSpec } from "../types.js";
import { buildVerdictResult } from "./result.js";

const TASK: TaskSpec = {
  id: "auth-rate-limit",
  goal: "Fix login rate limiting",
  repoPath: "C:\\repo",
  acceptance: {
    steps: [
      { id: "test", command: "pnpm", args: ["test"], required: true },
      { id: "build", command: "pnpm", args: ["build"], required: true },
      { id: "lint", command: "pnpm", args: ["lint"], required: false },
    ],
  },
  maxIterations: 3,
};

function passingResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    reason: "passed",
    iterations: [
      {
        index: 0,
        executorOutput: "Implemented the fix.",
        changedFiles: ["src/auth/rateLimit.ts", "tests/auth/rateLimit.test.ts"],
        judge: {
          passed: true,
          checks: [
            {
              name: "test",
              passed: true,
              output: "531 passed",
              exitCode: 0,
              durationMs: 1200,
            },
            {
              name: "build",
              passed: true,
              output: "build complete",
              exitCode: 0,
              durationMs: 800,
            },
            {
              name: "lint",
              passed: false,
              output: "optional lint warning",
              exitCode: 1,
              durationMs: 300,
            },
          ],
          stepResults: [
            {
              id: "test",
              passed: true,
              exitCode: 0,
              stdout: "531 passed",
              stderr: "",
              durationMs: 1200,
              required: true,
            },
            {
              id: "build",
              passed: true,
              exitCode: 0,
              stdout: "build complete",
              stderr: "",
              durationMs: 800,
              required: true,
            },
            {
              id: "lint",
              passed: false,
              exitCode: 1,
              stdout: "",
              stderr: "optional lint warning",
              durationMs: 300,
              required: false,
            },
          ],
        },
        verifierVerdict: { done: true, problems: [], nextInstruction: "" },
        durationMs: 2500,
      },
    ],
    totalDurationMs: 2500,
    totalCostUsd: 0.42,
    usageStatus: "complete",
    runId: "run-auth-rate-limit",
    taskId: TASK.id,
    workspace: {
      path: "C:\\state\\run-auth-rate-limit\\worktree",
      baseCommit: "abc123",
      originalRepoCleanBeforeApply: true,
      mode: "isolated",
      repoPath: TASK.repoPath,
    },
    patch: {
      finalPatchPath: "C:\\state\\run-auth-rate-limit\\evidence\\final.patch",
      filesChanged: 2,
      linesAdded: 34,
      linesDeleted: 8,
    },
    integritySummary: {
      status: "ok",
      criticalCount: 0,
      warningCount: 0,
      issues: [],
    },
    applyStatus: "pending",
    evidenceManifestPath: "C:\\state\\run-auth-rate-limit\\evidence\\manifest.json",
    ...overrides,
  };
}

describe("buildVerdictResult", () => {
  it("produces a strict PASS with verified command evidence", () => {
    const verdict = buildVerdictResult(passingResult(), TASK, {
      createdAt: "2026-07-28T12:00:00.000Z",
      verdiktVersion: "0.1.0",
    });

    expect(verdict.version).toBe(1);
    expect(verdict.status).toBe("pass");
    expect(verdict.recommendation).toBe("accept_change");
    expect(verdict.summary).toMatchObject({ requiredPassed: 2, requiredTotal: 2 });
    expect(verdict.criteria).toEqual([
      expect.objectContaining({
        id: "test",
        required: true,
        status: "pass",
        evidenceIds: ["command:test"],
      }),
      expect.objectContaining({
        id: "build",
        required: true,
        status: "pass",
        evidenceIds: ["command:build"],
      }),
      expect.objectContaining({
        id: "lint",
        required: false,
        status: "warning",
        evidenceIds: ["command:lint"],
      }),
    ]);
    expect(verdict.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "command:test",
          source: "verified_execution",
          assurance: "verified",
          command: expect.objectContaining({
            executable: "pnpm",
            args: ["test"],
            exitCode: 0,
          }),
        }),
        expect.objectContaining({
          source: "agent_claim",
          assurance: "claimed",
        }),
      ]),
    );
    expect(verdict.scope).toMatchObject({
      status: "skipped",
      filesChanged: 2,
      outOfScopeFiles: [],
    });
    expect(verdict.integrity).toMatchObject({
      status: "pass",
      evidenceRecorded: true,
      criticalCount: 0,
    });
    expect(verdict.provenance).toMatchObject({
      baseCommit: "abc123",
      verdiktVersion: "0.1.0",
    });
  });

  it("does not allow an agent claim without objective checks to produce PASS", () => {
    const verdict = buildVerdictResult(
      passingResult({
        iterations: [
          {
            index: 0,
            executorOutput: "Everything is complete and safe.",
            changedFiles: ["src/auth/rateLimit.ts"],
            judge: { passed: true, checks: [] },
            verifierVerdict: { done: true, problems: [], nextInstruction: "" },
            durationMs: 100,
          },
        ],
      }),
      { ...TASK, acceptance: {} },
    );

    expect(verdict.status).toBe("incomplete");
    expect(verdict.recommendation).toBe("none");
    expect(verdict.evidence).toEqual([
      expect.objectContaining({
        source: "agent_claim",
        assurance: "claimed",
      }),
    ]);
  });

  it("fails a candidate when a required objective check failed", () => {
    const result = passingResult({ reason: "max_iterations" });
    const iteration = result.iterations[0];
    if (!iteration?.judge.stepResults) throw new Error("fixture is missing step results");
    iteration.judge.passed = false;
    iteration.judge.checks[0] = {
      ...iteration.judge.checks[0],
      passed: false,
      exitCode: 1,
      output: "3 tests failed",
    };
    iteration.judge.stepResults[0] = {
      ...iteration.judge.stepResults[0],
      passed: false,
      exitCode: 1,
      stdout: "",
      stderr: "3 tests failed",
    };

    const verdict = buildVerdictResult(result, TASK);

    expect(verdict.status).toBe("fail");
    expect(verdict.recommendation).toBe("continue_fixing");
    expect(verdict.criteria.find((criterion) => criterion.id === "test")).toMatchObject({
      status: "fail",
      required: true,
    });
  });

  it("uses NEEDS_REVIEW for approval gates and INCOMPLETE for provider failures", () => {
    const approval = buildVerdictResult(
      passingResult({
        reason: "approval_required",
        approvalRequest: {
          categories: ["deployment"],
          reason: "Production deployment needs confirmation",
        },
      }),
      TASK,
    );
    const providerFailure = buildVerdictResult(
      passingResult({
        reason: "provider_error",
        iterations: [],
        providerError: {
          category: "insufficient_credit",
          statusCode: 402,
          message: "Insufficient credit",
          retryable: false,
        },
      }),
      TASK,
    );

    expect(approval.status).toBe("needs_review");
    expect(approval.recommendation).toBe("human_review");
    expect(providerFailure.status).toBe("incomplete");
    expect(providerFailure.recommendation).toBe("continue_fixing");
  });

  it("lets critical integrity findings override passing commands", () => {
    const verdict = buildVerdictResult(
      passingResult({
        integritySummary: {
          status: "violations",
          criticalCount: 1,
          warningCount: 0,
          issues: [
            {
              rule: "test-script-modified",
              detail: "The test script was weakened",
              severity: "critical",
            },
          ],
        },
      }),
      TASK,
    );

    expect(verdict.status).toBe("fail");
    expect(verdict.recommendation).toBe("discard");
    expect(verdict.integrity).toMatchObject({
      status: "fail",
      acceptanceWeakened: true,
      criticalCount: 1,
    });
  });
});
