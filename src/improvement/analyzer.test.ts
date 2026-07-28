import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzeRuns } from "./analyzer.js";

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "verdikt-analyzer-"));
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function writeSummary(runId: string, summary: unknown): Promise<void> {
  const runDir = join(stateDir, runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "summary.json"), JSON.stringify(summary, null, 2), "utf-8");
}

describe("analyzeRuns", () => {
  it("ignores malformed summary fields instead of crashing", async () => {
    await writeSummary("run-bad-fields", {
      taskId: 42,
      stopReason: "passed",
      iterations: [
        {
          judge: { passed: false },
          verifier: {
            problems: ["Type error: return value mismatch", { detail: "not text" }, 123, "", null],
            nextInstruction: { text: "not text" },
          },
          patch: { filesChanged: ["src/result.ts", 99, null] },
        },
        {
          judge: { passed: true },
          verifier: { problems: "not an array" },
          patch: { filesChanged: ["src/result.ts"] },
        },
      ],
    });
    await writeSummary("run-no-array-iterations", {
      taskId: "legacy",
      stopReason: "max_iterations",
      iterations: { bad: true },
    });

    const report = await analyzeRuns(stateDir);

    expect(report.totalRuns).toBe(2);
    expect(report.passedRuns).toBe(1);
    expect(report.failurePatterns).toEqual([
      expect.objectContaining({
        pattern: "type-error",
        count: 1,
        recoveredCount: 1,
        example: "Type error: return value mismatch",
      }),
    ]);
    expect(report.recoveryStrategies).toEqual([
      expect.objectContaining({
        problem: "Type error: return value mismatch",
        solution: "Changed 1 file(s): src/result.ts",
        exampleRun: "run-bad-fields",
      }),
    ]);
  });
});
