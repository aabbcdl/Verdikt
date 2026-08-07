import { describe, expect, it } from "vitest";
import type { RunSummaryForAdvice } from "./runAdvice.js";
import { buildRunAdvice } from "./runAdvice.js";

function summary(overrides: Partial<RunSummaryForAdvice> = {}): RunSummaryForAdvice {
  return {
    stopReason: "passed",
    applyStatus: "pending",
    totalIterations: 1,
    totalCostUsd: 0.1,
    iterations: [],
    ...overrides,
  };
}

describe("buildRunAdvice", () => {
  it("tells the user to review and apply a passed pending run", () => {
    const advice = buildRunAdvice(summary());

    expect(advice.kind).toBe("success");
    expect(advice.title).toContain("通过");
    expect(advice.nextActions.join("\n")).toContain("审查补丁");
    expect(advice.nextActions.join("\n")).toContain("应用补丁");
  });

  it("explains max iteration failures with a concrete next step", () => {
    const advice = buildRunAdvice(
      summary({
        stopReason: "max_iterations",
        resumable: true,
        iterations: [
          {
            judge: { passed: false, failedChecks: ["test"], summary: "1/1 required failed" },
            verifier: {
              problems: ["sum still subtracts numbers"],
              nextInstruction: "Change subtraction to addition.",
            },
          },
        ],
      }),
    );

    expect(advice.kind).toBe("danger");
    expect(advice.title).toContain("轮数");
    expect(advice.nextActions.join("\n")).toContain("继续运行");
    expect(advice.evidence.join("\n")).toContain("sum still subtracts numbers");
  });

  it("separates budget failures from code failures", () => {
    const advice = buildRunAdvice(
      summary({ stopReason: "budget_exceeded", totalCostUsd: 5, usageStatus: "complete" }),
    );

    expect(advice.kind).toBe("warning");
    expect(advice.title).toContain("费用停止目标");
    expect(advice.summary).toContain("费用数据完整");
    expect(advice.nextActions.join("\n")).toContain("提高费用停止目标");
  });

  it("does not promise a hard cost cap when cost data is incomplete", () => {
    const advice = buildRunAdvice(
      summary({ stopReason: "budget_exceeded", totalCostUsd: 5, usageStatus: "partial" }),
    );

    expect(advice.summary).toContain("费用数据不完整");
    expect(advice.summary).toContain("实际费用可能更高");
  });

  it("gives an actionable next step for provider failures", () => {
    const advice = buildRunAdvice(
      summary({
        stopReason: "provider_error",
        providerError: {
          category: "insufficient_credit",
          statusCode: 402,
          message: "Insufficient credit",
          retryable: false,
        },
      }),
    );

    expect(advice.kind).toBe("warning");
    expect(advice.title).toContain("\u4f59\u989d");
    expect(advice.nextActions.join("\n")).toContain("\u7ee7\u7eed\u8fd0\u884c");
    expect(advice.evidence.join("\n")).toContain("402");
  });

  it("marks discarded runs as terminal", () => {
    const advice = buildRunAdvice(summary({ applyStatus: "discarded" }));

    expect(advice.kind).toBe("info");
    expect(advice.nextActions.join("\n")).toContain("重新运行");
  });
});
