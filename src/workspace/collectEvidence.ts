/**
 * Workspace evidence collection.
 *
 * After each iteration, collects what files changed.
 * MVP: uses `git diff --name-only` to detect changes.
 */

import { type ExecException, exec } from "node:child_process";

/**
 * Collect list of files changed since the last commit (unstaged + staged + untracked).
 */
export async function collectEvidence(repoPath: string): Promise<string[]> {
  const [modified, untracked] = await Promise.all([
    execAsync("git diff --name-only HEAD", repoPath),
    execAsync("git ls-files --others --exclude-standard", repoPath),
  ]);

  const files = [...modified.split("\n").filter(Boolean), ...untracked.split("\n").filter(Boolean)];

  // Deduplicate and sort
  return [...new Set(files)].sort();
}

/**
 * Collect the full diff for logging.
 */
export async function collectDiff(repoPath: string): Promise<string> {
  return execAsync("git diff HEAD", repoPath);
}

function execAsync(command: string, cwd: string): Promise<string> {
  return new Promise<string>((resolve) => {
    exec(
      command,
      { cwd, encoding: "utf-8", shell: process.platform === "win32" ? "powershell" : undefined },
      (_err: ExecException | null, stdout: string) => resolve(stdout ?? ""),
    );
  });
}
