import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfig, setConfig } from "../config.js";
import type { TaskSpec } from "../types.js";

vi.mock("../claude/driver.js", () => ({ callClaude: vi.fn() }));

import { callClaude } from "../claude/driver.js";
import { runSupervisorLoop } from "./supervisor.js";

let root: string;
let stateDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "verdikt-review-supervisor-"));
  stateDir = join(root, ".verdikt");
  setConfig({ stateDir });
  vi.mocked(callClaude).mockReset();
});

afterEach(async () => {
  resetConfig();
  await rm(root, { recursive: true, force: true });
});

describe("review-only supervisor flow", () => {
  it("produces a structured report without changing repository files", async () => {
    const sourcePath = join(root, "source.ts");
    await writeFile(sourcePath, "export const value = 1;\n", "utf-8");
    vi.mocked(callClaude).mockResolvedValue({
      text: JSON.stringify({
        summary: "One concrete issue was found.",
        verdict: "issues_found",
        findings: [
          {
            severity: "medium",
            title: "Magic value",
            detail: "The exported value is unexplained.",
            file: "source.ts",
            line: 1,
            recommendation: "Name the domain meaning.",
          },
        ],
      }),
      timedOut: false,
      durationMs: 5,
      usage: { status: "complete", costUsd: 0.01 },
    });
    const task: TaskSpec = {
      id: "review-source",
      taskMode: "review",
      goal: "Review the source file for concrete correctness and maintainability issues.",
      repoPath: root,
      acceptance: {
        steps: [
          {
            id: "syntax",
            command: process.execPath,
            args: ["-e", "process.exit(0)"],
          },
        ],
      },
      maxIterations: 5,
    };

    const result = await runSupervisorLoop(task, {
      runId: "run-review-test",
      skipWorktree: true,
      skipIntegrity: true,
      stream: false,
    });

    expect(result.reason).toBe("review_completed");
    expect(result.reviewOnly).toBe(true);
    expect(result.reviewReport).toMatchObject({
      verdict: "issues_found",
      acceptance: { passed: true },
    });
    expect(result.patch?.filesChanged).toBe(0);
    expect(await readFile(sourcePath, "utf-8")).toBe("export const value = 1;\n");

    const summary = JSON.parse(
      await readFile(join(stateDir, "run-review-test", "summary.json"), "utf-8"),
    ) as { reviewOnly?: boolean; reviewReport?: { findings?: unknown[] } };
    expect(summary.reviewOnly).toBe(true);
    expect(summary.reviewReport?.findings).toHaveLength(1);
  });

  it("returns review_incomplete when objective acceptance fails", async () => {
    vi.mocked(callClaude).mockResolvedValue({
      text: JSON.stringify({ summary: "No issues found.", verdict: "clean", findings: [] }),
      timedOut: false,
      durationMs: 5,
      usage: { status: "complete", costUsd: 0.01 },
    });
    const task: TaskSpec = {
      id: "review-failed-acceptance",
      taskMode: "review",
      goal: "Review the repository.",
      repoPath: root,
      acceptance: {
        steps: [
          {
            id: "failing-check",
            command: process.execPath,
            args: ["-e", "process.exit(1)"],
          },
        ],
      },
      maxIterations: 1,
    };

    const result = await runSupervisorLoop(task, {
      runId: "run-review-failed-acceptance",
      skipWorktree: true,
      skipIntegrity: true,
      stream: false,
    });

    expect(result.reason).toBe("review_incomplete");
    expect(result.reviewReport).toMatchObject({
      verdict: "clean",
      acceptance: { passed: false },
    });
  });

  it("preserves reviewer provider failures instead of parsing them as a report", async () => {
    vi.mocked(callClaude).mockResolvedValue({
      text: "[DRIVER ERROR] API Error: 402 Insufficient credit",
      timedOut: false,
      durationMs: 5,
      usage: { status: "unknown" },
      failure: {
        kind: "provider_error",
        category: "insufficient_credit",
        statusCode: 402,
        message: "Insufficient credit",
        retryable: false,
      },
    });
    const task: TaskSpec = {
      id: "review-provider-error",
      taskMode: "review",
      goal: "Review the repository.",
      repoPath: root,
      acceptance: {
        steps: [{ id: "syntax", command: process.execPath, args: ["-e", "process.exit(0)"] }],
      },
      maxIterations: 1,
    };

    const result = await runSupervisorLoop(task, {
      runId: "run-review-provider-error",
      skipWorktree: true,
      skipIntegrity: true,
      stream: false,
    });

    expect(result.reason).toBe("provider_error");
    expect(result.currentPhase).toBe("reviewing");
    expect(result.providerError).toMatchObject({
      category: "insufficient_credit",
      statusCode: 402,
    });
  });
});
