import { describe, expect, it } from "vitest";
import { coerceUsageSummary, formatCost, mergeUsage, usageFromClaudeResult } from "./usage.js";

describe("usage truthfulness", () => {
  it("marks missing spend as unknown instead of zero", () => {
    const usage = usageFromClaudeResult({ type: "result", result: "ok" });
    expect(usage.status).toBe("unknown");
    expect(usage.costUsd).toBeUndefined();
    expect(formatCost(usage)).toBe("unknown");
  });

  it("does not display or aggregate a numeric zero when the status is unknown", () => {
    expect(formatCost({ status: "unknown", costUsd: 0 })).toBe("unknown");
    expect(coerceUsageSummary({ status: "unknown", costUsd: 0 }, 0)).toEqual({
      status: "unknown",
    });
    expect(mergeUsage({ status: "unknown", costUsd: 0 })).toEqual({ status: "unknown" });
  });

  it("marks incomplete reports as partial and retains observed values", () => {
    const usage = usageFromClaudeResult({
      total_cost_usd: 0.25,
      cost_is_partial: true,
      usage: { input_tokens: 10, cache_read_input_tokens: 20, output_tokens: 5 },
    });
    expect(usage.status).toBe("partial");
    expect(usage.costUsd).toBe(0.25);
    expect(usage.totalTokens).toBe(35);
    expect(formatCost(usage)).toBe("$0.2500+");
  });

  it("marks a complete reported cost as complete", () => {
    const usage = usageFromClaudeResult({ total_cost_usd: 0.125 });
    expect(usage.status).toBe("complete");
    expect(formatCost(usage)).toBe("$0.1250");
  });

  it("merges known and unknown calls as partial rather than complete", () => {
    const merged = mergeUsage(
      usageFromClaudeResult({ total_cost_usd: 0.1 }),
      usageFromClaudeResult({}),
    );
    expect(merged.status).toBe("partial");
    expect(merged.costUsd).toBe(0.1);
  });

  it("coerces saved summaries without a status as legacy complete values", () => {
    expect(coerceUsageSummary(undefined, 0.4)).toEqual({ status: "complete", costUsd: 0.4 });
    expect(coerceUsageSummary({ status: "partial", costUsd: 0.2 }, 0.2)).toEqual({
      status: "partial",
      costUsd: 0.2,
    });
  });

  it("keeps a fully unknown total unknown", () => {
    const merged = mergeUsage(usageFromClaudeResult({}), usageFromClaudeResult({}));
    expect(merged.status).toBe("unknown");
    expect(merged.costUsd).toBeUndefined();
  });
});
