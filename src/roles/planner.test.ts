import { describe, expect, it, vi } from "vitest";
import type { TaskSpec } from "../types.js";
import { runPlanner } from "./planner.js";

vi.mock("../claude/driver.js", () => ({
  callClaude: vi.fn().mockResolvedValue({ text: "plan", timedOut: false, durationMs: 1 }),
}));

it("runs the planning phase with read-only tools", async () => {
  const task: TaskSpec = {
    id: "plan",
    goal: "Redesign auth",
    repoPath: "/repo",
    acceptance: { steps: [{ id: "test", command: "npm", args: ["test"] }] },
    maxIterations: 3,
  };
  await runPlanner(task);
  const { callClaude } = await import("../claude/driver.js");
  expect(vi.mocked(callClaude).mock.calls[0][0].allowedTools).toEqual(["Read", "Glob", "Grep"]);
  expect(vi.mocked(callClaude).mock.calls[0][0].userPrompt).toContain("read-only");
});
