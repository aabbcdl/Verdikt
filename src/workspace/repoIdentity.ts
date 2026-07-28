import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { normalize, resolve } from "node:path";

export interface RepositorySnapshot {
  repoPath: string;
  head: string;
  status: string;
  clean: boolean;
  fingerprint: string;
}

export function canonicalizeRepoPath(repoPath: string): string {
  const resolved = resolve(repoPath);
  const real = existsSync(resolved) ? realpathSync.native(resolved) : resolved;
  const normalized = normalize(real).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function repositoryIdentityKey(repoPath: string): string {
  return createHash("sha256").update(canonicalizeRepoPath(repoPath)).digest("hex");
}

export async function captureRepositorySnapshot(repoPath: string): Promise<RepositorySnapshot> {
  const canonicalPath = canonicalizeRepoPath(repoPath);
  const [head, status] = await Promise.all([
    git(canonicalPath, ["rev-parse", "HEAD"]).then((value) => value.trim()),
    git(canonicalPath, ["status", "--porcelain=v1", "--untracked-files=all"]).then((value) =>
      value.replace(/\r\n/g, "\n").trimEnd(),
    ),
  ]);
  return {
    repoPath: canonicalPath,
    head,
    status,
    clean: status.length === 0,
    fingerprint: createHash("sha256").update(`${canonicalPath}\0${head}\0${status}`).digest("hex"),
  };
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolveResult, reject) => {
    execFile("git", args, { cwd, encoding: "utf-8", timeout: 120_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`git ${args.join(" ")} failed:\n${stderr || error.message}`));
      else resolveResult(stdout ?? "");
    });
  });
}
