/**
 * Real-git integration tests for the final-patch pipeline.
 *
 * These tests exist because the previous mocked coverage asserted nothing:
 * a >1MB final diff used to crash a PASSED run with
 * ERR_CHILD_PROCESS_STDIO_MAXBUFFER at the very last step.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyFinalPatch, writeFinalPatch } from "./worktree.js";

const execFileAsync = promisify(execFile);

let tempDir = "";

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf-8" });
  return stdout;
}

async function initRepo(repoDir: string): Promise<void> {
  await git(tempDir, ["init", "-q", repoDir]);
  await git(repoDir, ["config", "user.email", "test@verdikt.local"]);
  await git(repoDir, ["config", "user.name", "Verdikt Test"]);
  await git(repoDir, ["config", "commit.gpgsign", "false"]);
  await git(repoDir, ["config", "core.autocrlf", "false"]);
}

describe("final patch pipeline (real git)", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "verdikt-worktree-int-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it("streams a final patch larger than the 1MB execFile buffer without failing", async () => {
    const repoDir = join(tempDir, "repo");
    await initRepo(repoDir);
    await writeFile(join(repoDir, "base.txt"), "base\n", "utf-8");
    await git(repoDir, ["add", "-A"]);
    await git(repoDir, ["commit", "-q", "-m", "base"]);
    const baseCommit = (await git(repoDir, ["rev-parse", "HEAD"])).trim();

    // ~1.7MB of new content — the exact shape that used to throw
    // ERR_CHILD_PROCESS_STDIO_MAXBUFFER through the buffered git() helper.
    const bigContent = Array.from(
      { length: 40_000 },
      (_, i) => `line-${i}-abcdefghijklmnopqrstuvwxyz0123456789`,
    ).join("\n");
    await writeFile(join(repoDir, "generated.txt"), bigContent, "utf-8");
    await git(repoDir, ["add", "-A"]);
    await git(repoDir, ["commit", "-q", "-m", "big change"]);

    const patchPath = join(tempDir, "final.patch");
    await writeFinalPatch(repoDir, baseCommit, patchPath);

    const patchStat = await stat(patchPath);
    expect(patchStat.size).toBeGreaterThan(1024 * 1024);
    const head = await readFile(patchPath, "utf-8");
    expect(head).toContain("diff --git a/generated.txt b/generated.txt");
  });

  it("writes an empty patch file when base and HEAD are identical", async () => {
    const repoDir = join(tempDir, "repo");
    await initRepo(repoDir);
    await writeFile(join(repoDir, "base.txt"), "base\n", "utf-8");
    await git(repoDir, ["add", "-A"]);
    await git(repoDir, ["commit", "-q", "-m", "base"]);
    const baseCommit = (await git(repoDir, ["rev-parse", "HEAD"])).trim();

    const patchPath = join(tempDir, "empty.patch");
    await writeFinalPatch(repoDir, baseCommit, patchPath);

    expect((await stat(patchPath)).size).toBe(0);
  });

  it("applyFinalPatch applies committed worktree changes back to the original repo", async () => {
    const repoDir = join(tempDir, "repo");
    await initRepo(repoDir);
    await writeFile(join(repoDir, "src.txt"), "original\n", "utf-8");
    await git(repoDir, ["add", "-A"]);
    await git(repoDir, ["commit", "-q", "-m", "base"]);
    const baseCommit = (await git(repoDir, ["rev-parse", "HEAD"])).trim();

    const worktreePath = join(tempDir, "workspace");
    await git(repoDir, ["worktree", "add", "--detach", worktreePath, "HEAD"]);
    await writeFile(join(worktreePath, "src.txt"), "modified by executor\n", "utf-8");
    await git(worktreePath, ["add", "-A"]);
    await git(worktreePath, ["commit", "-q", "-m", "executor change", "--no-gpg-sign"]);

    await applyFinalPatch(repoDir, worktreePath, baseCommit);

    expect(await readFile(join(repoDir, "src.txt"), "utf-8")).toBe("modified by executor\n");
    await git(repoDir, ["worktree", "remove", worktreePath, "--force"]).catch(() => {});
  });
});
