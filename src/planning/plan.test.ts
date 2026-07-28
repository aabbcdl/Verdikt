import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TaskSpec } from "../types.js";
import { readSavedPlan, shouldPlanTask, writeSavedPlan } from "./plan.js";

const task = (goal: string): TaskSpec => ({
  id: "task",
  goal,
  repoPath: "/repo",
  acceptance: { steps: [{ id: "test", command: "node", args: ["--version"] }] },
  maxIterations: 3,
});

describe("planning phase", () => {
  let runDir: string;
  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), "verdikt-plan-"));
  });
  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it("only auto-plans tasks with meaningful ambiguity or risk", () => {
    expect(shouldPlanTask({ ...task("Fix typo"), planning: { mode: "auto" } }, [])).toBe(false);
    expect(
      shouldPlanTask(
        { ...task("Redesign the authentication architecture"), planning: { mode: "auto" } },
        [],
      ),
    ).toBe(true);
    expect(
      shouldPlanTask({ ...task("Publish release"), planning: { mode: "auto" } }, ["deployment"]),
    ).toBe(true);
    expect(shouldPlanTask({ ...task("Fix typo"), planning: { mode: "required" } }, [])).toBe(true);
  });

  it("persists the plan separately from the source repository", async () => {
    await writeSavedPlan(runDir, "Inspect first, then make the smallest change.");
    expect(await readSavedPlan(runDir)).toContain("smallest change");
  });
});
