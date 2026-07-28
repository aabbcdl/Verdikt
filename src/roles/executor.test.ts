import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskSpec } from "../types.js";
import { runExecutor } from "./executor.js";

vi.mock("../claude/driver.js", () => ({
  callClaude: vi.fn().mockResolvedValue({ text: "ok", timedOut: false, durationMs: 1 }),
}));

vi.mock("../claude/platform.js", () => ({
  buildAllowedTools: vi.fn((tools: string[]) => [...tools, "Bash"]),
}));

describe("runExecutor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes runtime command approvals to the driver", async () => {
    const task: TaskSpec = {
      id: "risk-task",
      goal: "Prepare an approved release.",
      repoPath: "/repo",
      maxIterations: 2,
      acceptance: { testCommand: "pnpm test" },
      riskPolicy: { approvedCategories: ["deployment"], mode: "confirm" },
    };

    await runExecutor(task, "Continue.");

    const { callClaude } = await import("../claude/driver.js");
    expect(vi.mocked(callClaude).mock.calls[0][0].commandPolicy).toEqual({
      repoRoot: "/repo",
      approvedCategories: ["deployment"],
      allowAll: false,
    });
  });

  it("includes structured acceptance steps in the executor prompt", async () => {
    const task: TaskSpec = {
      id: "task-steps",
      goal: "Fix the failing calculator tests.",
      repoPath: "/repo",
      maxIterations: 3,
      acceptance: {
        steps: [
          { id: "test", command: "npm", args: ["test"], required: true },
          { id: "lint", command: "npm", args: ["run", "lint"], required: false },
        ],
      },
    };

    await runExecutor(task, "Start the first iteration.", undefined);

    const { callClaude } = await import("../claude/driver.js");
    const input = vi.mocked(callClaude).mock.calls[0][0];

    expect(input.userPrompt).toContain("test: npm test (required)");
    expect(input.userPrompt).toContain("lint: npm run lint (optional)");
    expect(input.userPrompt).not.toContain("undefined");
  });
});
