import { describe, expect, it } from "vitest";

describe("Analyze command", () => {
  it("handleAnalyze is a function", async () => {
    const { handleAnalyze } = await import("./analyze.js");
    expect(typeof handleAnalyze).toBe("function");
  });
});
