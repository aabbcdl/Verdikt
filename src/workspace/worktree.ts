/**
 * Workspace isolation via git worktree.
 *
 * Each run gets its own worktree so the original repo stays clean.
 * Per-iteration diffs are captured as patch files.
 * On success: apply final patch back to the original repo.
 * On failure: discard the worktree, original repo untouched.
 */

import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { captureRepositorySnapshot } from "./repoIdentity.js";
import { claimWarmWorkspace } from "./warm.js";

export interface WorktreeInfo {
  /** Absolute path to the worktree directory */
  worktreePath: string;
  /** The branch name in the worktree */
  branchName: string;
  /** Commit hash at the start of the run */
  baseCommit: string;
  /** Path to the evidence directory for patches */
  evidenceDir: string;
  /** Time spent preparing the isolated workspace. */
  setupDurationMs?: number;
  /** Whether this workspace came from an explicit prewarm. */
  warmed?: boolean;
  /** Snapshot of the original repository before the run started. */
  repoPath?: string;
  repoHead?: string;
  repoStatus?: string;
  repoFingerprint?: string;
  originalRepoCleanBeforeApply?: boolean;
}

/**
 * Create a git worktree for a run.
 *
 * Creates a new branch from HEAD, so changes are isolated.
 * The worktree is created under `.verdikt/<runId>/workspace/`.
 */
export async function createRunWorktree(
  repoPath: string,
  runDir: string,
  runId: string,
): Promise<WorktreeInfo> {
  const setupStartedAt = Date.now();
  const sourceSnapshot = await captureRepositorySnapshot(repoPath);
  const warmed = await claimWarmWorkspace(repoPath, runDir, runId);
  if (warmed) {
    return {
      ...warmed,
      setupDurationMs: Date.now() - setupStartedAt,
      repoPath: sourceSnapshot.repoPath,
      repoHead: sourceSnapshot.head,
      repoStatus: sourceSnapshot.status,
      repoFingerprint: sourceSnapshot.fingerprint,
      originalRepoCleanBeforeApply: sourceSnapshot.clean,
    };
  }
  const baseCommit = await getHeadCommit(repoPath);
  const branchName = `verdikt/${runId}`;
  // Resolve to absolute path — relative CWD causes spawn ENOENT on Windows
  const worktreePath = resolve(join(runDir, "workspace"));
  const evidenceDir = resolve(join(runDir, "evidence"));

  let worktreeAdded = false;
  try {
    await mkdir(evidenceDir, { recursive: true });

    // Create worktree with a new branch from current HEAD
    await git(repoPath, ["worktree", "add", "--detach", worktreePath, "HEAD"]);
    worktreeAdded = true;
    // Create and checkout the branch inside the worktree
    await git(worktreePath, ["checkout", "-b", branchName]);

    return {
      worktreePath,
      branchName,
      baseCommit,
      evidenceDir,
      setupDurationMs: Date.now() - setupStartedAt,
      warmed: false,
      repoPath: sourceSnapshot.repoPath,
      repoHead: sourceSnapshot.head,
      repoStatus: sourceSnapshot.status,
      repoFingerprint: sourceSnapshot.fingerprint,
      originalRepoCleanBeforeApply: sourceSnapshot.clean,
    };
  } catch (err) {
    if (worktreeAdded) {
      await git(repoPath, ["worktree", "remove", worktreePath, "--force"]).catch(() => {});
    }
    await rm(worktreePath, { recursive: true, force: true }).catch(() => {});
    await git(repoPath, ["branch", "-D", branchName]).catch(() => {});
    throw err;
  }
}

/** Create an isolated run worktree starting from an existing checkpoint commit. */
export async function createRunWorktreeAtCommit(
  repoPath: string,
  runDir: string,
  runId: string,
  startCommit: string,
  baseCommit: string,
): Promise<WorktreeInfo> {
  const setupStartedAt = Date.now();
  const sourceSnapshot = await captureRepositorySnapshot(repoPath);
  const branchName = `verdikt/${runId}`;
  const worktreePath = resolve(join(runDir, "workspace"));
  const evidenceDir = resolve(join(runDir, "evidence"));
  let worktreeAdded = false;
  try {
    await mkdir(evidenceDir, { recursive: true });
    await git(repoPath, ["worktree", "add", "--detach", worktreePath, startCommit]);
    worktreeAdded = true;
    await git(worktreePath, ["checkout", "-b", branchName]);
    return {
      worktreePath,
      branchName,
      baseCommit,
      evidenceDir,
      setupDurationMs: Date.now() - setupStartedAt,
      warmed: false,
      repoPath: sourceSnapshot.repoPath,
      repoHead: sourceSnapshot.head,
      repoStatus: sourceSnapshot.status,
      repoFingerprint: sourceSnapshot.fingerprint,
      originalRepoCleanBeforeApply: sourceSnapshot.clean,
    };
  } catch (err) {
    if (worktreeAdded) {
      await git(repoPath, ["worktree", "remove", worktreePath, "--force"]).catch(() => {});
    }
    await rm(worktreePath, { recursive: true, force: true }).catch(() => {});
    await git(repoPath, ["branch", "-D", branchName]).catch(() => {});
    throw err;
  }
}

