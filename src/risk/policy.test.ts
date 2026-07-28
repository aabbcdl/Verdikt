import { describe, expect, it } from "vitest";
import type { TaskSpec } from "../types.js";
import { evaluateTaskRisk } from "./policy.js";

function task(goal: string): TaskSpec {
  return {
    id: "risk-task",
    goal,
    repoPath: "/repo",
    acceptance: { steps: [{ id: "test", command: "npm", args: ["test"] }] },
    maxIterations: 2,
  };
}

describe("risk policy", () => {
  it("requires confirmation for production deployment language", () => {
    const result = evaluateTaskRisk(task("Deploy this change to production"));
    expect(result.categories).toContain("deployment");
    expect(result.categories).toContain("production");
    expect(result.action).toBe("confirm");
  });

  it("honors explicit stage risk declarations", () => {
    const value = task("Prepare a release");
    value.stages = [
      {
        id: "migrate",
        title: "Migrate",
        goal: "Run the migration",
        riskCategories: ["database"],
      },
    ];
    expect(evaluateTaskRisk(value, value.stages[0]).categories).toContain("database");
  });

  it("does not ask again for categories that were explicitly approved", () => {
    const value = task("Deploy this change to production");
    value.riskPolicy = { approvedCategories: ["deployment", "production"] };
    expect(evaluateTaskRisk(value).action).toBe("allow");
  });

  it("can deny detected high-risk work by policy", () => {
    const value = task("Delete the production database");
    value.riskPolicy = { mode: "deny" };
    expect(evaluateTaskRisk(value).action).toBe("deny");
  });
});
