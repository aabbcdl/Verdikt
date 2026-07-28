import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { readJsonFile, writeJsonAtomic } from "../trace/atomicJson.js";
import { canonicalizeRepoPath } from "./repoIdentity.js";

export interface WarmWorkspaceMetadata {
  version: 1;
  repoPath: string;
  baseCommit: string;
  worktreePath: string;
  createdAt: string;
}

export interface WarmRepositoryResult extends WarmWorkspaceMetadata {
  durationMs: number;
}

export async function warmRepository(
  repoPathInput: string,
  stateDirInput: string,
): Promise<WarmRepositoryResult> {
  const startedAt = Date.now();
  const repoPath = canonicalizeRepoPath(repoPathInput);
  const stateDir = resolve(stateDirInput);
  const baseCommit = await git(repoPath, ["rev-parse", "HEAD"]).then((value) => value.trim());
  const root = warmEntryDir(stateDir, repoPath);
  const worktreePath = join(root, "workspace");

  await removeWarmEntry(repoPath, stateDir);
  await mkdir(root, { recursive: true });
  try {
    await git(repoPath, ["worktree", "add", "--detach", worktreePath, baseCommit]);
    if ((await git(worktreePath, ["status", "--porcelain"])).trim()) {
      throw new Error("Prepared workspace is not clean");
    }
    const metadata: WarmWorkspaceMetadata = {
      version: 1,
      repoPath,
      baseCommit,
      worktreePath,
      createdAt: new Date().toISOString(),
    };
    await writeJsonAtomic(join(root, "metadata.json"), metadata);
    return { ...metadata, durationMs: Date.now() - startedAt };
  } catch (error) {
    await removeWarmEntry(repoPath, stateDir);
    throw error;
  }
}

export async function claimWarmWorkspace(
  repoPathInput: string,
  runDirInput: string,
  runId: string,
): Promise<{
  worktreePath: string;
  branchName: string;
  baseCommit: string;
  evidenceDir: string;
  warmed: true;
} | null> {
  const repoPath = canonicalizeRepoPath(repoPathInput);
  const runDir = resolve(runDirInput);
  const stateDir = resolve(runDir, "..");
  const root = warmEntryDir(stateDir, repoPath);
  const metadata = await readJsonFile<WarmWorkspaceMetadata>(join(root, "metadata.json"));
  if (!metadata || metadata.version !== 1) return null;

  const valid = await validateWarmWorkspace(metadata, repoPath, stateDir);
  if (!valid) {
    await removeWarmEntry(repoPath, stateDir);
    return null;
  }

  const branchName = `verdikt/${runId}`;
  const evidenceDir = resolve(join(runDir, "evidence"));
  try {
    await rm(join(root, "metadata.json"), { force: true });
    await mkdir(evidenceDir, { recursive: true });
    await git(metadata.worktreePath, ["checkout", "-b", branchName]);
    await writeJsonAtomic(join(root, "claimed.json"), {
      version: 1,
      runId,
      claimedAt: new Date().toISOString(),
    });
    return {
      worktreePath: metadata.worktreePath,
      branchName,
      baseCommit: metadata.baseCommit,
      evidenceDir,
      warmed: true,
    };
  } catch {
    await removeWarmEntry(repoPath, stateDir, true);
    await git(repoPath, ["branch", "-D", branchName]).catch(() => undefined);
    return null;
  }
}

export async function isWarmRepositoryReady(
  repoPathInput: string,
  stateDirInput: string,
): Promise<boolean> {
  const repoPath = canonicalizeRepoPath(repoPathInput);
  const stateDir = resolve(stateDirInput);
  const metadata = await readJsonFile<WarmWorkspaceMetadata>(
    join(warmEntryDir(stateDir, repoPath), "metadata.json"),
  );
  return Boolean(metadata && (await validateWarmWorkspace(metadata, repoPath, stateDir)));
}

async function validateWarmWorkspace(
  metadata: WarmWorkspaceMetadata,
  repoPath: string,
  stateDir: string,
): Promise<boolean> {
  const warmRoot = resolve(stateDir, ".warm");
  const worktreePath = resolve(metadata.worktreePath);
  if (canonicalizeRepoPath(metadata.repoPath) !== repoPath) return false;
  if (!isPathInside(warmRoot, worktreePath) || !existsSync(worktreePath)) return false;
  try {
    const currentHead = (await git(repoPath, ["rev-parse", "HEAD"])).trim();
    const warmHead = (await git(worktreePath, ["rev-parse", "HEAD"])).trim();
    const status = (await git(worktreePath, ["status", "--porcelain"])).trim();
    return currentHead === metadata.baseCommit && warmHead === metadata.baseCommit && status === "";
  } catch {
    return false;
  }
}

async function removeWarmEntry(
  repoPath: string,
  stateDir: string,
  forceClaimed = false,
): Promise<void> {
  const root = warmEntryDir(stateDir, repoPath);
  const worktreePath = join(root, "workspace");
  const warmRoot = resolve(stateDir, ".warm");
  const claimed = await readJsonFile<{ runId?: string }>(join(root, "claimed.json"));
  if (!forceClaimed && claimed && existsSync(worktreePath)) {
    throw new Error(
      `The prepared workspace is currently in use by run ${claimed.runId ?? "unknown"}.`,
    );
  }
  if (isPathInside(warmRoot, worktreePath) && existsSync(worktreePath)) {
    await git(repoPath, ["worktree", "remove", worktreePath, "--force"]).catch(async () => {
      await rm(worktreePath, { recursive: true, force: true });
      await git(repoPath, ["worktree", "prune"]).catch(() => undefined);
    });
  }
  if (isPathInside(warmRoot, root)) {
    await rm(root, { recursive: true, force: true });
  }
}

function warmEntryDir(stateDir: string, repoPath: string): string {
  const normalized = canonicalizeRepoPath(repoPath);
  const key = createHash("sha256").update(normalized).digest("hex").slice(0, 20);
  return resolve(stateDir, ".warm", key);
}

function isPathInside(basePath: string, targetPath: string): boolean {
  const rel = relative(resolve(basePath), resolve(targetPath));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolveResult, reject) => {
    execFile("git", args, { cwd, encoding: "utf-8", timeout: 120_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`git ${args.join(" ")} failed:\n${stderr || error.message}`));
      else resolveResult(stdout ?? "");
    });
  });
}
