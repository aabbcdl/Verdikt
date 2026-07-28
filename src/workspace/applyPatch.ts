import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runLifecycleHooks } from "../hooks/runner.js";
import { runJudges } from "../judges/runJudges.js";
import type { TaskSpec } from "../types.js";
import { releaseLock } from "./lock.js";
import { captureRepositorySnapshot } from "./repoIdentity.js";
import { discardRun } from "./worktree.js";

export interface ProtectedPatchApplyOptions {
  stateDir: string;
  runDir: string;
  runId: string;
  repoPath: string;
  patchPath: string;
  task: TaskSpec | null;
  savedWorkspace?: Record<string, unknown>;
  worktreePath: string;
  branchName: string;
  revalidationHint?: string;
}

export class RevalidationRequiredError extends Error {
  readonly code = "revalidation_required";

  constructor(message: string) {
    super(`revalidation_required: ${message}`);
    this.name = "RevalidationRequiredError";
  }
}

export async function applyProtectedPatch(options: ProtectedPatchApplyOptions): Promise<void> {
  const patchContent = await readFile(options.patchPath, "utf-8");
  const beforeApply = await captureRepositorySnapshot(options.repoPath);
  const savedWorkspace = assertSavedWorkspaceBaseline(
    options.savedWorkspace,
    options.revalidationHint,
  );

  if (patchContent.trim()) {
    const integration = await validatePatchInIntegrationWorkspace(options);
    if (!integration.passed) {
      throw new RevalidationRequiredError(
        `the patch failed acceptance checks in a temporary integration workspace: ${integration.detail}`,
      );
    }
  }

  assertRepositoryUnchanged(savedWorkspace, beforeApply, options.revalidationHint);

  if (options.task) {
    await runLifecycleHooks(
      options.task,
      "before_apply",
      {
        runId: options.runId,
        patchPath: options.patchPath,
        repoPath: options.repoPath,
      },
      options.repoPath,
    );
  }

  const afterHooks = await captureRepositorySnapshot(options.repoPath);
  assertRepositoryUnchanged(savedWorkspace, afterHooks, options.revalidationHint);

  if (patchContent.trim()) {
    const alreadyApplied = await isPatchAlreadyApplied(options.repoPath, options.patchPath);
    if (!alreadyApplied) await applyPatch(options.repoPath, options.patchPath);
  }

  if (options.task?.acceptance && patchContent.trim()) {
    const appliedCheck = await runJudges(options.task.acceptance, options.repoPath);
    if (!appliedCheck.passed) {
      await rollbackAppliedPatch(options.repoPath, beforeApply.head);
      throw new Error(
        `Applied patch failed acceptance checks and was rolled back: ${appliedCheck.checks
          .filter((check) => !check.passed)
          .map((check) => check.name)
          .join(", ")}`,
      );
    }
  }

  await cleanupAppliedRun(options);
}

function assertSavedWorkspaceBaseline(
  savedWorkspace: Record<string, unknown> | undefined,
  revalidationHint?: string,
): Record<string, unknown> {
  if (!savedWorkspace) {
    throw new RevalidationRequiredError(
      "the saved run has no trusted repository snapshot; run the task again before applying",
    );
  }
  if (
    typeof savedWorkspace.repoPath !== "string" ||
    typeof savedWorkspace.repoHead !== "string" ||
    typeof savedWorkspace.repoStatus !== "string" ||
    typeof savedWorkspace.repoFingerprint !== "string" ||
    savedWorkspace.originalRepoCleanBeforeApply !== true
  ) {
    throw new RevalidationRequiredError(
      revalidationHint ??
        "the saved run has an incomplete repository snapshot; run the task again before applying",
    );
  }
  return savedWorkspace;
}

function assertRepositoryUnchanged(
  savedWorkspace: Record<string, unknown>,
  current: Awaited<ReturnType<typeof captureRepositorySnapshot>>,
  revalidationHint?: string,
): void {
  if (!sameRepositorySnapshot(savedWorkspace, current) || !current.clean) {
    throw new RevalidationRequiredError(
      revalidationHint ??
        "the original repository path, HEAD, or working tree differs from the run snapshot",
    );
  }
}

function sameRepositorySnapshot(
  savedWorkspace: Record<string, unknown>,
  current: Awaited<ReturnType<typeof captureRepositorySnapshot>>,
): boolean {
  return (
    savedWorkspace.repoPath === current.repoPath &&
    savedWorkspace.repoFingerprint === current.fingerprint &&
    savedWorkspace.repoHead === current.head &&
    savedWorkspace.repoStatus === current.status
  );
}

async function validatePatchInIntegrationWorkspace(
  options: ProtectedPatchApplyOptions,
): Promise<{ passed: boolean; detail: string }> {
  if (!options.task?.acceptance) {
    return { passed: true, detail: "no acceptance criteria were saved" };
  }

  const integrationRoot = resolve(join(options.stateDir, ".integration"));
  await mkdir(integrationRoot, { recursive: true });
  const worktreePath = await mkdtemp(join(integrationRoot, `${options.runId}-`));
  let added = false;
  try {
    await runGit(options.repoPath, ["worktree", "add", "--detach", worktreePath, "HEAD"]);
    added = true;
    await applyPatch(worktreePath, options.patchPath);
    const result = await runJudges(options.task.acceptance, worktreePath);
    const failed = result.checks.filter((check) => !check.passed).map((check) => check.name);
    return { passed: result.passed, detail: failed.join(", ") || "acceptance checks failed" };
  } catch (error) {
    return { passed: false, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    if (added) {
      await runGit(options.repoPath, ["worktree", "remove", worktreePath, "--force"]).catch(
        () => {},
      );
    }
    await rm(worktreePath, { recursive: true, force: true }).catch(() => {});
  }
}

async function rollbackAppliedPatch(repoPath: string, head: string): Promise<void> {
  await runGit(repoPath, ["reset", "--hard", head]);
  await runGit(repoPath, ["clean", "-fd"]);
}

async function isPatchAlreadyApplied(repoPath: string, patchPath: string): Promise<boolean> {
  try {
    await runGit(repoPath, ["apply", "--reverse", "--check", patchPath]);
    return true;
  } catch {
    return false;
  }
}

async function applyPatch(repoPath: string, patchPath: string): Promise<void> {
  try {
    await runGit(repoPath, ["apply", "--3way", patchPath]);
  } catch (error) {
    throw new Error(
      `Failed to apply patch: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function cleanupAppliedRun(options: ProtectedPatchApplyOptions): Promise<void> {
  if (existsSync(options.worktreePath)) {
    await discardRun(options.repoPath, options.worktreePath, options.branchName);
  }
  releaseLock(options.stateDir, options.repoPath, options.runId);
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { execFile } = await import("node:child_process");
  return new Promise<string>((resolveGit, rejectGit) => {
    execFile("git", args, { cwd, encoding: "utf-8", timeout: 120_000 }, (error, stdout, stderr) => {
      if (error) rejectGit(new Error(`git ${args.join(" ")} failed: ${stderr || error.message}`));
      else resolveGit(stdout ?? "");
    });
  });
}
