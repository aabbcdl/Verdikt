import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JudgeResult, TaskSpec } from "../types.js";
import { runVerifier } from "./verifier.js";

vi.mock("../claude/driver.js", () => ({
  callClaude: vi.fn(),
}));

const task: TaskSpec = {
  id: "verifier-test",
  goal: "Fix the calculator.",
  repoPath: "/repo",
  maxIterations: 3,
  acceptance: {
    testCommand: "npm test",
  },
};

const failingJudge: JudgeResult = {
  passed: false,
  checks: [
    {
      name: "test",
      passed: false,
      output: "expected 4 but got 3",
      exitCode: 1,
      durationMs: 123,
    },
  ],
};

const passingJudge: JudgeResult = {
  passed: true,
  checks: [
    {
      name: "test",
      passed: true,
      output: "all tests passed",
      exitCode: 0,
      durationMs: 123,
    },
  ],
};

describe("runVerifier", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("extracts fenced JSON even when the explanation contains braces", async () => {
    const { callClaude } = await import("../claude/driver.js");
    vi.mocked(callClaude).mockResolvedValue({
      text: [
        "The failure includes an object-like value: { expected: 4, actual: 3 }.",
        "",
        "```json",
        JSON.stringify({
          done: false,
          problems: ["sum returns 3 when the test expects 4"],
          nextInstruction: "Fix sum so it returns 4 for 2 + 2, then rerun npm test.",
        }),
        "```",
      ].join("\n"),
      timedOut: false,
      durationMs: 1,
    });

    const result = await runVerifier(task, failingJudge, "executor claims");

    expect(result.verdict).toEqual({
      done: false,
      problems: ["sum returns 3 when the test expects 4"],
      nextInstruction: "Fix sum so it returns 4 for 2 + 2, then rerun npm test.",
    });
  });

  it("does not allow verifier JSON to mark failed judge checks as done", async () => {
    const { callClaude } = await import("../claude/driver.js");
    vi.mocked(callClaude).mockResolvedValue({
      text: JSON.stringify({
        done: true,
        problems: [],
        nextInstruction: "",
      }),
      timedOut: false,
      durationMs: 1,
    });

    const result = await runVerifier(task, failingJudge, "executor claims");

    expect(result.verdict.done).toBe(false);
  });

  it("does not mark a passing judge result done when verifier output is malformed", async () => {
    const { callClaude } = await import("../claude/driver.js");
    vi.mocked(callClaude).mockResolvedValue({
      text: "I reviewed it and it looks good, but this is not JSON.",
      timedOut: false,
      durationMs: 1,
    });

    const result = await runVerifier(task, passingJudge, "executor claims");

    expect(result.verdict.done).toBe(false);
    expect(result.verdict.problems).toContain("Verifier output could not be parsed");
    expect(result.verdict.nextInstruction).toContain("valid JSON");
  });

  it("does not trust done JSON when the verifier process failed", async () => {
    const { callClaude } = await import("../claude/driver.js");
    vi.mocked(callClaude).mockResolvedValue({
      text: [
        "[DRIVER ERROR] Claude exited with code 1",
        "transient process failure",
        JSON.stringify({ done: true, problems: [], nextInstruction: "" }),
      ].join("\n"),
      timedOut: false,
      durationMs: 1,
    });

    const result = await runVerifier(task, passingJudge, "executor claims");

    expect(result.verdict.done).toBe(false);
    expect(result.verdict.problems).toContain("Verifier process failed");
  });

  it("does not present optional structured step failures as blocking judge failures", async () => {
    const { callClaude } = await import("../claude/driver.js");
    vi.mocked(callClaude).mockResolvedValue({
      text: JSON.stringify({
        done: true,
        problems: [],
        nextInstruction: "",
      }),
      timedOut: false,
      durationMs: 1,
    });

    const structuredJudge: JudgeResult = {
      passed: true,
      checks: [
        {
          name: "test",
          passed: true,
          output: "tests passed",
          exitCode: 0,
          durationMs: 10,
        },
        {
          name: "diagnostics",
          passed: false,
          output: "non-blocking diagnostic failed",
          exitCode: 1,
          durationMs: 20,
        },
      ],
      stepResults: [
        {
          id: "test",
          passed: true,
          exitCode: 0,
          stdout: "tests passed",
          stderr: "",
          durationMs: 10,
          required: true,
        },
        {
          id: "diagnostics",
          passed: false,
          exitCode: 1,
          stdout: "",
          stderr: "non-blocking diagnostic failed",
          durationMs: 20,
          required: false,
        },
      ],
    };

    await runVerifier(task, structuredJudge, "executor claims");

    const verifierInput = vi.mocked(callClaude).mock.calls[0][0];
    expect(verifierInput.systemPrompt).toContain("required judge check");
    expect(verifierInput.systemPrompt).toContain("Optional judge checks");
    expect(verifierInput.userPrompt).toContain("Overall: REQUIRED CHECKS PASSED");
    expect(verifierInput.userPrompt).toContain("[OPTIONAL FAIL] diagnostics");
    expect(verifierInput.userPrompt).not.toContain("[FAIL] diagnostics");
  });

  it("ignores optional structured step failures when building fallback instructions", async () => {
    const { callClaude } = await import("../claude/driver.js");
    vi.mocked(callClaude).mockResolvedValue({
      text: "not json",
      timedOut: false,
      durationMs: 1,
    });

    const structuredJudge: JudgeResult = {
      passed: false,
      checks: [
        {
          name: "test",
          passed: false,
          output: "required test failed",
          exitCode: 1,
          durationMs: 10,
        },
        {
          name: "diagnostics",
          passed: false,
          output: "optional diagnostic failed",
          exitCode: 1,
          durationMs: 20,
        },
      ],
      stepResults: [
        {
          id: "test",
          passed: false,
          exitCode: 1,
          stdout: "",
          stderr: "required test failed",
          durationMs: 10,
          required: true,
        },
        {
          id: "diagnostics",
          passed: false,
          exitCode: 1,
          stdout: "",
          stderr: "optional diagnostic failed",
          durationMs: 20,
          required: false,
        },
      ],
    };

    const result = await runVerifier(task, structuredJudge, "executor claims");

    expect(result.verdict.problems).toEqual(["test failed (exit 1)"]);
    expect(result.verdict.nextInstruction).toContain("Fix the failing checks: test");
    expect(result.verdict.nextInstruction).not.toContain("diagnostics");
  });

  it("allows a reviewed stage to complete before final acceptance passes", async () => {
    const { callClaude } = await import("../claude/driver.js");
    vi.mocked(callClaude).mockResolvedValue({
      text: JSON.stringify({ done: true, problems: [], nextInstruction: "" }),
      timedOut: false,
      durationMs: 1,
    });

    const result = await runVerifier(task, failingJudge, "root cause identified", undefined, {
      completionGoal: "Identify and document the root cause",
      requireJudgePass: false,
    });

    expect(result.verdict.done).toBe(true);
    expect(vi.mocked(callClaude)).toHaveBeenCalledWith(
      expect.objectContaining({
        userPrompt: expect.stringContaining("Identify and document the root cause"),
      }),
    );
  });
});
