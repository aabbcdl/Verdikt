import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectDiff, collectEvidence } from "./collectEvidence.js";

let tempDir: string;
let repoDir: string;

async function git(args: string[], cwd = repoDir): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    execFile("git", args, { cwd, timeout: 60_000 }, (err, _stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve();
    });
  });
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "verdikt evidence test-"));
  repoDir = join(tempDir, "repo with spaces");
  await mkdir(join(repoDir, "src"), { recursive: true });
  await git(["init"]);
  await git(["config", "user.email", "test@test.com"]);
  await git(["config", "user.name", "test"]);
  await writeFile(join(repoDir, "src", "app.ts"), "export const value = 1;\n", "utf-8");
  await git(["add", "-A"]);
  await git(["commit", "-m", "init", "--allow-empty", "--no-gpg-sign"]);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("collectEvidence", () => {
  it("collects modified and untracked files from a repo path with spaces", async () => {
    await writeFile(join(repoDir, "src", "app.ts"), "export const value = 2;\n", "utf-8");
    await writeFile(join(repoDir, "src", "new.ts"), "export const added = true;\n", "utf-8");

    await expect(collectEvidence(repoDir)).resolves.toEqual(["src/app.ts", "src/new.ts"]);
  });

  it("fails clearly when evidence cannot be collected", async () => {
    const nonRepoDir = join(tempDir, "not a repo");
    await mkdir(nonRepoDir);

    await expect(collectEvidence(nonRepoDir)).rejects.toThrow(
      /git (diff --name-only HEAD|ls-files --others --exclude-standard) failed/,
    );
  });
});

describe("collectDiff", () => {
  it("collects the full diff for modified tracked files", async () => {
    await writeFile(join(repoDir, "src", "app.ts"), "export const value = 2;\n", "utf-8");

    const diff = await collectDiff(repoDir);

    expect(diff).toContain("-export const value = 1;");
    expect(diff).toContain("+export const value = 2;");
  });
});
