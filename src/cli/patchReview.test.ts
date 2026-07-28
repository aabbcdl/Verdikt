import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readPatchReview } from "./patchReview.js";

let tempDir: string;
let stateDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "verdikt-patch-review-test-"));
  stateDir = join(tempDir, ".verdikt");
  await mkdir(stateDir, { recursive: true });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("readPatchReview", () => {
  it("summarizes a saved final patch for review", async () => {
    const runId = "run-patch-001";
    const runDir = join(stateDir, runId);
    await mkdir(join(runDir, "evidence"), { recursive: true });
    await writeFile(
      join(runDir, "summary.json"),
      JSON.stringify({
        runId,
        stopReason: "passed",
        patch: { filesChanged: 1, linesAdded: 1, linesDeleted: 1 },
        integrity: { status: "ok", criticalCount: 0, warningCount: 0, issues: [] },
        semanticRisk: { level: "none", findingCount: 0, topFindings: [] },
      }),
      "utf-8",
    );
    await writeFile(
      join(runDir, "evidence", "final.patch"),
      [
        "diff --git a/src/sum.ts b/src/sum.ts",
        "+++ b/src/sum.ts",
        "@@ -1,1 +1,1 @@",
        "-return a - b;",
        "+return a + b;",
      ].join("\n"),
      "utf-8",
    );

    const review = await readPatchReview(stateDir, runId);

    expect(review.available).toBe(true);
    expect(review.files).toEqual([
      { path: "src/sum.ts", additions: 1, deletions: 1, kind: "source" },
    ]);
    expect(review.patchText).toContain("return a + b");
    expect(review.warnings).toEqual([]);
    expect(review.risk.level).toBe("low");
    expect(review.risk.verdict).toContain("风险较低");
    expect(review.risk.applyChecklist.join("\n")).toContain("验收命令");
  });

  it("raises the patch risk verdict for test, dependency, and semantic-risk changes", async () => {
    const runId = "run-risk-001";
    const runDir = join(stateDir, runId);
    await mkdir(join(runDir, "evidence"), { recursive: true });
    await writeFile(
      join(runDir, "summary.json"),
      JSON.stringify({
        runId,
        stopReason: "passed",
        integrity: { status: "ok", criticalCount: 1, warningCount: 0, issues: [] },
        semanticRisk: { level: "high", findingCount: 1, topFindings: [] },
      }),
      "utf-8",
    );
    await writeFile(
      join(runDir, "evidence", "final.patch"),
      [
        "diff --git a/package.json b/package.json",
        "+++ b/package.json",
        "@@ -1,1 +1,1 @@",
        '-"test":"vitest"',
        '+"test":"vitest run"',
        "diff --git a/src/sum.test.ts b/src/sum.test.ts",
        "+++ b/src/sum.test.ts",
        "@@ -1,1 +1,1 @@",
        "-expect(sum(1, 2)).toBe(3)",
        "+expect(sum(1, 2)).toBe(-1)",
      ].join("\n"),
      "utf-8",
    );

    const review = await readPatchReview(stateDir, runId);

    expect(review.risk.level).toBe("high");
    expect(review.risk.verdict).toContain("高风险");
    expect(review.risk.reasons.join("\n")).toContain("测试");
    expect(review.risk.reasons.join("\n")).toContain("依赖");
    expect(review.risk.applyChecklist.join("\n")).toContain("不要直接应用");
  });

  it("reports missing patches without throwing", async () => {
    const runId = "run-no-patch-001";
    const runDir = join(stateDir, runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "summary.json"), JSON.stringify({ runId }), "utf-8");

    const review = await readPatchReview(stateDir, runId);

    expect(review.available).toBe(false);
    expect(review.reason).toContain("No final patch");
  });
});
