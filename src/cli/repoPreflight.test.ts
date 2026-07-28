import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkRepoPreflight } from "./repoPreflight.js";

const execFileAsync = promisify(execFile);

let tempDir = "";

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, encoding: "utf-8" });
}

async function initRepo(repoDir: string): Promise<void> {
  await git(tempDir, ["init", "-q", repoDir]);
  await git(repoDir, ["config", "user.email", "test@verdikt.local"]);
  await git(repoDir, ["config", "user.name", "Verdikt Test"]);
  await git(repoDir, ["config", "commit.gpgsign", "false"]);
  await writeFile(join(repoDir, "base.txt"), "base\n", "utf-8");
  await git(repoDir, ["add", "-A"]);
  await git(repoDir, ["commit", "-q", "-m", "base"]);
}

describe("checkRepoPreflight", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "verdikt-preflight-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it("passes a clean git repository", async () => {
    const repoDir = join(tempDir, "clean");
    await initRepo(repoDir);

    const result = await checkRepoPreflight(repoDir, false);
    expect(result).toEqual({ ok: true, dirty: false });
  });

  it("rejects a dirty repository with the offending files and a fix", async () => {
    const repoDir = join(tempDir, "dirty");
    await initRepo(repoDir);
    await writeFile(join(repoDir, "base.txt"), "modified\n", "utf-8");
    await writeFile(join(repoDir, "new.txt"), "untracked\n", "utf-8");

    const result = await checkRepoPreflight(repoDir, false);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.reason).toBe("dirty");
    expect(result.dirtyFiles).toContain("base.txt");
    expect(result.dirtyFiles).toContain("new.txt");
    expect(result.message).toContain("未提交");
    expect(result.fix).toContain("allowDirtyRepo");
  });

  it("passes a dirty repository when allowDirtyRepo is set", async () => {
    const repoDir = join(tempDir, "dirty-allowed");
    await initRepo(repoDir);
    await writeFile(join(repoDir, "base.txt"), "modified\n", "utf-8");

    const result = await checkRepoPreflight(repoDir, true);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected pass");
    expect(result.dirty).toBe(true);
  });

  it("passes non-git directories through (workspace creation reports its own error)", async () => {
    // Run the check from a repo root fixture is not possible here — the temp
    // dir may itself live under some larger repository, which is exactly the
    // subdirectory pass-through case asserted below.
    const repoDir = join(tempDir, "outer");
    await initRepo(repoDir);
    const plainDir = join(repoDir, "plain-non-root");
    await mkdir(plainDir, { recursive: true });
    await writeFile(join(repoDir, "wip.txt"), "dirty parent\n", "utf-8");

    const result = await checkRepoPreflight(plainDir, false);
    expect(result).toEqual({ ok: true, dirty: false });
  });

  it("does not blame a subdirectory for its parent repository's dirty state", async () => {
    const repoDir = join(tempDir, "parent-repo");
    await initRepo(repoDir);
    await writeFile(join(repoDir, "parent-wip.txt"), "uncommitted parent work\n", "utf-8");
    const subDir = join(repoDir, "nested", "project");
    await mkdir(subDir, { recursive: true });

    const result = await checkRepoPreflight(subDir, false);
    expect(result).toEqual({ ok: true, dirty: false });
  });
});
