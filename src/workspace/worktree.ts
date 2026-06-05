/**
 * Workspace isolation via git worktree.
 *
 * Each run gets its own worktree so the original repo stays clean.
 * Per-iteration diffs are captured as patch files.
 * On success: apply final patch back to the original repo.
 * On failure: discard the worktree, original repo untouched.
 */

import { type ExecException, execFile, spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface WorktreeInfo {
  /** Absolute path to the worktree directory */
  worktreePath: string;
  /** The branch name in the worktree */
  branchName: string;
  /** Commit hash at the start of the run */
  baseCommit: string;
  /** Path to the evidence directory for patches */
  evidenceDir: string;
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
  const baseCommit = await getHeadCommit(repoPath);
  const branchName = `verdikt/${runId}`;
  // Resolve to absolute path — relative CWD causes spawn ENOENT on Windows
  const worktreePath = resolve(join(runDir, "workspace"));
  const evidenceDir = resolve(join(runDir, "evidence"));

  await mkdir(evidenceDir, { recursive: true });

  // Create worktree with a new branch from current HEAD
  await git(repoPath, ["worktree", "add", "--detach", worktreePath, "HEAD"]);
  // Create and checkout the branch inside the worktree
  await git(worktreePath, ["checkout", "-b", branchName]);

  return { worktreePath, branchName, baseCommit, evidenceDir };
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

  const changedFiles = [...changedCommitted.split("\n"), ...untracked.split("\n")]
    .filter(Boolean)
    .filter((f) => !f.startsWith("node_modules/") && !f.startsWith(".git/"));

  const uniqueFiles = [...new Set(changedFiles)].sort();

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

  return new Promise<void>((resolve, _reject) => {
    const child = spawn("git", ["diff", ref, "--", ...excludes], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stream = createWriteStream(outputPath);

    child.stdout?.pipe(stream);

    child.on("close", (code) => {
      stream.end();
      if (code === 0 || code === 1) {
        resolve(); // 0 = no diff, 1 = has diff
      } else {
        resolve(); // Don't fail the run for diff issues
      }
    });

    child.on("error", () => {
      stream.end();
      resolve(); // Don't fail the run for diff issues
    });
  });
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
      "--allow-empty",
    ]);
  }
  return getHeadCommit(worktreePath);
}

/**
 * Get the final diff between the base commit and the current state.
 * Excludes non-source directories to avoid maxBuffer issues.
 */
export async function getFinalPatch(worktreePath: string, baseCommit: string): Promise<string> {
  const excludes = [
    ":(exclude)node_modules",
    ":(exclude).git",
    ":(exclude).verdikt",
    ":(exclude)dist",
    ":(exclude)build",
    ":(exclude)coverage",
    ":(exclude).vite",
  ];
  return git(worktreePath, ["diff", `${baseCommit}..HEAD`, "--", ...excludes]);
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
  const patch = await getFinalPatch(worktreePath, baseCommit);
  if (!patch.trim()) {
    return; // No changes to apply
  }

  // Write patch to temp file and apply
  const tmpPatch = join(worktreePath, ".final.patch");
  await writeFile(tmpPatch, patch, "utf-8");

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
      { cwd, encoding: "utf-8", timeout: 120_000 },
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
