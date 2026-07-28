import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyPassedRun } from "../cli/apply.js";
import { resetConfig, setConfig } from "../config.js";
import { isWarmRepositoryReady, warmRepository } from "./warm.js";
import { createRunWorktree, discardRun } from "./worktree.js";

const execFileAsync = promisify(execFile);

describe("workspace prewarm", () => {
  let tempDir: string;
  let repoPath: string;
  let stateDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "verdikt-warm-"));
    repoPath = join(tempDir, "repo");
    stateDir = join(tempDir, ".verdikt");
    await mkdir(repoPath, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    setConfig({ stateDir });
    await git(repoPath, ["init"]);
    await git(repoPath, ["config", "user.email", "verdikt@example.test"]);
    await git(repoPath, ["config", "user.name", "Verdikt Test"]);
    await writeFile(join(repoPath, "value.txt"), "base\n", "utf-8");
    await git(repoPath, ["add", "."]);
    await git(repoPath, ["commit", "-m", "base"]);
  });

  afterEach(async () => {
    resetConfig();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("claims a clean prepared workspace once without leaking files into the next run", async () => {
    await warmRepository(repoPath, stateDir);
    expect(await isWarmRepositoryReady(repoPath, stateDir)).toBe(true);

    const firstRunDir = join(stateDir, "run-warm-first");
    await mkdir(firstRunDir, { recursive: true });
    const first = await createRunWorktree(repoPath, firstRunDir, "run-warm-first");
    expect(first.warmed).toBe(true);
    expect((await git(first.worktreePath, ["status", "--porcelain"])).trim()).toBe("");
    await expect(warmRepository(repoPath, stateDir)).rejects.toThrow("currently in use");
    await writeFile(join(first.worktreePath, "leak.txt"), "should not leak\n", "utf-8");
    await discardRun(repoPath, first.worktreePath, first.branchName);

    await warmRepository(repoPath, stateDir);
    const secondRunDir = join(stateDir, "run-warm-second");
    await mkdir(secondRunDir, { recursive: true });
    const second = await createRunWorktree(repoPath, secondRunDir, "run-warm-second");
    expect(second.warmed).toBe(true);
    await expect(readFile(join(second.worktreePath, "leak.txt"), "utf-8")).rejects.toThrow();
    expect((await readFile(join(second.worktreePath, "value.txt"), "utf-8")).trim()).toBe("base");
    await discardRun(repoPath, second.worktreePath, second.branchName);
  });

  it("can prepare another workspace after a warmed run is applied", async () => {
    await warmRepository(repoPath, stateDir);
    const runId = "run-warm-apply";
    const runDir = join(stateDir, runId);
    await mkdir(runDir, { recursive: true });
    const worktree = await createRunWorktree(repoPath, runDir, runId);
    expect(worktree.warmed).toBe(true);
    await writeFile(
      join(runDir, "summary.json"),
      JSON.stringify(
        {
          stopReason: "passed",
          applyStatus: "pending",
          workspace: {
            path: worktree.worktreePath,
            branchName: worktree.branchName,
            baseCommit: worktree.baseCommit,
            mode: "isolated",
            repoPath: worktree.repoPath,
            repoHead: worktree.repoHead,
            repoStatus: worktree.repoStatus,
            repoFingerprint: worktree.repoFingerprint,
            originalRepoCleanBeforeApply: worktree.originalRepoCleanBeforeApply,
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    await writeFile(join(runDir, "task.json"), JSON.stringify({ repoPath }, null, 2), "utf-8");
    await writeFile(join(runDir, "evidence", "final.patch"), "", "utf-8");

    await applyPassedRun(runId);
    await expect(warmRepository(repoPath, stateDir)).resolves.toMatchObject({ version: 1 });
    expect(await isWarmRepositoryReady(repoPath, stateDir)).toBe(true);
  });

  it("does not reuse a prepared workspace after the source HEAD changes", async () => {
    const prepared = await warmRepository(repoPath, stateDir);
    await writeFile(join(repoPath, "value.txt"), "new head\n", "utf-8");
    await git(repoPath, ["add", "."]);
    await git(repoPath, ["commit", "-m", "new head"]);
    const newHead = (await git(repoPath, ["rev-parse", "HEAD"])).trim();
    expect(newHead).not.toBe(prepared.baseCommit);

    const runDir = join(stateDir, "run-after-head-change");
    await mkdir(runDir, { recursive: true });
    const worktree = await createRunWorktree(repoPath, runDir, "run-after-head-change");
    expect(worktree.warmed).toBe(false);
    expect(worktree.baseCommit).toBe(newHead);
    expect((await readFile(join(worktree.worktreePath, "value.txt"), "utf-8")).trim()).toBe(
      "new head",
    );
    await discardRun(repoPath, worktree.worktreePath, worktree.branchName);
  });
});

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf-8" });
  return result.stdout;
}
