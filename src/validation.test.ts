import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
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
    // biome-ignore lint/suspicious/noExplicitAny: testing validation of missing fields
    (task as any).id = undefined;
    const result = validateTaskSpec(task, "test.task.json");
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toBe("id");
  });

  it("fails on missing goal", () => {
    const task = makeTask();
    // biome-ignore lint/suspicious/noExplicitAny: testing validation of missing fields
    (task as any).goal = undefined;
    const result = validateTaskSpec(task, "test.task.json");
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toBe("goal");
  });

  it("fails on missing repoPath", () => {
    const task = makeTask();
    // biome-ignore lint/suspicious/noExplicitAny: testing validation of missing fields
    (task as any).repoPath = undefined;
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
      "test.task.json",
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
    // biome-ignore lint/suspicious/noExplicitAny: testing validation of missing fields
    (task as any).acceptance = undefined;
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
      "test.task.json",
    );
    expect(result.warnings.some((w) => w.field === "acceptance")).toBe(true);
  });

  it("fails when legacy shell commands contain newlines", () => {
    const result = validateTaskSpec(
      makeTask({
        acceptance: {
          testCommand: "npm test\nnpm run build",
        },
      }),
      "test.task.json",
    );

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.field === "acceptance.testCommand")).toBe(true);
  });

  it("fails on step missing id", () => {
    const result = validateTaskSpec(
      makeTask({
        acceptance: {
          // biome-ignore lint/suspicious/noExplicitAny: testing validation of invalid steps
          steps: [{ id: "", command: "npm", args: ["test"] } as any],
        },
      }),
      "test.task.json",
    );
    expect(result.valid).toBe(false);
  });

  it("fails on step missing command", () => {
    const result = validateTaskSpec(
      makeTask({
        acceptance: {
          // biome-ignore lint/suspicious/noExplicitAny: testing validation of invalid steps
          steps: [{ id: "test", command: "", args: ["test"] } as any],
        },
      }),
      "test.task.json",
    );
    expect(result.valid).toBe(false);
  });

  it("fails on malformed acceptance steps instead of throwing", () => {
    const result = validateTaskSpec(
      makeTask({
        acceptance: {
          // biome-ignore lint/suspicious/noExplicitAny: testing validation of malformed user input
          steps: [null as any],
        },
      }),
      "test.task.json",
    );

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.field === "acceptance.steps[0]")).toBe(true);
  });

  it("fails when step args are not an array of strings", () => {
    const result = validateTaskSpec(
      makeTask({
        acceptance: {
          // biome-ignore lint/suspicious/noExplicitAny: testing validation of malformed user input
          steps: [{ id: "test", command: "node", args: [1] } as any],
        },
      }),
      "test.task.json",
    );

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.field === "acceptance.steps[0].args")).toBe(true);
  });

  it("fails when command timeouts are not positive numbers", () => {
    const result = validateTaskSpec(
      makeTask({
        acceptance: {
          timeoutMs: 0,
          steps: [{ id: "test", command: "node", args: ["--version"], timeoutMs: -1 }],
        },
      }),
      "test.task.json",
    );

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.field === "acceptance.timeoutMs")).toBe(true);
    expect(result.errors.some((error) => error.field === "acceptance.steps[0].timeoutMs")).toBe(
      true,
    );
  });

  it("fails when step cwd tries to leave the repository", () => {
    const result = validateTaskSpec(
      makeTask({
        acceptance: {
          steps: [{ id: "test", command: "node", args: ["--version"], cwd: ".." }],
        },
      }),
      "test.task.json",
    );

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.field === "acceptance.steps[0].cwd")).toBe(true);
  });

  it("fails when custom judge script is absolute", () => {
    const result = validateTaskSpec(
      makeTask({
        acceptance: {
          custom: { script: resolve(VALID_REPO, "judge.js") },
        },
      }),
      "test.task.json",
    );

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.field === "acceptance.custom.script")).toBe(true);
  });

  it("fails when custom judge script tries to leave the repository", () => {
    const result = validateTaskSpec(
      makeTask({
        acceptance: {
          custom: { script: "../judge.js" },
        },
      }),
      "test.task.json",
    );

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.field === "acceptance.custom.script")).toBe(true);
  });

  it("fails when all acceptance steps are optional", () => {
    const result = validateTaskSpec(
      makeTask({
        acceptance: {
          steps: [{ id: "lint", command: "npm", args: ["run", "lint"], required: false }],
        },
      }),
      "test.task.json",
    );

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.field === "acceptance.steps")).toBe(true);
  });

  it("warns on unusual maxIterations", () => {
    const result = validateTaskSpec(makeTask({ maxIterations: 50 }), "test.task.json");
    expect(result.warnings[0].field).toBe("maxIterations");
  });

  it("warns on very low maxBudgetUsd", () => {
    const result = validateTaskSpec(makeTask({ maxBudgetUsd: 0.1 }), "test.task.json");
    expect(result.warnings[0].field).toBe("maxBudgetUsd");
  });

  it("accepts ordered task stages", () => {
    const result = validateTaskSpec(
      makeTask({
        stages: [
          { id: "diagnose", title: "Diagnose", goal: "Find the failing behavior" },
          { id: "fix", title: "Fix", goal: "Implement the smallest safe fix" },
        ],
      }),
      "test.task.json",
    );

    expect(result.valid).toBe(true);
  });

  it("validates execution timeout ordering and positive values", () => {
    const result = validateTaskSpec(
      makeTask({ execution: { softTimeoutMs: 50_000, idleTimeoutMs: 10_000, hardTimeoutMs: -1 } }),
      "test.task.json",
    );

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.field === "execution.hardTimeoutMs")).toBe(true);
    expect(result.errors.some((error) => error.field === "execution.softTimeoutMs")).toBe(true);
  });

  it("rejects unknown risk modes and categories", () => {
    const result = validateTaskSpec(
      makeTask({
        riskPolicy: { mode: "sometimes", declaredCategories: ["unknown"] },
      } as unknown as Partial<TaskSpec>),
      "test.task.json",
    );

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.field === "riskPolicy.mode")).toBe(true);
    expect(result.errors.some((error) => error.field === "riskPolicy.declaredCategories[0]")).toBe(
      true,
    );
  });

  it("validates stage limits, approvals, and risk categories", () => {
    const result = validateTaskSpec(
      makeTask({
        stages: [
          {
            id: "release",
            title: "Release",
            goal: "Prepare release",
            maxIterations: 0,
            maxBudgetUsd: -2,
            requireApproval: "yes",
            riskCategories: ["unknown"],
          },
        ],
      } as unknown as Partial<TaskSpec>),
      "test.task.json",
    );

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.field === "stages[0].maxIterations")).toBe(true);
    expect(result.errors.some((error) => error.field === "stages[0].maxBudgetUsd")).toBe(true);
    expect(result.errors.some((error) => error.field === "stages[0].requireApproval")).toBe(true);
    expect(result.errors.some((error) => error.field === "stages[0].riskCategories[0]")).toBe(true);
  });

  it("validates nested stage acceptance with the same rules as top-level acceptance", () => {
    const result = validateTaskSpec(
      makeTask({
        stages: [
          {
            id: "verify",
            title: "Verify",
            goal: "Run stage checks",
            acceptance: {
              timeoutMs: -1,
              steps: [{ id: "", command: "", args: [1] }],
            },
          },
        ],
      } as unknown as Partial<TaskSpec>),
      "test.task.json",
    );

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.field === "stages[0].acceptance.timeoutMs")).toBe(
      true,
    );
    expect(result.errors.some((error) => error.field === "stages[0].acceptance.steps[0].id")).toBe(
      true,
    );
    expect(
      result.errors.some((error) => error.field === "stages[0].acceptance.steps[0].command"),
    ).toBe(true);
    expect(
      result.errors.some((error) => error.field === "stages[0].acceptance.steps[0].args"),
    ).toBe(true);
  });

  it("validates planning modes and approval settings", () => {
    const valid = validateTaskSpec(
      makeTask({ planning: { mode: "required", requireApproval: true } }),
      "test.task.json",
    );
    const invalid = validateTaskSpec(
      makeTask({
        planning: { mode: "sometimes", requireApproval: "yes" },
      } as unknown as Partial<TaskSpec>),
      "test.task.json",
    );

    expect(valid.valid).toBe(true);
    expect(invalid.errors.some((error) => error.field === "planning.mode")).toBe(true);
    expect(invalid.errors.some((error) => error.field === "planning.requireApproval")).toBe(true);
  });

  it("validates lifecycle hook event, path, timeout, and failure mode", () => {
    const valid = validateTaskSpec(
      makeTask({
        hooks: [
          {
            event: "before_run",
            script: "examples/hooks/allow.cjs",
            timeoutMs: 15_000,
            failureMode: "block",
          },
        ],
      }),
      "test.task.json",
    );
    const invalid = validateTaskSpec(
      makeTask({
        hooks: [
          {
            event: "unknown",
            script: "../outside.ts",
            timeoutMs: 10,
            failureMode: "ignore",
          },
        ],
      } as unknown as Partial<TaskSpec>),
      "test.task.json",
    );

    expect(valid.valid).toBe(true);
    expect(invalid.errors.some((error) => error.field === "hooks[0].event")).toBe(true);
    expect(invalid.errors.some((error) => error.field === "hooks[0].script")).toBe(true);
    expect(invalid.errors.some((error) => error.field === "hooks[0].timeoutMs")).toBe(true);
    expect(invalid.errors.some((error) => error.field === "hooks[0].failureMode")).toBe(true);
  });

  it("limits the number of lifecycle hooks", () => {
    const hooks = Array.from({ length: 21 }, () => ({
      event: "after_run" as const,
      script: "examples/hooks/allow.cjs",
    }));
    const result = validateTaskSpec(makeTask({ hooks }), "test.task.json");

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.field === "hooks")).toBe(true);
  });

  it("fails when task stage ids are duplicated", () => {
    const result = validateTaskSpec(
      makeTask({
        stages: [
          { id: "fix", title: "Fix", goal: "Implement the fix" },
          { id: "fix", title: "Verify", goal: "Verify the fix" },
        ],
      }),
      "test.task.json",
    );

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.field === "stages[1].id")).toBe(true);
  });
});

it("accepts review task mode and rejects unknown modes", () => {
  const review = makeTask({ taskMode: "review" });
  expect(validateTaskSpec(review, "task.json").valid).toBe(true);

  const invalid = makeTask({ taskMode: "delete" as TaskSpec["taskMode"] });
  const result = validateTaskSpec(invalid, "task.json");
  expect(result.valid).toBe(false);
  expect(result.errors.some((error) => error.field === "taskMode")).toBe(true);
});
