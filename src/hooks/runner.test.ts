import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TaskSpec } from "../types.js";
import { runLifecycleHooks } from "./runner.js";

describe("lifecycle hooks", () => {
  let repo: string;
  let task: TaskSpec;
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "verdikt-hooks-"));
    task = {
      id: "hooks",
      goal: "goal",
      repoPath: repo,
      acceptance: { steps: [{ id: "test", command: "node", args: ["--version"] }] },
      maxIterations: 2,
    };
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("passes structured context to an allowing hook", async () => {
    await writeFile(
      join(repo, "hook.mjs"),
      'let s=""; for await (const c of process.stdin) s+=c; const v=JSON.parse(s); console.log(JSON.stringify({allow:v.event==="before_run",message:v.taskId}));',
      "utf-8",
    );
    task.hooks = [{ event: "before_run", script: "hook.mjs", failureMode: "block" }];
    const result = await runLifecycleHooks(task, "before_run", { runId: "run-1" }, repo);
    expect(result[0]).toEqual(expect.objectContaining({ allowed: true, message: "hooks" }));
  });

  it("blocks when a blocking hook returns allow false", async () => {
    await writeFile(
      join(repo, "deny.mjs"),
      'console.log(JSON.stringify({allow:false,message:"policy denied"}))',
      "utf-8",
    );
    task.hooks = [{ event: "before_apply", script: "deny.mjs", failureMode: "block" }];
    await expect(runLifecycleHooks(task, "before_apply", {}, repo)).rejects.toThrow(
      "policy denied",
    );
  });

  it("contains a warning-mode hook failure", async () => {
    task.hooks = [{ event: "after_run", script: "missing.mjs", failureMode: "warn" }];
    const result = await runLifecycleHooks(task, "after_run", {}, repo);
    expect(result[0].allowed).toBe(false);
    expect(result[0].error).toContain("missing.mjs");
  });
});
