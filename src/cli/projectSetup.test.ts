import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { inspectProject } from "./projectSetup.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createRepo(): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), "verdikt-project-setup-"));
  tempDirs.push(repoPath);
  await execFileAsync("git", ["init", "-q"], { cwd: repoPath });
  await execFileAsync("git", ["config", "user.email", "test@verdikt.local"], { cwd: repoPath });
  await execFileAsync("git", ["config", "user.name", "Verdikt Test"], { cwd: repoPath });
  await execFileAsync("git", ["config", "commit.gpgsign", "false"], { cwd: repoPath });
  return repoPath;
}

async function commitAll(repoPath: string): Promise<void> {
  await execFileAsync("git", ["add", "-A"], { cwd: repoPath });
  await execFileAsync("git", ["commit", "-q", "-m", "base"], { cwd: repoPath });
}

describe("project setup inspection", () => {
  it("detects the package manager and useful project scripts", async () => {
    const repoPath = await createRepo();
    await writeFile(
      join(repoPath, "package.json"),
      JSON.stringify({
        packageManager: "pnpm@11.7.0",
        scripts: { test: "vitest run", lint: "biome check .", start: "node index.js" },
      }),
      "utf-8",
    );
    await writeFile(join(repoPath, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf-8");
    await commitAll(repoPath);

    const result = await inspectProject(repoPath);

    expect(result.ok).toBe(true);
    expect(result.packageManager).toBe("pnpm");
    expect(result.recommendedSteps).toEqual([
      expect.objectContaining({ id: "test", command: "pnpm", args: ["run", "test"] }),
      expect.objectContaining({ id: "lint", command: "pnpm", args: ["run", "lint"] }),
    ]);
    expect(result.recommendedSteps.some((step) => step.id === "start")).toBe(false);
  });

  it("blocks dirty repositories before a task can spend money", async () => {
    const repoPath = await createRepo();
    await writeFile(join(repoPath, "README.md"), "base\n", "utf-8");
    await commitAll(repoPath);
    await writeFile(join(repoPath, "README.md"), "changed\n", "utf-8");

    const result = await inspectProject(repoPath);

    expect(result.ok).toBe(false);
    expect(result.git.clean).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "dirty_repo" }));
  });

  it("does not invent an acceptance command for an unknown project", async () => {
    const repoPath = await createRepo();
    await writeFile(join(repoPath, "README.md"), "plain project\n", "utf-8");
    await commitAll(repoPath);

    const result = await inspectProject(repoPath);

    expect(result.ok).toBe(true);
    expect(result.recommendedSteps).toEqual([]);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "no_acceptance" }));
  });
});
