/**
 * Workspace evidence collection.
 *
 * After each iteration, collects what files changed.
 * MVP: uses `git diff --name-only` to detect changes.
 */

import { execFile } from "node:child_process";

/**
 * Collect list of files changed since the last commit (unstaged + staged + untracked).
 */
export async function collectEvidence(repoPath: string): Promise<string[]> {
  const [modified, untracked] = await Promise.all([
    git(repoPath, ["diff", "--name-only", "HEAD"]),
    git(repoPath, ["ls-files", "--others", "--exclude-standard"]),
  ]);

  const files = [...modified.split("\n").filter(Boolean), ...untracked.split("\n").filter(Boolean)];

  // Deduplicate and sort
  return [...new Set(files)].sort();
}

/**
 * Collect the full diff for logging.
 */
export async function collectDiff(repoPath: string): Promise<string> {
  return git(repoPath, ["diff", "HEAD"]);
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, encoding: "utf-8", timeout: 120_000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`git ${args.join(" ")} failed:\n${stderr || err.message}`));
          return;
        }
        resolve(stdout ?? "");
      },
    );
  });
}
