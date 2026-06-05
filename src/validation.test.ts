import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import type { TaskSpec } from "./types.js";
import { validateTaskSpec } from "./validation.js";

// Use project root as a known git repo for testing
const VALID_REPO = resolve(import.meta.dirname, "..");

function makeTask(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id: "test-task",
    goal: "Fix the authentication bug in the login flow",
    repoPath: VALID_REPO,
    acceptance: { steps: [{ id: "test", command: "npm", args: ["test"] }] },
    ...overrides,
  } as TaskSpec;
}

describe("validateTaskSpec", () => {
  it("passes on valid task", () => {
    const result = validateTaskSpec(makeTask(), "test.task.json");
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("fails on missing id", () => {
    const task = makeTask();
    delete (task as any).id;
    const result = validateTaskSpec(task, "test.task.json");
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toBe("id");
  });

  it("fails on missing goal", () => {
    const task = makeTask();
    delete (task as any).goal;
    const result = validateTaskSpec(task, "test.task.json");
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toBe("goal");
  });

  it("fails on missing repoPath", () => {
    const task = makeTask();
    delete (task as any).repoPath;
    const result = validateTaskSpec(task, "test.task.json");
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toBe("repoPath");
  });

  it("fails on nonexistent repoPath", () => {
    const result = validateTaskSpec(makeTask({ repoPath: "/nonexistent/path" }), "test.task.json");
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toBe("repoPath");
    expect(result.errors[0].fix).toContain("Check the repoPath");
  });

  it("fails on template placeholder goal", () => {
    const result = validateTaskSpec(
      makeTask({ goal: "Describe what the executor should accomplish" }),
      "test.task.json"
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toBe("goal");
  });

  it("warns on short goal", () => {
    const result = validateTaskSpec(makeTask({ goal: "Fix it" }), "test.task.json");
    expect(result.valid).toBe(true);
    expect(result.warnings[0].field).toBe("goal");
  });

  it("warns on special characters in id", () => {
    const result = validateTaskSpec(makeTask({ id: "my task!" }), "test.task.json");
    expect(result.warnings[0].field).toBe("id");
  });

  it("fails on missing acceptance", () => {
    const task = makeTask();
    delete (task as any).acceptance;
    const result = validateTaskSpec(task, "test.task.json");
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toBe("acceptance");
  });

  it("fails on acceptance with no steps or testCommand", () => {
    const result = validateTaskSpec(makeTask({ acceptance: {} }), "test.task.json");
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toBe("acceptance");
  });

  it("warns when both testCommand and steps defined", () => {
    const result = validateTaskSpec(
      makeTask({
        acceptance: {
          testCommand: "npm test",
          steps: [{ id: "test", command: "npm", args: ["test"] }],
        },
      }),
      "test.task.json"
    );
    expect(result.warnings.some((w) => w.field === "acceptance")).toBe(true);
  });

  it("fails on step missing id", () => {
    const result = validateTaskSpec(
      makeTask({
        acceptance: {
          steps: [{ id: "", command: "npm", args: ["test"] } as any],
        },
      }),
      "test.task.json"
    );
    expect(result.valid).toBe(false);
  });

  it("fails on step missing command", () => {
    const result = validateTaskSpec(
      makeTask({
        acceptance: {
          steps: [{ id: "test", command: "", args: ["test"] } as any],
        },
      }),
      "test.task.json"
    );
    expect(result.valid).toBe(false);
  });

  it("warns on unusual maxIterations", () => {
    const result = validateTaskSpec(makeTask({ maxIterations: 50 }), "test.task.json");
    expect(result.warnings[0].field).toBe("maxIterations");
  });

  it("warns on very low maxBudgetUsd", () => {
    const result = validateTaskSpec(makeTask({ maxBudgetUsd: 0.1 }), "test.task.json");
    expect(result.warnings[0].field).toBe("maxBudgetUsd");
  });
});
