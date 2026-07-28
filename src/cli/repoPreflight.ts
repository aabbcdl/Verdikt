/**
 * Repository preflight for isolated runs.
 *
 * The apply pipeline refuses to touch a repository whose working tree was
 * dirty when the run started (`originalRepoCleanBeforeApply` must be true).
 * Before this check existed at the entry point, a dirty repo burned a full
 * paid run and only failed at apply time with `revalidation_required`.
 *
 * Policy: reject dirty GIT repositories at submission unless the task
 * explicitly sets `allowDirtyRepo`. Non-git paths pass through — they fail
 * later at workspace creation with their own clear error, and have no
 * "dirty" state to detect.
 */

import { execFile } from "node:child_process";
import { canonicalizeRepoPath } from "../workspace/repoIdentity.js";

export type RepoPreflightResult =
  | { ok: true; dirty: false }
  | { ok: true; dirty: true; dirtyFiles: string[] }
  | { ok: false; reason: "dirty"; dirtyFiles: string[]; message: string; fix: string };

const MAX_LISTED_FILES = 5;

export async function checkRepoPreflight(
  repoPath: string,
  allowDirtyRepo: boolean,
): Promise<RepoPreflightResult> {
  let toplevel: string;
  try {
    toplevel = (await git(repoPath, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    // Not a git repository (or git unavailable): no dirty state to protect.
    // Isolated-run creation reports its own error for non-git paths.
    return { ok: true, dirty: false };
  }

  // Only enforce when repoPath IS the repository root. A plain subdirectory
  // inside some larger repository would otherwise inherit the parent's dirty
  // state and block the task with files that have nothing to do with it.
  if (canonicalizeRepoPath(toplevel) !== canonicalizeRepoPath(repoPath)) {
    return { ok: true, dirty: false };
  }

  let status: string;
  try {
    status = await git(repoPath, ["status", "--porcelain=v1", "--untracked-files=all"]);
  } catch {
    return { ok: true, dirty: false };
  }

  // Porcelain v1: two status columns + space + path ("XY path", "?? path",
  // renames as "R  old -> new"). Fixed-width parse — do not trim first.
  const dirtyFiles = status
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const path = line.length > 3 ? line.slice(3) : line;
      const arrow = path.indexOf(" -> ");
      return (arrow >= 0 ? path.slice(arrow + 4) : path).trim();
    })
    .filter(Boolean);

  if (dirtyFiles.length === 0) return { ok: true, dirty: false };
  if (allowDirtyRepo) return { ok: true, dirty: true, dirtyFiles };

  const listed = dirtyFiles.slice(0, MAX_LISTED_FILES).join("、");
  const suffix = dirtyFiles.length > MAX_LISTED_FILES ? ` 等 ${dirtyFiles.length} 个文件` : "";
  return {
    ok: false,
    reason: "dirty",
    dirtyFiles,
    message: `目标仓库存在未提交的改动（${listed}${suffix}）。隔离副本基于 HEAD 创建，这些改动不会被 agent 看到，并且运行通过后的补丁将无法一键应用。`,
    fix: "先 commit 或 stash 这些改动后重试；或在任务中设置 allowDirtyRepo（命令行使用 --allow-dirty）以强制继续，通过后需手动应用补丁。",
  };
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolveResult, reject) => {
    execFile(
      "git",
      args,
      { cwd, encoding: "utf-8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`git ${args.join(" ")} failed:\n${stderr || error.message}`));
        else resolveResult(stdout ?? "");
      },
    );
  });
}
