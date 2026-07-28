import { describe, expect, it } from "vitest";
import { parseReviewReport } from "./reviewer.js";

describe("parseReviewReport", () => {
  it("parses a structured review report", () => {
    const report = parseReviewReport(
      JSON.stringify({
        summary: "发现一个问题",
        verdict: "issues_found",
        findings: [
          {
            severity: "high",
            title: "空值崩溃",
            detail: "调用前没有检查空值",
            file: "src/a.ts",
            line: 12,
            recommendation: "增加空值分支",
          },
        ],
      }),
    );
    expect(report.verdict).toBe("issues_found");
    expect(report.findings[0]).toMatchObject({ severity: "high", file: "src/a.ts", line: 12 });
  });

  it("extracts JSON when the model adds a short explanation", () => {
    const report = parseReviewReport(
      `Review complete.\n\n\`\`\`json\n${JSON.stringify({ summary: "ok", verdict: "clean", findings: [] })}\n\`\`\``,
    );
    expect(report).toMatchObject({ verdict: "clean", summary: "ok" });
  });

  it("converts a markdown issue table into structured findings", () => {
    const report = parseReviewReport(
      "## Review\n\n| # | Location | Problem | Evidence |\n|---|---|---|---|\n| 1 | L4 | **Division by zero** | Returns Infinity instead of rejecting invalid input |",
    );
    expect(report.verdict).toBe("issues_found");
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({ title: "Division by zero", line: 4 });
  });

  it("marks malformed output as incomplete instead of pretending review succeeded", () => {
    expect(parseReviewReport("not json")).toEqual({
      summary: "审查输出无法解析。",
      verdict: "incomplete",
      findings: [],
    });
  });
});
