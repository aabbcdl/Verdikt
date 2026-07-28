import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetConfig, setConfig } from "../config.js";
import { verifyEvidenceManifest } from "../evidence/manifest.js";
import { acquireLock, checkLock } from "../workspace/lock.js";
import { captureRepositorySnapshot } from "../workspace/repoIdentity.js";
import { applyPassedRun } from "./apply.js";

async function git(cwd: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile("git", args, { cwd, timeout: 30_000 }, (err, _stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve();
    });
  });
}

async function writeRunSummary(
  runDir: string,
  repoDir: string,
  summary: Record<string, unknown>,
): Promise<void> {
  const snapshot = await captureRepositorySnapshot(repoDir);
  await writeFile(
    join(runDir, "summary.json"),
    JSON.stringify(
      {
        ...summary,
        workspace: {
          path: join(runDir, "workspace"),
          baseCommit: snapshot.head,
          originalRepoCleanBeforeApply: snapshot.clean,
          mode: "isolated",
          repoPath: snapshot.repoPath,
          repoHead: snapshot.head,
          repoStatus: snapshot.status,
          repoFingerprint: snapshot.fingerprint,
          branchName: `verdikt/${basename(runDir)}`,
        },
      },
      null,
      2,
    ),
    "utf-8",
  );
}