/** Restore an isolated worktree to an exact checkpoint commit. */
export async function resetRunWorktreeToCommit(
  worktreePath: string,
  commit: string,
): Promise<void> {
  if (!/^[a-f0-9]{7,64}$/i.test(commit)) throw new Error("Invalid checkpoint commit");
  await git(worktreePath, ["reset", "--hard", commit]);
  await git(worktreePath, ["clean", "-fd"]);
}

/**
 * Capture the diff of the current iteration as a patch file.
 *
 * M5.1 Fix: diffs against pre-executor baseCommit instead of HEAD.
 * This ensures the patch captures ALL changes the executor made,
 * including changes that were committed during the executor's run.
 *
 * @param baseCommit - The commit hash BEFORE the executor ran this iteration.
 *                     This is the invariant: patch always shows what the executor changed.
 */
export async function captureIterationDiff(
  worktreePath: string,
  evidenceDir: string,
  iterationIndex: number,
  baseCommit?: string,
): Promise<{
  patchPath: string;
  changedFiles: string[];
  linesAdded: number;
  linesDeleted: number;
}> {
  // Pathspec exclusions for common non-source directories
  const excludes = [
    ":(exclude)node_modules",
    ":(exclude).git",
    ":(exclude).verdikt",
    ":(exclude)dist",
    ":(exclude)build",
    ":(exclude)coverage",
    ":(exclude).vite",
  ];

  // Use baseCommit if provided (M5.1 fix), otherwise fall back to HEAD
  const ref = baseCommit ?? "HEAD";

  // Get changed files list — diff against pre-executor state
  const changedCommitted = await git(worktreePath, [
    "diff",
    "--name-only",
    `${ref}`,
    "--",
    ...excludes,
  ]);
  const untracked = await git(worktreePath, ["ls-files", "--others", "--exclude-standard"]);

  const untrackedFiles = untracked
    .split("\n")
    .filter(Boolean)
    .filter((f) => !isExcludedChangedFile(f));

  const changedFiles = [...changedCommitted.split("\n"), ...untrackedFiles]
    .filter(Boolean)
    .filter((f) => !isExcludedChangedFile(f));

  const uniqueFiles = [...new Set(changedFiles)].sort();

  if (untrackedFiles.length > 0) {
    await git(worktreePath, ["add", "-N", "--", ...untrackedFiles]);
  }

  // Get numstat for lines added/deleted
  let linesAdded = 0;
  let linesDeleted = 0;
  try {
    const numstat = await git(worktreePath, ["diff", "--numstat", `${ref}`, "--", ...excludes]);
    for (const line of numstat.split("\n").filter(Boolean)) {
      const parts = line.split("\t");
      if (parts.length >= 2) {
        linesAdded += Number.parseInt(parts[0], 10) || 0;
        linesDeleted += Number.parseInt(parts[1], 10) || 0;
      }
    }
  } catch {
    // numstat may fail if no changes, that's OK
  }

  // Stream diff to file — against pre-executor base commit
  const patchPath = join(evidenceDir, `iteration-${iterationIndex}.patch`);
  await streamDiffToFile(worktreePath, patchPath, excludes, ref);

  return { patchPath, changedFiles: uniqueFiles, linesAdded, linesDeleted };
}

/**
 * Stream git diff output directly to a file.
 * Uses spawn with pipe to avoid maxBuffer limitations.
 */
async function streamDiffToFile(
  cwd: string,
  outputPath: string,
  excludes: string[],
  ref = "HEAD",
): Promise<void> {
  const { spawn } = await import("node:child_process");
  const { createWriteStream } = await import("node:fs");

  return new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["diff", ref, "--", ...excludes], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stream = createWriteStream(outputPath);
    let stderr = "";
    let childClosed = false;
    let streamFinished = false;
    let settled = false;

    const settle = (err?: Error) => {
      if (settled) return;
      if (err) {
        settled = true;
        if (!streamFinished) stream.end();
        reject(err);
        return;
      }
      if (childClosed && streamFinished) {
        settled = true;
        resolve();
      }
    };

    child.stdout?.pipe(stream);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    stream.on("finish", () => {
      streamFinished = true;
      settle();
    });
    stream.on("error", (err) => {
      settle(new Error(`Failed to write diff patch ${outputPath}:\n${err.message}`));
    });

    child.on("close", (code) => {
      if (code !== 0) {
        settle(new Error(`git diff ${ref} failed:\n${stderr || `exit ${code}`}`));
        return;
      }
      childClosed = true;
      if (!streamFinished) stream.end();
      settle();
    });

    child.on("error", (err) => {
      settle(new Error(`git diff ${ref} failed:\n${err.message}`));
    });
  });
}

function isExcludedChangedFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const excluded = ["node_modules", ".git", ".verdikt", "dist", "build", "coverage", ".vite"];
  return excluded.some((dir) => normalized === dir || normalized.startsWith(`${dir}/`));
}

/**
 * Stage all changes and commit in the worktree.
 * This creates a checkpoint for each iteration.
 */
export async function checkpointIteration(
  worktreePath: string,
  iterationIndex: number,
): Promise<string> {
  await git(worktreePath, ["add", "-A"]);
  const hasChanges = await git(worktreePath, ["status", "--porcelain"]);
  if (hasChanges.trim()) {
    await git(worktreePath, [
      "commit",
      "-m",
      `verdikt: iteration ${iterationIndex}`,
      "--no-gpg-sign",
      "--allow-empty",
    ]);
  }
  return getHeadCommit(worktreePath);
}

/**
 * Write the final diff between the base commit and HEAD to a patch file.
 *
 * Streams the diff directly to disk — the final patch of a real run can be
 * arbitrarily large (lockfiles, generated code), so it must never pass
 * through an in-process buffer with a size cap.
 */
export async function writeFinalPatch(
  worktreePath: string,
  baseCommit: string,
  outputPath: string,
): Promise<void> {
  const excludes = [
    ":(exclude)node_modules",
    ":(exclude).git",
    ":(exclude).verdikt",
    ":(exclude)dist",
    ":(exclude)build",
    ":(exclude)coverage",
    ":(exclude).vite",
  ];
  await streamDiffToFile(worktreePath, outputPath, excludes, `${baseCommit}..HEAD`);
}

/**
 * Apply the final patch back to the original repo.
 * Only call this after the run passes all checks.
 */
export async function applyFinalPatch(
  repoPath: string,
  worktreePath: string,
  baseCommit: string,
): Promise<void> {
  const tmpPatch = join(worktreePath, ".final.patch");
  await writeFinalPatch(worktreePath, baseCommit, tmpPatch);

  const { stat } = await import("node:fs/promises");
  const patchStat = await stat(tmpPatch);
  if (patchStat.size === 0) {
    return; // No changes to apply
  }

  // Apply with --3way for merge resilience
  await git(repoPath, ["apply", "--3way", tmpPatch]);
}

/**
 * Discard a run's worktree. Original repo stays clean.
 */
export async function discardRun(
  repoPath: string,
  worktreePath: string,
  branchName: string,
): Promise<void> {
  try {
    // Remove the worktree
    await git(repoPath, ["worktree", "remove", worktreePath, "--force"]);
  } catch {
    // If worktree remove fails, try manual cleanup
    try {
      await rm(worktreePath, { recursive: true, force: true });
      await git(repoPath, ["worktree", "prune"]);
    } catch {
      // Best effort cleanup
    }
  }

  try {
    // Delete the branch
    await git(repoPath, ["branch", "-D", branchName]);
  } catch {
    // Branch might not exist, that's OK
  }

  const warmRoot = resolve(join(worktreePath, ".."));
  const warmParent = resolve(join(warmRoot, ".."));
  if (warmParent.endsWith(`${requirePathSeparator()}.warm`)) {
    await rm(warmRoot, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Get list of test files in a directory (for integrity checking).
 */
export async function getTestFiles(repoPath: string): Promise<string[]> {
  const output = await git(repoPath, [
    "ls-files",
    "*.test.ts",
    "*.test.js",
    "*.test.tsx",
    "*.test.jsx",
    "*.spec.ts",
    "*.spec.js",
    "*.spec.tsx",
    "*.spec.jsx",
  ]);
  return output.split("\n").filter(Boolean);
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function requirePathSeparator(): string {
  return process.platform === "win32" ? "\\" : "/";
}

export async function getHeadCommit(repoPath: string): Promise<string> {
  const hash = await git(repoPath, ["rev-parse", "HEAD"]);
  return hash.trim();
}

/**
 * Run a git command in the given directory.
 * Uses execFile with "git" directly (PATH-based resolution).
 */
async function git(cwd: string, args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      "git",
      args,
      // Defensive maxBuffer: bulk diff output goes through streamDiffToFile,
      // but name lists on very large changes can still exceed the 1MB default.
      { cwd, encoding: "utf-8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
      (err: Error | null, stdout: string, stderr: string) => {
        if (err) {
          reject(new Error(`git ${args.join(" ")} failed:\n${stderr || err.message}`));
        } else {
          resolve(stdout ?? "");
        }
      },
    );
  });
}
