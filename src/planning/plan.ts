import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RiskCategory, TaskSpec } from "../types.js";

const AMBIGUITY_PATTERN =
  /\b(?:redesign|architecture|architectural|authentication|authorization|real[- ]?time|migration|refactor|restructure|caching|distributed|multi[- ]?repo)\b/i;

export function shouldPlanTask(task: TaskSpec, risks: RiskCategory[]): boolean {
  const mode = task.planning?.mode ?? "off";
  if (mode === "off") return false;
  if (mode === "required") return true;
  return (
    risks.length > 0 ||
    AMBIGUITY_PATTERN.test(task.goal) ||
    (task.stages?.length ?? 0) >= 3 ||
    task.goal.length >= 500
  );
}

export async function readSavedPlan(runDir: string): Promise<string | null> {
  try {
    const plan = (await readFile(planPath(runDir), "utf-8")).trim();
    return plan || null;
  } catch {
    return null;
  }
}

export async function writeSavedPlan(runDir: string, plan: string): Promise<string> {
  const normalized = plan.trim();
  if (!normalized) throw new Error("Planner returned an empty plan");
  await writeFile(planPath(runDir), `${normalized}\n`, "utf-8");
  return planPath(runDir);
}

export function planPath(runDir: string): string {
  return join(runDir, "plan.md");
}