describe("applyPassedRun", () => {
  let tempDir: string;
  let repoDir: string;
  let stateDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "verdikt-apply-test-"));
    repoDir = join(tempDir, "repo");
    stateDir = join(tempDir, ".verdikt");
    await mkdir(repoDir, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    setConfig({ stateDir });

    await git(repoDir, ["init"]);
    await git(repoDir, ["config", "user.email", "test@test.com"]);
    await git(repoDir, ["config", "user.name", "test"]);
    await writeFile(join(repoDir, "file.txt"), "before\n", "utf-8");
    await git(repoDir, ["add", "-A"]);
    await git(repoDir, ["commit", "-m", "init", "--no-gpg-sign"]);
  }, 30_000);

  afterEach(async () => {
    resetConfig();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }, 30_000);

  it("applies a passed run patch and records the apply status", async () => {
    const runId = "run-apply-001";
    const runDir = join(stateDir, runId);
    await mkdir(join(runDir, "evidence"), { recursive: true });
    await writeRunSummary(runDir, repoDir, { stopReason: "passed", applyStatus: "pending" });
    await writeFile(
      join(runDir, "task.json"),
      JSON.stringify({ repoPath: repoDir }, null, 2),
      "utf-8",
    );
    await writeFile(
      join(runDir, "evidence", "final.patch"),
      [
        "diff --git a/file.txt b/file.txt",
        "--- a/file.txt",
        "+++ b/file.txt",
        "@@ -1 +1 @@",
        "-before",
        "+after",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = await applyPassedRun(runId);

    expect(result.repoPath).toBe(repoDir);
    expect((await readFile(join(repoDir, "file.txt"), "utf-8")).trim()).toBe("after");
    const summary = JSON.parse(await readFile(join(runDir, "summary.json"), "utf-8"));
    expect(summary.applyStatus).toBe("applied");
    expect(summary.appliedAt).toBeDefined();
    expect((await verifyEvidenceManifest(runDir)).valid).toBe(true);
  });

  it("cleans up the saved workspace and lock after applying a patch", async () => {
    const runId = "run-apply-cleanup";
    const runDir = join(stateDir, runId);
    const worktreePath = join(runDir, "workspace");
    await mkdir(join(runDir, "evidence"), { recursive: true });
    await mkdir(worktreePath, { recursive: true });
    await writeFile(join(worktreePath, "leftover.txt"), "temporary workspace\n", "utf-8");
    await writeRunSummary(runDir, repoDir, { stopReason: "passed", applyStatus: "pending" });
    await writeFile(
      join(runDir, "task.json"),
      JSON.stringify({ repoPath: repoDir }, null, 2),
      "utf-8",
    );
    await writeFile(
      join(runDir, "evidence", "final.patch"),
      [
        "diff --git a/file.txt b/file.txt",
        "--- a/file.txt",
        "+++ b/file.txt",
        "@@ -1 +1 @@",
        "-before",
        "+after",
        "",
      ].join("\n"),
      "utf-8",
    );
    expect(acquireLock(stateDir, repoDir, runId)).toBe(true);

    await applyPassedRun(runId);

    expect(existsSync(worktreePath)).toBe(false);
    expect(checkLock(stateDir, repoDir)).toBeNull();
  });

  it("treats an empty final patch as already applied", async () => {
    const runId = "run-empty-patch";
    const runDir = join(stateDir, runId);
    await mkdir(join(runDir, "evidence"), { recursive: true });
    await writeRunSummary(runDir, repoDir, { stopReason: "passed", applyStatus: "pending" });
    await writeFile(
      join(runDir, "task.json"),
      JSON.stringify({ repoPath: repoDir }, null, 2),
      "utf-8",
    );
    await writeFile(join(runDir, "evidence", "final.patch"), "", "utf-8");

    await expect(applyPassedRun(runId)).resolves.toMatchObject({ runId, repoPath: repoDir });

    expect((await readFile(join(repoDir, "file.txt"), "utf-8")).trim()).toBe("before");
    const summary = JSON.parse(await readFile(join(runDir, "summary.json"), "utf-8"));
    expect(summary.applyStatus).toBe("applied");
    expect(summary.appliedAt).toBeDefined();
  });

  it("does not apply the same run twice after it is already marked applied", async () => {
    const runId = "run-apply-idempotent";
    const runDir = join(stateDir, runId);
    await mkdir(join(runDir, "evidence"), { recursive: true });
    await writeRunSummary(runDir, repoDir, { stopReason: "passed", applyStatus: "pending" });
    await writeFile(
      join(runDir, "task.json"),
      JSON.stringify({ repoPath: repoDir }, null, 2),
      "utf-8",
    );
    await writeFile(
      join(runDir, "evidence", "final.patch"),
      [
        "diff --git a/file.txt b/file.txt",
        "--- a/file.txt",
        "+++ b/file.txt",
        "@@ -1 +1 @@",
        "-before",
        "+after",
        "",
      ].join("\n"),
      "utf-8",
    );

    await applyPassedRun(runId);
    await expect(applyPassedRun(runId)).resolves.toMatchObject({ runId, repoPath: repoDir });

    expect((await readFile(join(repoDir, "file.txt"), "utf-8")).trim()).toBe("after");
  });

  it("requires revalidation when the target repository already contains the patch", async () => {
    const runId = "run-patch-already-present";
    const runDir = join(stateDir, runId);
    await mkdir(join(runDir, "evidence"), { recursive: true });
    await writeFile(join(repoDir, "file.txt"), "after\n", "utf-8");
    await writeRunSummary(runDir, repoDir, { stopReason: "passed", applyStatus: "pending" });
    await writeFile(
      join(runDir, "task.json"),
      JSON.stringify({ repoPath: repoDir }, null, 2),
      "utf-8",
    );
    await writeFile(
      join(runDir, "evidence", "final.patch"),
      [
        "diff --git a/file.txt b/file.txt",
        "--- a/file.txt",
        "+++ b/file.txt",
        "@@ -1 +1 @@",
        "-before",
        "+after",
        "",
      ].join("\n"),
      "utf-8",
    );

    await expect(applyPassedRun(runId)).rejects.toThrow("revalidation_required");

    expect((await readFile(join(repoDir, "file.txt"), "utf-8")).trim()).toBe("after");
    const summary = JSON.parse(await readFile(join(runDir, "summary.json"), "utf-8"));
    expect(summary.applyStatus).toBe("pending");
  });

  it("rolls back the repository when acceptance fails after the patch is applied", async () => {
    const runId = "run-apply-rollback";
    const runDir = join(stateDir, runId);
    await writeFile(
      join(repoDir, "acceptance.cjs"),
      "process.exit(process.cwd().includes('.integration') ? 0 : 1);\n",
      "utf-8",
    );
    await git(repoDir, ["add", "acceptance.cjs"]);
    await git(repoDir, ["commit", "-m", "add acceptance fixture", "--no-gpg-sign"]);
    await mkdir(join(runDir, "evidence"), { recursive: true });
    await writeRunSummary(runDir, repoDir, { stopReason: "passed", applyStatus: "pending" });
    await writeFile(
      join(runDir, "task.json"),
      JSON.stringify(
        {
          id: runId,
          goal: "verify rollback",
          repoPath: repoDir,
          acceptance: {
            steps: [
              {
                id: "integration-only",
                command: "node",
                args: ["acceptance.cjs"],
              },
            ],
          },
          maxIterations: 1,
        },
        null,
        2,
      ),
      "utf-8",
    );
    await writeFile(
      join(runDir, "evidence", "final.patch"),
      [
        "diff --git a/file.txt b/file.txt",
        "--- a/file.txt",
        "+++ b/file.txt",
        "@@ -1 +1 @@",
        "-before",
        "+after",
        "",
      ].join("\n"),
      "utf-8",
    );

    await expect(applyPassedRun(runId)).rejects.toThrow(
      "Applied patch failed acceptance checks and was rolled back",
    );

    expect((await readFile(join(repoDir, "file.txt"), "utf-8")).trim()).toBe("before");
    const summary = JSON.parse(await readFile(join(runDir, "summary.json"), "utf-8"));
    expect(summary.applyStatus).toBe("pending");
  });

  it("refuses to apply a run that was already discarded", async () => {
    const runId = "run-already-discarded";
    const runDir = join(stateDir, runId);
    await mkdir(join(runDir, "evidence"), { recursive: true });
    await writeRunSummary(runDir, repoDir, { stopReason: "passed", applyStatus: "discarded" });
    await writeFile(
      join(runDir, "task.json"),
      JSON.stringify({ repoPath: repoDir }, null, 2),
      "utf-8",
    );
    await writeFile(
      join(runDir, "evidence", "final.patch"),
      [
        "diff --git a/file.txt b/file.txt",
        "--- a/file.txt",
        "+++ b/file.txt",
        "@@ -1 +1 @@",
        "-before",
        "+after",
        "",
      ].join("\n"),
      "utf-8",
    );

    await expect(applyPassedRun(runId)).rejects.toThrow("already discarded");
    expect((await readFile(join(repoDir, "file.txt"), "utf-8")).trim()).toBe("before");
  });

  it("rejects run IDs that try to leave the state directory", async () => {
    await expect(applyPassedRun("../outside")).rejects.toThrow("Invalid run ID");
    expect(existsSync(join(tempDir, "outside"))).toBe(false);
  });

  it("refuses to apply when the original repo path is missing", async () => {
    const runId = "run-missing-task";
    const runDir = join(stateDir, runId);
    await mkdir(join(runDir, "evidence"), { recursive: true });
    await writeRunSummary(runDir, repoDir, { stopReason: "passed", applyStatus: "pending" });
    await writeFile(join(runDir, "evidence", "final.patch"), "", "utf-8");

    await expect(applyPassedRun(runId)).rejects.toThrow("task.json is missing");
  });

  it("refuses to apply when task.json has no repoPath instead of using the current directory", async () => {
    const runId = "run-missing-repo-path";
    const runDir = join(stateDir, runId);
    const unsafeCwd = join(tempDir, "unsafe-cwd");
    await mkdir(unsafeCwd, { recursive: true });
    await git(unsafeCwd, ["init"]);
    await git(unsafeCwd, ["config", "user.email", "test@test.com"]);
    await git(unsafeCwd, ["config", "user.name", "test"]);
    await writeFile(join(unsafeCwd, "file.txt"), "before\n", "utf-8");
    await git(unsafeCwd, ["add", "-A"]);
    await git(unsafeCwd, ["commit", "-m", "init", "--no-gpg-sign"]);

    await mkdir(join(runDir, "evidence"), { recursive: true });
    await writeRunSummary(runDir, repoDir, { stopReason: "passed", applyStatus: "pending" });
    await writeFile(join(runDir, "task.json"), JSON.stringify({}, null, 2), "utf-8");
    await writeFile(
      join(runDir, "evidence", "final.patch"),
      [
        "diff --git a/file.txt b/file.txt",
        "--- a/file.txt",
        "+++ b/file.txt",
        "@@ -1 +1 @@",
        "-before",
        "+after",
        "",
      ].join("\n"),
      "utf-8",
    );

    const originalCwd = process.cwd();
    try {
      process.chdir(unsafeCwd);
      await expect(applyPassedRun(runId)).rejects.toThrow("repoPath is missing");
    } finally {
      process.chdir(originalCwd);
    }

    expect((await readFile(join(unsafeCwd, "file.txt"), "utf-8")).trim()).toBe("before");
  });
});
