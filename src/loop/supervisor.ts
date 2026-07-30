/**
 * SupervisorLoop — the heart of Verdikt.
 *
 * M2: Now with workspace isolation (git worktree), per-iteration diff capture,
 * integrity checks, and apply/discard on completion.
 *
 * Orchestrates the iterative cycle:
 *   create worktree → executor → evidence → integrity check → judge → verifier → stop → apply/discard
 *
 * Deterministic orchestration logic. No LLM for routing decisions.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { clearActionRejection, readActionApprovalState } from "../approval/actionStore.js";
import {
  createApprovalRequest,
  isApprovalSatisfied,
  readApprovalRecord,
} from "../approval/store.js";
import { getConfig } from "../config.js";
import { createEvidenceManifest } from "../evidence/manifest.js";
import { runLifecycleHooks } from "../hooks/runner.js";
import { runJudges } from "../judges/runJudges.js";
import { readSavedPlan, shouldPlanTask, writeSavedPlan } from "../planning/plan.js";
import { evaluateTaskRisk } from "../risk/policy.js";
import { runExecutor } from "../roles/executor.js";
import { runPlanner } from "../roles/planner.js";
import { runReviewer } from "../roles/reviewer.js";
import { runVerifier } from "../roles/verifier.js";
import { writeJsonAtomic } from "../trace/atomicJson.js";
import { saveIterationCheckpoint } from "../trace/checkpoints.js";
import { RunEventRecorder, type RunEventType } from "../trace/events.js";
import { consumeQueuedNotes } from "../trace/notes.js";
import {
  clearRunState,
  createRunId,
  initRun,
  loadRecordedIterations,
  loadRunState,
  recordIteration,
  saveRunState,
  validateResumeState,
  writeSummary,
} from "../trace/recorder.js";
import type {
  DriverFailure,
  DriverOutput,
  IterationRecord,
  PartialIterationRecord,
  ProviderErrorSummary,
  RunAgentPhase,
  RunPhaseUpdate,
  RunResult,
  TaskSpec,
  UsageSummary,
} from "../types.js";
import { formatCost, mergeUsage, usageFromLegacyCost } from "../usage.js";
import { applyProtectedPatch } from "../workspace/applyPatch.js";
import {
  type IntegrityViolation,
  type TestBaseline,
  captureTestBaseline,
  checkTestIntegrity,
  loadTestBaseline,
  saveTestBaseline,
} from "../workspace/integrity.js";
import { acquireLock, checkLock, releaseLock, renewLock } from "../workspace/lock.js";
import { scanPatchRisk } from "../workspace/semantic-scanner.js";
import {
  captureIterationDiff,
  checkpointIteration,
  createRunWorktree,
  discardRun,
  getHeadCommit,
  writeFinalPatch,
} from "../workspace/worktree.js";
import {
  advanceStage,
  createStageRuntime,
  getActiveStage,
  isStageComplete,
  recordStageAttempt,
  stageLimitFailure,
  stageRequiresJudgePass,
} from "./stagePlan.js";
import { decideStop } from "./stopCondition.js";

export interface SupervisorOptions {
  /** Optional externally supplied run id for callers that need stable polling/apply URLs */
  runId?: string;
  /** Skip worktree isolation (for testing or when repo is already disposable) */
  skipWorktree?: boolean;
  /** Skip integrity checks (for testing) */
  skipIntegrity?: boolean;
  /** Auto-apply patch on pass (default false — user must explicitly apply) */
  autoApply?: boolean;
  /** Enable real-time streaming of Claude output (default true for interactive, false for --json) */
  stream?: boolean;
  /** M6: Resume from an existing run directory */
  resumeFrom?: string;
  /** Abort the active run from app/UI callers */
  signal?: AbortSignal;
  /** Receives live supervisor log messages for app/UI status polling */
  onLog?: (message: string) => void;
  /** Reports a live no-output warning without terminating the agent call. */
  onStall?: (info: {
    phase: RunAgentPhase;
    elapsedMs: number;
    outputIdleMs: number;
    detectedAt: string;
    iteration?: number;
    stageId?: string;
  }) => void;
  /** Reports explicit phase changes for status surfaces. */
  onPhase?: (update: RunPhaseUpdate) => void;
}

interface SupervisorLogContext {
  onLog?: (message: string) => void;
  events?: RunEventRecorder;
}

const logContext = new AsyncLocalStorage<SupervisorLogContext>();

class RunCancelledError extends Error {
  constructor(readonly reason: "cancelled" | "interrupted" = "cancelled") {
    super(reason === "interrupted" ? "Run interrupted by app shutdown" : "Run cancelled");
    this.name = "RunCancelledError";
  }
}

/**
 * Run the supervisor loop for a given task.
 *
 * Returns the complete run result with all iteration records.
 */
export async function runSupervisorLoop(
  task: TaskSpec,
  options: SupervisorOptions = {},
): Promise<RunResult> {
  throwIfCancelled(options.signal);
  const normalizedTask = { ...task, runSource: task.runSource ?? "user" };
  if (options.resumeFrom) {
    return resumeSupervisorLoop(options.resumeFrom, options);
  }

  const config = getConfig();
  const stateDir = config.stateDir;
  const runId = options.runId ?? createRunId();
  const runDir = await initRun(stateDir, runId);
  const events = new RunEventRecorder(runDir, runId);

  return logContext.run({ onLog: options.onLog, events }, async () => {
    events.record({
      type: "run_started",
      data: {
        taskId: normalizedTask.id,
        goal: normalizedTask.goal,
        runSource: normalizedTask.runSource ?? "unknown",
      },
    });
    await writeJsonAtomic(join(runDir, "task.json"), normalizedTask, { backup: true });
    await writeJsonAtomic(join(runDir, "normalizedTask.json"), normalizedTask, { backup: true });
    ensureRunLock(stateDir, normalizedTask.repoPath, runId);

    const stopHeartbeat = startLockRenewal(stateDir, normalizedTask.repoPath, runId);
    try {
      const result = await executeLoop(normalizedTask, runId, runDir, stateDir, options);
      await runAndRecordHooks(
        normalizedTask,
        "after_run",
        { runId, reason: result.reason },
        normalizedTask.repoPath,
      );
      recordTerminalEvent(result);
      return result;
    } catch (error) {
      events.record({
        type: "run_failed",
        data: { message: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    } finally {
      stopHeartbeat();
      releaseLock(stateDir, normalizedTask.repoPath, runId);
      await finalizeRunEvidence(runDir, normalizedTask, undefined);
    }
  });
}

/**
 * Resume a previously interrupted run.
 *
 * Loads state from the saved run directory and continues from where it left off.
 */
export async function resumeSupervisorLoop(
  runDir: string,
  options: SupervisorOptions = {},
): Promise<RunResult> {
  const config = getConfig();
  const stateDir = config.stateDir;
  const stateRoot = resolve(stateDir);
  const resolvedRunDir = resolve(runDir);

  if (!isPathInside(stateRoot, resolvedRunDir)) {
    throw new Error(`Cannot resume: run directory is outside the state directory: ${runDir}`);
  }

  const runId = resolvedRunDir.split(/[/\\]/).pop() ?? "unknown";
  if (!isValidRunId(runId)) throw new Error("Invalid run ID");

  const resumeState = await loadRunState(resolvedRunDir);
  if (!resumeState) throw new Error(`Cannot resume: no state.json found in ${resolvedRunDir}`);
  const validation = await validateResumeState(resolvedRunDir, resumeState);
  if (!validation.valid) throw new Error(`Cannot resume: ${validation.reason}`);

  const activeTask = resumeState.task;
  const startIteration = resumeState.nextIteration;
  const events = new RunEventRecorder(resolvedRunDir, runId);
  if (!existsSync(join(resolvedRunDir, "task.json"))) {
    await writeJsonAtomic(join(resolvedRunDir, "task.json"), activeTask, { backup: true });
  }

  return logContext.run({ onLog: options.onLog, events }, async () => {
    ensureRunLock(stateDir, activeTask.repoPath, runId);
    events.record({
      type: "run_resumed",
      iteration: startIteration,
      data: { runSource: activeTask.runSource ?? "unknown" },
    });
    log(`\nResuming run ${runId} from iteration ${startIteration + 1}\n`);

    const stopHeartbeat = startLockRenewal(stateDir, activeTask.repoPath, runId);
    try {
      const result = await executeLoop(activeTask, runId, resolvedRunDir, stateDir, {
        ...options,
        startIteration,
        resumeState,
      });
      await runAndRecordHooks(
        activeTask,
        "after_run",
        { runId, reason: result.reason },
        activeTask.repoPath,
      );
      recordTerminalEvent(result);
      return result;
    } catch (error) {
      events.record({
        type: "run_failed",
        data: { message: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    } finally {
      stopHeartbeat();
      releaseLock(stateDir, activeTask.repoPath, runId);
      await finalizeRunEvidence(resolvedRunDir, activeTask, undefined);
    }
  });
}

function startLockRenewal(stateDir: string, repoPath: string, runId: string): () => void {
  const timer = setInterval(() => {
    renewLock(stateDir, repoPath, runId);
  }, 30_000);
  timer.unref?.();
  return () => clearInterval(timer);
}

function ensureRunLock(stateDir: string, repoPath: string, runId: string): void {
  const holder = checkLock(stateDir, repoPath);
  if (holder) {
    if (holder.runId === runId) return;
    throw new Error(
      `Repository is already locked by run ${holder.runId}. Only one run per repository is allowed at a time. Use "verdikt list" to see active runs.`,
    );
  }

  const locked = acquireLock(stateDir, repoPath, runId);
  if (locked) return;

  const currentHolder = checkLock(stateDir, repoPath);
  if (currentHolder?.runId === runId) return;
  throw new Error(
    `Repository is already locked by run ${currentHolder?.runId ?? "unknown"}. Only one run per repository is allowed at a time. Use "verdikt list" to see active runs.`,
  );
}

/**
 * Shared iteration logic for both normal and resume runs.
 *
 * This is the core loop: executor → evidence → integrity → judge → verifier → stop.
 */
async function executeLoop(
  task: TaskSpec,
  runId: string,
  runDir: string,
  stateDir: string,
  options: SupervisorOptions & {
    startIteration?: number;
    resumeState?: Awaited<ReturnType<typeof loadRunState>>;
  } = {},
): Promise<RunResult> {
  throwIfCancelled(options.signal);
  const resumeState = options.resumeState ?? null;
  const useWorktree = resumeState ? resumeState.useWorktree : !options.skipWorktree;
  const useIntegrity = resumeState
    ? resumeState.useIntegrity
    : !options.skipIntegrity && task.integrity?.enabled !== false;
  const requestedStartIteration = options.startIteration ?? 0;
  const recordedIterations = resumeState ? await loadRecordedIterations(runDir) : [];
  const startIteration = Math.max(requestedStartIteration, recordedIterations.length);

  let workDir = task.repoPath;
  let worktreeInfo: Awaited<ReturnType<typeof createRunWorktree>> | null = null;
  let baseline: TestBaseline | null = null;

  if (useWorktree && !resumeState) {
    log("  ▸ Creating isolated workspace...");
    worktreeInfo = await createRunWorktree(task.repoPath, runDir, runId);
    workDir = worktreeInfo.worktreePath;
    log(`  ▸ Workspace: ${workDir}`);
    log(`  ▸ Base commit: ${worktreeInfo.baseCommit.slice(0, 8)}`);
  } else if (useWorktree && resumeState) {
    if (!resumeState.worktree) {
      throw new Error(
        `Cannot resume isolated run ${runId}: state.json is missing worktree metadata. Resume would be unsafe because it could modify the original repository.`,
      );
    }
    worktreeInfo = resumeState.worktree;
    workDir = worktreeInfo.worktreePath;
    log(`  ▸ Resumed workspace: ${workDir}`);
    log(`  ▸ Base commit: ${worktreeInfo.baseCommit.slice(0, 8)}`);
  }

  recordEvent("workspace_ready", {
    data: {
      mode: useWorktree ? "isolated" : "direct",
      resumed: Boolean(resumeState),
      warmed: Boolean(worktreeInfo?.warmed),
      durationMs: worktreeInfo?.setupDurationMs ?? 0,
      path: workDir,
    },
  });

  if (useIntegrity) {
    if (resumeState) {
      baseline = await loadTestBaseline(runDir);
      if (!baseline) {
        throw new Error(
          `Cannot resume run ${runId}: integrity-baseline.json is missing or unreadable. Integrity status cannot be confirmed.`,
        );
      }
      log("  ▸ Loaded the original integrity baseline.");
    } else {
      log("  ▸ Capturing test baseline...");
      baseline = await captureTestBaseline(workDir, {
        protectedFiles: acceptanceProtectedFiles(task),
        protectedGlobs: task.integrity?.protectedGlobs,
        suspiciousGlobs: task.integrity?.suspiciousGlobs,
      });
      await saveTestBaseline(runDir, baseline);
      log(
        `  ▸ Baseline: ${baseline.fileHashes.size} test files, ${baseline.assertionCounts.size} assertion groups`,
      );
    }
  }

  if (!resumeState) {
    await runAndRecordHooks(task, "before_run", { runId }, workDir);
  }

  const iterations: IterationRecord[] = [...recordedIterations];
  let instruction = resumeState?.instruction ?? task.goal;
  let totalUsage: UsageSummary | undefined =
    resumeState?.usage ?? (resumeState ? usageFromLegacyCost(resumeState.totalCostUsd) : undefined);
  let totalCost = totalUsage?.costUsd ?? resumeState?.totalCostUsd ?? 0;
  let stageRuntime = resumeState?.stageRuntime ?? createStageRuntime(task);
  let budgetEnforcementWarned = false;
  const integrityViolations: Array<{
    iteration: number;
    violations: IntegrityViolation[];
  }> = [];
  const startTime = resumeState?.totalDurationMs
    ? Date.now() - resumeState.totalDurationMs
    : Date.now();
  let currentPhase: RunAgentPhase | undefined = resumeState?.currentPhase;
  let partialIteration: PartialIterationRecord | undefined =
    resumeState?.partialIteration && resumeState.partialIteration.index >= startIteration
      ? resumeState.partialIteration
      : undefined;

  const updatePhase = (
    phase: RunAgentPhase,
    status: RunPhaseUpdate["status"],
    iteration?: number,
    stageId?: string,
  ): void => {
    currentPhase = phase;
    options.onPhase?.({
      phase,
      status,
      iteration,
      stageId,
      updatedAt: new Date().toISOString(),
    });
  };

  const reportStall = (
    phase: RunAgentPhase,
    info: { elapsedMs: number; outputIdleMs: number },
    iteration?: number,
    stageId?: string,
  ): void => {
    const detectedAt = new Date().toISOString();
    updatePhase(phase, "stalled", iteration, stageId);
    options.onStall?.({ phase, ...info, detectedAt, iteration, stageId });
    recordEvent("phase_stalled", {
      iteration,
      stageId,
      data: { phase, ...info, detectedAt },
    });
  };

  const stopForProviderError = async (
    failure: DriverFailure,
    phase: RunAgentPhase,
    details: {
      iteration?: number;
      stageId?: string;
      partial?: PartialIterationRecord;
    } = {},
  ): Promise<RunResult> => {
    const providerError = toProviderErrorSummary(failure);
    const stoppedPartial = details.partial;
    if (stoppedPartial) stoppedPartial.providerError = providerError;
    currentPhase = phase;

    recordEvent("provider_error", {
      iteration: details.iteration,
      stageId: details.stageId,
      data: {
        phase,
        category: providerError.category,
        statusCode: providerError.statusCode,
        retryable: providerError.retryable,
      },
    });

    const result: RunResult = {
      reason: "provider_error",
      iterations,
      totalDurationMs: Date.now() - startTime,
      totalCostUsd: totalCost,
      usageStatus: totalUsage?.status ?? "unknown",
      usage: totalUsage,
      runId,
      taskId: task.id,
      workspace: buildWorkspaceMetadata(task, useWorktree, workDir, worktreeInfo),
      patch: buildPatchMetadata(iterations, stoppedPartial),
      integritySummary: useIntegrity ? buildIntegritySummary(integrityViolations) : undefined,
      applyStatus: "pending",
      stageProgress: stageRuntime,
      evidenceManifestPath: join(runDir, "evidence", "manifest.json"),
      reviewOnly: task.taskMode === "review",
      partialIteration: stoppedPartial,
      providerError,
      resumable: true,
      currentPhase: phase,
    };

    await writeSummary(runDir, result);
    await saveRunState(runDir, {
      task,
      instruction,
      nextIteration: stoppedPartial?.index ?? Math.max(startIteration, iterations.length),
      totalCostUsd: totalCost,
      usageStatus: totalUsage?.status ?? "unknown",
      usage: totalUsage,
      totalDurationMs: result.totalDurationMs,
      lastSavedAt: new Date().toISOString(),
      useWorktree,
      useIntegrity,
      worktree: worktreeInfo ?? undefined,
      stageRuntime,
      phase: "stopped",
      currentPhase: phase,
      currentStageId: details.stageId,
      partialIteration: stoppedPartial,
      lastError: providerError.message,
    });
    return result;
  };

  if (!resumeState) {
    await saveRunState(runDir, {
      task,
      instruction,
      nextIteration: 0,
      totalCostUsd: totalCost,
      usageStatus: totalUsage?.status ?? "unknown",
      usage: totalUsage,
      totalDurationMs: 0,
      lastSavedAt: new Date().toISOString(),
      useWorktree,
      useIntegrity,
      worktree: worktreeInfo ?? undefined,
      stageRuntime,
      phase: "ready",
      currentPhase,
    });
  }

  log(`\n${"═".repeat(60)}`);
  log(`Verdikt — Run ${runId}`);
  log(`Task: ${task.id} — ${task.goal}`);
  log(`Max iterations: ${task.maxIterations} | State: ${runDir}`);
  log(`Workspace: ${useWorktree ? "isolated (git worktree)" : "direct"}`);
  log(`${"═".repeat(60)}\n`);

  try {
    throwIfCancelled(options.signal);

    if (task.taskMode === "review") {
      log("  ▸ Read-only code reviewer running...");
      updatePhase("reviewing", "started");
      recordEvent("review_started", { data: { goal: task.goal } });
      const useStreaming = options.stream !== false;
      const reviewerResult = await runReviewer(
        { ...task, repoPath: workDir },
        {
          onChunk: useStreaming
            ? (text) => {
                recordEvent("review_output", { data: { text } });
                process.stdout.write(text);
              }
            : undefined,
          onComplete: useStreaming ? () => process.stdout.write("\n") : undefined,
          onStall: ({ elapsedMs, outputIdleMs }) => {
            reportStall("reviewing", { elapsedMs, outputIdleMs });
            recordEvent("review_stalled", { data: { elapsedMs, outputIdleMs } });
            warn(
              `  \u26a0 Review may be stalled (${Math.round(elapsedMs / 1000)}s elapsed, ${Math.round(outputIdleMs / 1000)}s without output).`,
            );
          },
        },
        options.signal,
      );
      throwIfCancelled(options.signal);
      await writeFile(join(runDir, "review-output.txt"), reviewerResult.text, "utf-8");
      const reviewUsage = reviewerResult.usage ?? usageFromLegacyCost(reviewerResult.costUsd);
      totalUsage = mergeUsage(totalUsage, reviewUsage);
      totalCost = totalUsage.costUsd ?? totalCost;
      if (reviewerResult.failure?.kind === "provider_error") {
        return stopForProviderError(reviewerResult.failure, "reviewing");
      }

      log("  ▸ Review acceptance checks running...");
      const reviewJudge = await runJudges(task.acceptance, workDir, options.signal);
      const reviewReport = {
        ...reviewerResult.report,
        acceptance: {
          passed: reviewJudge.passed,
          checks: reviewJudge.checks.map((check) => ({
            name: check.name,
            passed: check.passed,
            output: check.output,
          })),
        },
      };
      const reason =
        reviewReport.verdict === "incomplete" || !reviewJudge.passed
          ? "review_incomplete"
          : "review_completed";
      const result: RunResult = {
        reason,
        iterations,
        totalDurationMs: Date.now() - startTime,
        totalCostUsd: totalCost,
        usageStatus: totalUsage?.status ?? "unknown",
        usage: totalUsage,
        runId,
        taskId: task.id,
        workspace:
          useWorktree && worktreeInfo
            ? {
                path: worktreeInfo.worktreePath,
                baseCommit: worktreeInfo.baseCommit,
                originalRepoCleanBeforeApply: worktreeInfo.originalRepoCleanBeforeApply ?? true,
                mode: "isolated",
                repoPath: worktreeInfo.repoPath ?? task.repoPath,
                repoHead: worktreeInfo.repoHead ?? worktreeInfo.baseCommit,
                repoStatus: worktreeInfo.repoStatus ?? "",
                repoFingerprint: worktreeInfo.repoFingerprint,
                branchName: worktreeInfo.branchName,
                setupDurationMs: worktreeInfo.setupDurationMs,
                warmed: worktreeInfo.warmed,
              }
            : {
                path: workDir,
                baseCommit: "",
                originalRepoCleanBeforeApply: false,
                mode: "direct",
                setupDurationMs: 0,
                warmed: false,
              },
        patch: { filesChanged: 0, linesAdded: 0, linesDeleted: 0 },
        integritySummary: { status: "ok", criticalCount: 0, warningCount: 0, issues: [] },
        applyStatus: "discarded",
        stageProgress: stageRuntime,
        evidenceManifestPath: join(runDir, "evidence", "manifest.json"),
        reviewReport,
        reviewOnly: true,
      };
      updatePhase("reviewing", "completed");
      recordEvent("review_completed", {
        data: { verdict: reviewReport.verdict, findings: reviewReport.findings.length },
      });
      await writeSummary(runDir, result);
      await clearRunState(runDir);
      if (useWorktree && worktreeInfo) {
        await discardRun(task.repoPath, workDir, worktreeInfo.branchName);
      }
      releaseLock(stateDir, task.repoPath, runId);
      return result;
    }

    const planningRisks = evaluateTaskRisk(task).categories;
    const shouldPlan = shouldPlanTask(task, planningRisks);
    let savedPlan = shouldPlan ? await readSavedPlan(runDir) : null;
    if (shouldPlan && !savedPlan) {
      log("  ▸ Planner running in read-only mode...");
      updatePhase("planning", "started");
      recordEvent("plan_started", { data: { mode: task.planning?.mode ?? "off" } });
      const plannerResult = await runPlanner({ ...task, repoPath: workDir }, options.signal, {
        onStall: ({ elapsedMs, outputIdleMs }) => {
          reportStall("planning", { elapsedMs, outputIdleMs });
        },
      });
      const plannerUsage = plannerResult.usage ?? usageFromLegacyCost(plannerResult.costUsd);
      totalUsage = mergeUsage(totalUsage, plannerUsage);
      totalCost = totalUsage.costUsd ?? totalCost;
      if (plannerResult.failure?.kind === "provider_error") {
        return stopForProviderError(plannerResult.failure, "planning");
      }
      await writeSavedPlan(runDir, plannerResult.text);
      savedPlan = plannerResult.text.trim();
      updatePhase("planning", "completed");
      recordEvent("plan_completed", {
        data: { usageStatus: plannerUsage.status, costUsd: plannerUsage.costUsd },
      });
      await runAndRecordHooks(task, "after_plan", { runId, plan: savedPlan }, workDir);
      log(`  ▸ Plan saved: ${join(runDir, "plan.md")}`);
    }

    if (savedPlan) {
      instruction = appendPlanInstruction(instruction, savedPlan);
      const requirePlanApproval =
        task.planning?.requireApproval ?? task.planning?.mode === "required";
      if (requirePlanApproval) {
        const approvalRequest = {
          categories: ["manual" as const],
          reason: "Review the saved implementation plan before any files are changed.",
          stageId: "__plan__",
        };
        const approvalRecord = await readApprovalRecord(runDir);
        if (approvalRecord?.status === "rejected" && approvalRecord.stageId === "__plan__") {
          recordEvent("plan_rejected", { data: { reason: approvalRecord.decisionNote } });
          const result = buildPausedResult({
            reason: "approval_rejected",
            runId,
            runDir,
            task,
            iterations,
            totalCost,
            totalUsage,
            startTime,
            useWorktree,
            workDir,
            worktreeInfo,
            stageRuntime,
            approvalRequest,
          });
          await writeSummary(runDir, result);
          await clearRunState(runDir);
          if (useWorktree && worktreeInfo) {
            await discardRun(task.repoPath, workDir, worktreeInfo.branchName);
          }
          return result;
        }
        if (!isApprovalSatisfied(approvalRecord, approvalRequest.categories, "__plan__")) {
          await createApprovalRequest(runDir, approvalRequest);
          await saveRunState(runDir, {
            task,
            instruction,
            nextIteration: startIteration,
            totalCostUsd: totalCost,
            usageStatus: totalUsage?.status ?? "unknown",
            usage: totalUsage,
            totalDurationMs: Date.now() - startTime,
            lastSavedAt: new Date().toISOString(),
            useWorktree,
            useIntegrity,
            worktree: worktreeInfo ?? undefined,
            phase: "waiting_approval",
            stageRuntime,
            approvalRequest,
          });
          recordEvent("approval_requested", {
            data: { categories: approvalRequest.categories, plan: true },
          });
          return buildPausedResult({
            reason: "approval_required",
            runId,
            runDir,
            task,
            iterations,
            totalCost,
            totalUsage,
            startTime,
            useWorktree,
            workDir,
            worktreeInfo,
            stageRuntime,
            approvalRequest,
          });
        }
        recordEvent("plan_approved", { data: { stageId: "__plan__" } });
      }
    }

    for (let i = startIteration; i < task.maxIterations; i++) {
      throwIfCancelled(options.signal);
      const activeStage = getActiveStage(task, stageRuntime);
      log(`── Iteration ${i + 1}/${task.maxIterations} ──`);
      if (activeStage) {
        log(`  ▸ Stage: ${activeStage.title} (${activeStage.id})`);
      }

      const actionApprovalState = await readActionApprovalState(runDir);
      if (actionApprovalState.rejection) {
        const approvalRequest = approvalRequestFromAction(
          actionApprovalState.rejection,
          activeStage?.id,
        );
        const result = buildPausedResult({
          reason: "approval_rejected",
          runId,
          runDir,
          task,
          iterations,
          totalCost,
          totalUsage,
          startTime,
          useWorktree,
          workDir,
          worktreeInfo,
          stageRuntime,
          approvalRequest,
        });
        await writeSummary(runDir, result);
        await clearRunState(runDir);
        await clearActionRejection(runDir);
        if (useWorktree && worktreeInfo) {
          await discardRun(task.repoPath, workDir, worktreeInfo.branchName);
        }
        recordEvent("approval_rejected", {
          iteration: i,
          stageId: activeStage?.id,
          data: { action: approvalRequest.action, reason: approvalRequest.reason },
        });
        return result;
      }

      const runtimeApprovedCategories = new Set(task.riskPolicy?.approvedCategories ?? []);
      const risk = evaluateTaskRisk(task, activeStage ?? undefined);
      if (risk.action !== "allow") {
        const approvalRequest = {
          categories: risk.categories,
          reason: risk.reason,
          stageId: activeStage?.id,
        };
        const approvalRecord = await readApprovalRecord(runDir);
        const rejected =
          risk.action === "deny" ||
          (approvalRecord?.status === "rejected" &&
            approvalRecord.stageId === approvalRequest.stageId &&
            risk.categories.every((category) => approvalRecord.categories.includes(category)));

        if (rejected) {
          const result = buildPausedResult({
            reason: "approval_rejected",
            runId,
            runDir,
            task,
            iterations,
            totalCost,
            totalUsage,
            startTime,
            useWorktree,
            workDir,
            worktreeInfo,
            stageRuntime,
            approvalRequest,
          });
          await writeSummary(runDir, result);
          await clearRunState(runDir);
          if (useWorktree && worktreeInfo) {
            await discardRun(task.repoPath, workDir, worktreeInfo.branchName);
          }
          releaseLock(stateDir, task.repoPath, runId);
          return result;
        }

        if (!isApprovalSatisfied(approvalRecord, risk.categories, activeStage?.id)) {
          await createApprovalRequest(runDir, approvalRequest);
          await saveRunState(runDir, {
            task,
            instruction,
            nextIteration: i,
            totalCostUsd: totalCost,
            usageStatus: totalUsage?.status ?? "unknown",
            usage: totalUsage,
            totalDurationMs: Date.now() - startTime,
            lastSavedAt: new Date().toISOString(),
            useWorktree,
            useIntegrity,
            worktree: worktreeInfo ?? undefined,
            phase: "waiting_approval",
            currentStageId: activeStage?.id,
            stageRuntime,
            approvalRequest,
          });
          return buildPausedResult({
            reason: "approval_required",
            runId,
            runDir,
            task,
            iterations,
            totalCost,
            totalUsage,
            startTime,
            useWorktree,
            workDir,
            worktreeInfo,
            stageRuntime,
            approvalRequest,
          });
        }
        for (const category of approvalRecord?.categories ?? []) {
          runtimeApprovedCategories.add(category);
        }
      }

      partialIteration =
        partialIteration?.index === i
          ? partialIteration
          : {
              index: i,
              stageId: activeStage?.id,
              stageIteration: activeStage ? stageRuntime.stageIteration + 1 : undefined,
            };
      recordEvent("iteration_started", {
        iteration: i,
        stageId: activeStage?.id,
        data: { resumedPartial: Boolean(resumeState?.partialIteration?.index === i) },
      });
      // Apply user-queued guidance before this round's executor starts. Only
      // consume when the executor has not run yet — resuming a round whose
      // executor already completed must not mark unapplied notes as used.
      if (partialIteration.executorOutput === undefined) {
        const consumedNotes = await consumeQueuedNotes(runDir, i);
        if (consumedNotes.length > 0) {
          const noteBlock = consumedNotes.map((note) => `- ${note.text}`).join("\n");
          instruction = `${instruction}\n\n## 用户补充说明(本轮必须遵守)\n${noteBlock}`;
          for (const note of consumedNotes) {
            recordEvent("note_consumed", {
              iteration: i,
              stageId: activeStage?.id,
              data: { id: note.id, text: note.text, source: note.source },
            });
          }
          log(`  > 应用 ${consumedNotes.length} 条补充说明到本轮指令。`);
        }
      }
      await saveRunState(runDir, {
        task,
        instruction,
        nextIteration: i,
        totalCostUsd: totalCost,
        usageStatus: totalUsage?.status ?? "unknown",
        usage: totalUsage,
        totalDurationMs: Date.now() - startTime,
        lastSavedAt: new Date().toISOString(),
        useWorktree,
        useIntegrity,
        worktree: worktreeInfo ?? undefined,
        stageRuntime,
        phase: "running",
        currentPhase,
        currentStageId: activeStage?.id,
        partialIteration,
      });

      const roundTask: TaskSpec = {
        ...task,
        repoPath: workDir,
        acceptance: activeStage?.acceptance ?? task.acceptance,
        riskPolicy: {
          ...task.riskPolicy,
          approvedCategories: [...runtimeApprovedCategories],
        },
      };

      let preExecutorCommit = partialIteration.preExecutorCommit;
      let execResult: DriverOutput;
      let execUsage: UsageSummary;

      if (partialIteration.executorOutput === undefined) {
        if (useWorktree && worktreeInfo) {
          preExecutorCommit = (await getHeadCommit(workDir)).trim();
          partialIteration.preExecutorCommit = preExecutorCommit;
        }

        log("  > Executor running...");
        updatePhase("executor", "started", i, activeStage?.id);
        recordEvent("executor_started", { iteration: i, stageId: activeStage?.id });
        const useStreaming = options.stream !== false;
        execResult = await runExecutor(
          roundTask,
          activeStage
            ? `Current stage: ${activeStage.title}\nStage goal: ${activeStage.goal}\n\n${instruction}`
            : instruction,
          {
            onChunk: useStreaming
              ? (text) => {
                  recordEvent("executor_output", {
                    iteration: i,
                    stageId: activeStage?.id,
                    data: { text },
                  });
                  process.stdout.write(text);
                }
              : undefined,
            onComplete: useStreaming ? () => process.stdout.write("\n") : undefined,
            onStall: ({ elapsedMs, outputIdleMs }) => {
              reportStall("executor", { elapsedMs, outputIdleMs }, i, activeStage?.id);
              recordEvent("executor_stalled", {
                iteration: i,
                stageId: activeStage?.id,
                data: { elapsedMs, outputIdleMs },
              });
              warn(
                `  Warning: executor may be stalled (${Math.round(elapsedMs / 1000)}s elapsed, ${Math.round(outputIdleMs / 1000)}s without output).`,
              );
            },
          },
          options.signal,
          { runDir },
        );
        throwIfCancelled(options.signal);
        await runAndRecordHooks(
          task,
          "after_executor",
          { runId, iteration: i, output: execResult.text },
          workDir,
        );
        execUsage = execResult.usage ?? usageFromLegacyCost(execResult.costUsd);
        totalUsage = mergeUsage(totalUsage, execUsage);
        totalCost = totalUsage.costUsd ?? totalCost;
        partialIteration.executorOutput = execResult.text;
        partialIteration.executorDurationMs = execResult.durationMs;
        partialIteration.executorUsage = execUsage;
        await saveRunState(runDir, {
          task,
          instruction,
          nextIteration: i,
          totalCostUsd: totalCost,
          usageStatus: totalUsage?.status ?? "unknown",
          usage: totalUsage,
          totalDurationMs: Date.now() - startTime,
          lastSavedAt: new Date().toISOString(),
          useWorktree,
          useIntegrity,
          worktree: worktreeInfo ?? undefined,
          stageRuntime,
          phase: "running",
          currentPhase,
          currentStageId: activeStage?.id,
          partialIteration,
        });
        updatePhase("executor", "completed", i, activeStage?.id);
        log(`  > Executor done (${execResult.durationMs}ms, ${formatCost(execUsage)})`);
        recordEvent("executor_completed", {
          iteration: i,
          stageId: activeStage?.id,
          data: { durationMs: execResult.durationMs, usage: execUsage },
        });
      } else {
        execUsage = partialIteration.executorUsage ?? usageFromLegacyCost(undefined);
        execResult = {
          text: partialIteration.executorOutput,
          timedOut: false,
          durationMs: partialIteration.executorDurationMs ?? 0,
          costUsd: execUsage.costUsd,
          usage: execUsage,
        };
        log("  > Resuming after the completed executor phase.");
      }

      if (execResult.failure?.kind === "provider_error") {
        partialIteration.executorDurationMs = execResult.durationMs;
        partialIteration.executorUsage = execUsage;

        // Preserve any partial work before returning a resumable provider failure.
        if (partialIteration.changedFiles === undefined) {
          try {
            let changedFiles: string[] = [];
            let patchPath: string | undefined;
            let linesAdded = 0;
            let linesDeleted = 0;
            let checkpointCommit: string | undefined;
            if (useWorktree && worktreeInfo) {
              const diff = await captureIterationDiff(
                workDir,
                worktreeInfo.evidenceDir,
                i,
                partialIteration.preExecutorCommit,
              );
              changedFiles = diff.changedFiles;
              patchPath = diff.patchPath;
              linesAdded = diff.linesAdded;
              linesDeleted = diff.linesDeleted;
              checkpointCommit = await checkpointIteration(workDir, i);
            } else {
              const { collectEvidence } = await import("../workspace/collectEvidence.js");
              changedFiles = await collectEvidence(workDir);
            }
            partialIteration.changedFiles = changedFiles;
            partialIteration.patchPath = patchPath;
            partialIteration.linesAdded = linesAdded || undefined;
            partialIteration.linesDeleted = linesDeleted || undefined;
            partialIteration.checkpointCommit = checkpointCommit;
            recordEvent("patch_ready", {
              iteration: i,
              stageId: activeStage?.id,
              data: {
                path: patchPath,
                filesChanged: changedFiles,
                linesAdded,
                linesDeleted,
                partial: true,
              },
            });
          } catch (error) {
            warn(
              `  ⚠ Could not capture partial provider-failure evidence: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            partialIteration.changedFiles = [];
          }
        }

        return stopForProviderError(execResult.failure, "executor", {
          iteration: i,
          stageId: activeStage?.id,
          partial: partialIteration,
        });
      }

      if (task.maxBudgetUsd) {
        if (!budgetEnforcementWarned && (totalUsage?.status ?? "unknown") !== "complete") {
          budgetEnforcementWarned = true;
          warn(
            "  ⚠ 花费数据不完整(unknown/partial),预算上限 maxBudgetUsd 无法严格执行,实际花费可能超出限制。",
          );
        }
        const pct = totalCost / task.maxBudgetUsd;
        if (pct >= 1.0) {
          warn(
            `  Budget exceeded: ${formatCost(totalUsage, 2)} / $${task.maxBudgetUsd.toFixed(2)}`,
          );
        } else if (pct >= 0.8) {
          warn(
            `  Budget warning: ${formatCost(totalUsage, 2)} / $${task.maxBudgetUsd.toFixed(2)} (${(pct * 100).toFixed(0)}%)`,
          );
        }
      }

      let changedFiles = partialIteration.changedFiles ?? [];
      let patchPath = partialIteration.patchPath;
      let iterLinesAdded = partialIteration.linesAdded ?? 0;
      let iterLinesDeleted = partialIteration.linesDeleted ?? 0;
      let checkpointCommit = partialIteration.checkpointCommit;

      if (partialIteration.changedFiles === undefined) {
        if (useWorktree && worktreeInfo) {
          const diff = await captureIterationDiff(
            workDir,
            worktreeInfo.evidenceDir,
            i,
            preExecutorCommit,
          );
          changedFiles = diff.changedFiles;
          patchPath = diff.patchPath;
          iterLinesAdded = diff.linesAdded;
          iterLinesDeleted = diff.linesDeleted;
          checkpointCommit = await checkpointIteration(workDir, i);
          log(
            `  > Patch: ${patchPath} (${changedFiles.length} files, +${iterLinesAdded}/-${iterLinesDeleted})`,
          );
        } else {
          const { collectEvidence } = await import("../workspace/collectEvidence.js");
          changedFiles = await collectEvidence(workDir);
        }
        partialIteration.changedFiles = changedFiles;
        partialIteration.patchPath = patchPath;
        partialIteration.linesAdded = iterLinesAdded || undefined;
        partialIteration.linesDeleted = iterLinesDeleted || undefined;
        partialIteration.checkpointCommit = checkpointCommit;
        recordEvent("patch_ready", {
          iteration: i,
          stageId: activeStage?.id,
          data: {
            path: patchPath,
            filesChanged: changedFiles,
            linesAdded: iterLinesAdded,
            linesDeleted: iterLinesDeleted,
          },
        });
        await saveRunState(runDir, {
          task,
          instruction,
          nextIteration: i,
          totalCostUsd: totalCost,
          usageStatus: totalUsage?.status ?? "unknown",
          usage: totalUsage,
          totalDurationMs: Date.now() - startTime,
          lastSavedAt: new Date().toISOString(),
          useWorktree,
          useIntegrity,
          worktree: worktreeInfo ?? undefined,
          stageRuntime,
          phase: "running",
          currentPhase,
          currentStageId: activeStage?.id,
          partialIteration,
        });
      }
      throwIfCancelled(options.signal);
      log(`  > Changed files: ${changedFiles.length > 0 ? changedFiles.join(", ") : "(none)"}`);

      let integritySnapshot = partialIteration.integrity;
      let integrityCriticalViolations: Array<{ rule: string; detail: string }> = [];
      if (useIntegrity && baseline) {
        if (!integritySnapshot) {
          const check = await checkTestIntegrity(workDir, baseline, task.integrity ?? {});
          const crits = check.violations.filter((violation) => violation.severity === "critical");
          const warns = check.violations.filter((violation) => violation.severity === "warning");
          integritySnapshot = {
            status: check.violations.length > 0 ? "violations" : "ok",
            criticalCount: crits.length,
            warningCount: warns.length,
            issues: check.violations.map((violation) => ({
              rule: violation.rule,
              detail: violation.detail,
              severity: violation.severity,
            })),
          };
          partialIteration.integrity = integritySnapshot;
          if (check.violations.length > 0) {
            integrityViolations.push({ iteration: i, violations: check.violations });
          }
        }
        const capturedIntegrity = integritySnapshot;
        if (!capturedIntegrity) {
          throw new Error("Integrity check did not produce a snapshot");
        }
        const snapshotViolations: IntegrityViolation[] = capturedIntegrity.issues.map(
          (issue, index) => ({
            rule: issue.rule,
            detail: issue.detail,
            severity:
              issue.severity ?? (index < capturedIntegrity.criticalCount ? "critical" : "warning"),
          }),
        );
        if (
          snapshotViolations.length > 0 &&
          !integrityViolations.some((finding) => finding.iteration === i)
        ) {
          integrityViolations.push({ iteration: i, violations: snapshotViolations });
        }
        integrityCriticalViolations = snapshotViolations
          .filter((issue) => issue.severity === "critical")
          .map(({ rule, detail }) => ({ rule, detail }));
        if (integrityCriticalViolations.length > 0) {
          warn(`  Integrity violation: ${integrityCriticalViolations.length} critical issue(s)`);
        } else if (capturedIntegrity.warningCount > 0) {
          warn(`  Integrity warning: ${capturedIntegrity.warningCount} warning(s)`);
        } else {
          log("  > Integrity: OK");
        }
      }
      throwIfCancelled(options.signal);

      let judge = partialIteration.judge;
      if (!judge) {
        log("  > Judges running...");
        updatePhase("judges", "started", i, activeStage?.id);
        recordEvent("judges_started", { iteration: i, stageId: activeStage?.id });
        judge = await runJudges(roundTask.acceptance, workDir, options.signal);
        throwIfCancelled(options.signal);
        const passedCount = judge.checks.filter((check) => check.passed).length;
        log(
          `  > Judges: ${passedCount}/${judge.checks.length} passed ${judge.passed ? "PASS" : "FAIL"}`,
        );
        await runAndRecordHooks(task, "after_judges", { runId, iteration: i, judge }, workDir);
        partialIteration.judge = judge;
        updatePhase("judges", "completed", i, activeStage?.id);
        recordEvent("judges_completed", {
          iteration: i,
          stageId: activeStage?.id,
          data: { passed: judge.passed, checks: judge.checks.length },
        });
        await saveRunState(runDir, {
          task,
          instruction,
          nextIteration: i,
          totalCostUsd: totalCost,
          usageStatus: totalUsage?.status ?? "unknown",
          usage: totalUsage,
          totalDurationMs: Date.now() - startTime,
          lastSavedAt: new Date().toISOString(),
          useWorktree,
          useIntegrity,
          worktree: worktreeInfo ?? undefined,
          stageRuntime,
          phase: "running",
          currentPhase,
          currentStageId: activeStage?.id,
          partialIteration,
        });
      } else {
        log("  > Resuming after completed judge checks.");
      }

      let semanticGateFailed = false;
      let semanticFindings: import("../workspace/semantic-scanner.js").SemanticRiskResult | null =
        null;
      if (task.semantic?.maxRisk && useWorktree && worktreeInfo) {
        try {
          const { readFile } = await import("node:fs/promises");
          const iterationPatchPath = join(worktreeInfo.evidenceDir, `iteration-${i}.patch`);
          const patchContent = await readFile(iterationPatchPath, "utf-8");
          semanticFindings = scanPatchRisk(patchContent, changedFiles);
          const riskOrder = { none: 0, low: 1, medium: 2, high: 3 };
          if (
            riskOrder[semanticFindings.level] > riskOrder[task.semantic.maxRisk] &&
            judge.passed
          ) {
            semanticGateFailed = true;
            warn(
              `  Semantic gate failed: risk=${semanticFindings.level}, max=${task.semantic.maxRisk}`,
            );
          }
        } catch {
          // Patch read failures do not block objective checks.
        }
      }

      const effectiveJudge = semanticGateFailed
        ? {
            ...judge,
            passed: false,
            checks: [
              ...judge.checks,
              {
                name: "semantic-risk",
                passed: false,
                output: `Semantic risk ${semanticFindings?.level} exceeds max ${task.semantic?.maxRisk}`,
                exitCode: 1,
                durationMs: 0,
              },
            ],
          }
        : judge;
      const gatedJudge =
        integrityCriticalViolations.length > 0
          ? {
              ...effectiveJudge,
              passed: false,
              checks: [
                ...effectiveJudge.checks,
                {
                  name: "integrity",
                  passed: false,
                  output: integrityCriticalViolations
                    .map((violation) => `[${violation.rule}] ${violation.detail}`)
                    .join("\n"),
                  exitCode: 1,
                  durationMs: 0,
                },
              ],
            }
          : effectiveJudge;

      let verdict = partialIteration.verifierVerdict;
      let verifierUsage = partialIteration.verifierUsage;
      const skipVerifierForBudget =
        !verdict &&
        !gatedJudge.passed &&
        task.maxBudgetUsd != null &&
        totalCost >= task.maxBudgetUsd;
      if (skipVerifierForBudget) {
        // Budget is already blown and the objective checks failed — a verifier
        // call cannot turn this round into a pass, so skip its cost. When the
        // judge PASSED we still run the verifier: a passing result outranks
        // the budget stop and must not be thrown away.
        warn("  ⚠ 预算已超出且验收未通过,跳过本轮审查 agent 以避免额外花费。");
        verdict = {
          done: false,
          problems: ["预算已超出,本轮跳过审查 agent。"],
          nextInstruction: instruction,
        };
        verifierUsage = usageFromLegacyCost(undefined);
        partialIteration.verifierVerdict = verdict;
        partialIteration.verifierUsage = verifierUsage;
      } else if (!verdict) {
        log("  > Verifier running...");
        updatePhase("verifier", "started", i, activeStage?.id);
        recordEvent("verifier_started", { iteration: i, stageId: activeStage?.id });
        const verifierResult = await runVerifier(
          roundTask,
          gatedJudge,
          execResult.text,
          options.signal,
          {
            completionGoal: activeStage?.goal,
            requireJudgePass: stageRequiresJudgePass(task, stageRuntime),
            streamCallbacks: {
              onStall: ({ elapsedMs, outputIdleMs }) => {
                reportStall("verifier", { elapsedMs, outputIdleMs }, i, activeStage?.id);
              },
            },
          },
        );
        verifierUsage = verifierResult.usage ?? usageFromLegacyCost(verifierResult.costUsd);
        totalUsage = mergeUsage(totalUsage, verifierUsage);
        totalCost = totalUsage.costUsd ?? totalCost;
        partialIteration.verifierUsage = verifierUsage;
        if (verifierResult.failure?.kind === "provider_error") {
          return stopForProviderError(verifierResult.failure, "verifier", {
            iteration: i,
            stageId: activeStage?.id,
            partial: partialIteration,
          });
        }
        verdict = verifierResult.verdict;
        partialIteration.verifierVerdict = verdict;
        updatePhase("verifier", "completed", i, activeStage?.id);
        recordEvent("verifier_completed", {
          iteration: i,
          stageId: activeStage?.id,
          data: { done: verdict.done, problems: verdict.problems, usage: verifierUsage },
        });
        await saveRunState(runDir, {
          task,
          instruction,
          nextIteration: i,
          totalCostUsd: totalCost,
          usageStatus: totalUsage?.status ?? "unknown",
          usage: totalUsage,
          totalDurationMs: Date.now() - startTime,
          lastSavedAt: new Date().toISOString(),
          useWorktree,
          useIntegrity,
          worktree: worktreeInfo ?? undefined,
          stageRuntime,
          phase: "running",
          currentPhase,
          currentStageId: activeStage?.id,
          partialIteration,
        });
        throwIfCancelled(options.signal);
      } else {
        verifierUsage ??= usageFromLegacyCost(undefined);
        log("  > Resuming after the completed verifier phase.");
      }
      log(
        `  > Verifier: done=${verdict.done}, problems=${verdict.problems.length}, ${formatCost(verifierUsage)}`,
      );

      if (task.maxBudgetUsd) {
        const pct = totalCost / task.maxBudgetUsd;
        if (pct >= 1.0) {
          warn(
            `  Budget exceeded: ${formatCost(totalUsage, 2)} / $${task.maxBudgetUsd.toFixed(2)}`,
          );
        } else if (pct >= 0.8) {
          warn(
            `  Budget warning: ${formatCost(totalUsage, 2)} / $${task.maxBudgetUsd.toFixed(2)} (${(pct * 100).toFixed(0)}%)`,
          );
        }
      }
      for (const problem of verdict.problems) log(`    - ${problem}`);

      const iterationUsage = mergeUsage(execUsage, verifierUsage);
      const iterCost = iterationUsage.costUsd ?? 0;
      const record: IterationRecord = {
        index: i,
        stageId: activeStage?.id,
        stageIteration: activeStage ? stageRuntime.stageIteration + 1 : undefined,
        executorOutput: execResult.text,
        changedFiles,
        judge: gatedJudge,
        verifierVerdict: verdict,
        tokensUsed: undefined,
        costUsd: iterationUsage.costUsd,
        usageStatus: iterationUsage.status,
        usage: iterationUsage,
        durationMs: execResult.durationMs,
        checkpointCommit,
        patchPath,
        integrity: integritySnapshot,
        judgeExitCode: judge.checks[0]?.exitCode,
        linesAdded: iterLinesAdded || undefined,
        linesDeleted: iterLinesDeleted || undefined,
      };
      iterations.push(record);
      await recordIteration(runDir, record);
      partialIteration = undefined;
      recordEvent("iteration_completed", {
        iteration: i,
        stageId: activeStage?.id,
        data: { passed: gatedJudge.passed && verdict.done, usage: iterationUsage },
      });

      stageRuntime = recordStageAttempt(stageRuntime, iterCost);
      const completedCurrentStage =
        Boolean(activeStage) &&
        isStageComplete({ task, runtime: stageRuntime, judge: gatedJudge, verdict });
      if (completedCurrentStage) {
        stageRuntime = advanceStage(task, stageRuntime);
        const nextStage = getActiveStage(task, stageRuntime);
        if (nextStage) {
          instruction = nextStage.goal;
          const checkpointState = {
            task,
            instruction,
            nextIteration: i + 1,
            totalCostUsd: totalCost,
            usageStatus: totalUsage?.status ?? ("unknown" as const),
            usage: totalUsage,
            totalDurationMs: Date.now() - startTime,
            lastSavedAt: new Date().toISOString(),
            useWorktree,
            useIntegrity,
            worktree: worktreeInfo ?? undefined,
            phase: "between_iterations" as const,
            currentStageId: nextStage.id,
            stageRuntime,
          };
          await saveRunState(runDir, checkpointState);
          if (checkpointCommit) {
            await saveIterationCheckpoint(runDir, i, checkpointCommit, checkpointState);
          }
          log(`  \u25b8 Stage ${activeStage?.id} complete. Advancing to ${nextStage.id}.`);
          continue;
        }
      }

      // M6: Save run state for resume capability
      const checkpointState = {
        task,
        instruction: verdict.nextInstruction || instruction,
        nextIteration: i + 1,
        totalCostUsd: totalCost,
        usageStatus: totalUsage?.status ?? ("unknown" as const),
        usage: totalUsage,
        totalDurationMs: Date.now() - startTime,
        lastSavedAt: new Date().toISOString(),
        useWorktree,
        useIntegrity,
        worktree: worktreeInfo ?? undefined,
        stageRuntime,
        phase: "between_iterations" as const,
        currentStageId: activeStage?.id,
      };
      await saveRunState(runDir, checkpointState);
      if (checkpointCommit) {
        await saveIterationCheckpoint(runDir, i, checkpointCommit, checkpointState);
      }

      // (7) Stop decision
      const stageFailure = completedCurrentStage ? null : stageLimitFailure(task, stageRuntime);
      const decision = stageFailure
        ? { stop: true, reason: "stage_failed" as const }
        : decideStop(iterations, task, totalCost);
      if (stageFailure) warn(`  \u26a0 ${stageFailure}`);

      if (decision.stop) {
        updatePhase("finalizing", "started", i, activeStage?.id);
        const totalDurationMs = Date.now() - startTime;
        log(`\n${"═".repeat(60)}`);
        log(`STOP: ${decision.reason} after ${iterations.length} iteration(s)`);
        log(
          `Duration: ${(totalDurationMs / 1000).toFixed(1)}s | Cost: ${formatCost(totalUsage, 4)}`,
        );
        log(`${"═".repeat(60)}\n`);

        // M3: Compute patch stats and prepare explicit-apply patch before publishing summary.
        let finalPatchPath: string | undefined;
        const totalLinesAdded = iterations.reduce((sum, iter) => sum + (iter.linesAdded ?? 0), 0);
        const totalLinesDeleted = iterations.reduce(
          (sum, iter) => sum + (iter.linesDeleted ?? 0),
          0,
        );
        if (decision.reason === "passed" && useWorktree && worktreeInfo) {
          finalPatchPath = join(worktreeInfo.evidenceDir, "final.patch");
          await mkdir(worktreeInfo.evidenceDir, { recursive: true });
          await writeFinalPatch(workDir, worktreeInfo.baseCommit, finalPatchPath);
          log(`  ▸ Run passed. Patch saved: ${finalPatchPath}`);
          if (!options.autoApply) {
            log(`  ▸ To apply: verdikt apply ${runId}`);
            log(`  ▸ To discard: verdikt discard ${runId}`);
          }
        }

        // M4: Semantic risk scan (warning only)
        let semanticRiskSummary: import("../types.js").SemanticRiskSummary | undefined;
        if (finalPatchPath && decision.reason === "passed") {
          try {
            const { readFile } = await import("node:fs/promises");
            const patchContent = await readFile(finalPatchPath, "utf-8");
            const allChangedSrc = [...new Set(iterations.flatMap((it) => it.changedFiles))];
            const risk = scanPatchRisk(patchContent, allChangedSrc);
            semanticRiskSummary = {
              level: risk.level,
              findingCount: risk.findings.length,
              highCount: risk.findings.filter((f) => f.severity === "high").length,
              mediumCount: risk.findings.filter((f) => f.severity === "medium").length,
              lowCount: risk.findings.filter((f) => f.severity === "low").length,
              topFindings: risk.findings.slice(0, 5).map((f) => ({
                rule: f.rule,
                detail: f.detail,
                file: f.file,
                snippet: f.snippet,
              })),
            };
            if (risk.level !== "none") {
              log(`  ⚠ Semantic risk: ${risk.level} (${risk.findings.length} finding(s))`);
              for (const f of risk.findings.slice(0, 3)) {
                log(`    • [${f.severity}] ${f.rule}: ${f.snippet}`);
              }
            } else {
              log("  ▸ Semantic risk: none ✓");
            }
          } catch {
            // Patch read failed — not critical
          }
        }

        const workspaceMetadata = buildWorkspaceMetadata(task, useWorktree, workDir, worktreeInfo);
        let applyStatus: RunResult["applyStatus"] = "pending";
        if (decision.reason === "passed" && useWorktree && worktreeInfo && options.autoApply) {
          log("  ▸ Auto-applying changes to original repo...");
          if (!finalPatchPath) throw new Error("Final patch was not prepared for auto-apply");
          await applyProtectedPatch({
            stateDir,
            runDir,
            runId,
            repoPath: task.repoPath,
            patchPath: finalPatchPath,
            task,
            savedWorkspace: { ...workspaceMetadata },
            worktreePath: workDir,
            branchName: worktreeInfo.branchName,
          });
          recordEvent("patch_applied", {
            data: { repoPath: task.repoPath, patchPath: finalPatchPath, automatic: true },
          });
          log("  ▸ Changes applied ✓");
          log("  ▸ Workspace cleaned up ✓");
          applyStatus = "applied";
        }

        const result: RunResult = {
          reason: decision.reason ?? "max_iterations",
          iterations,
          totalDurationMs,
          totalCostUsd: totalCost,
          usageStatus: totalUsage?.status ?? "unknown",
          usage: totalUsage,
          // M3 fields
          runId,
          taskId: task.id,
          workspace: workspaceMetadata,
          patch: {
            finalPatchPath,
            filesChanged: [...new Set(iterations.flatMap((it) => it.changedFiles))].length,
            linesAdded: totalLinesAdded,
            linesDeleted: totalLinesDeleted,
          },
          integritySummary: useIntegrity ? buildIntegritySummary(integrityViolations) : undefined,
          applyStatus,
          semanticRisk: semanticRiskSummary,
          stageProgress: stageRuntime,
          evidenceManifestPath: join(runDir, "evidence", "manifest.json"),
          currentPhase: "finalizing",
          resumable: false,
        };
        updatePhase("finalizing", "completed", i, activeStage?.id);
        await writeSummary(runDir, result);
        await clearRunState(runDir);

        // ── M2: Apply or discard based on outcome ─────────────────────
        if (decision.reason !== "passed" && useWorktree && worktreeInfo) {
          log("  ▸ Discarding workspace (run did not pass)...");
          await discardRun(task.repoPath, workDir, worktreeInfo.branchName);
          log("  ▸ Workspace discarded ✓");
        }

        if (integrityViolations.length > 0) {
          log("  ⚠ Integrity violations were detected during this run:");
          for (const iv of integrityViolations) {
            log(
              `    Iteration ${iv.iteration + 1}: ${iv.violations
                .map(
                  (violation) => `[${violation.severity}] ${violation.rule}: ${violation.detail}`,
                )
                .join("; ")}`,
            );
          }
        }

        releaseLock(stateDir, task.repoPath, runId);
        return result;
      }

      // (8) Not done — use verifier's instruction for next round
      instruction = verdict.nextInstruction;
      log(
        `  ▸ Next round instruction: ${instruction.slice(0, 200)}${instruction.length > 200 ? "..." : ""}\n`,
      );
    }

    // Should not reach here, but handle defensively
    const totalDurationMs = Date.now() - startTime;
    const result: RunResult = {
      reason: "max_iterations",
      iterations,
      totalDurationMs,
      totalCostUsd: totalCost,
      usageStatus: totalUsage?.status ?? "unknown",
      usage: totalUsage,
      stageProgress: stageRuntime,
      evidenceManifestPath: join(runDir, "evidence", "manifest.json"),
    };
    await writeSummary(runDir, result);
    await clearRunState(runDir);

    // Discard on max_iterations
    if (useWorktree && worktreeInfo) {
      await discardRun(task.repoPath, workDir, worktreeInfo.branchName);
      log("  ▸ Workspace discarded (max iterations reached)");
    }

    releaseLock(stateDir, task.repoPath, runId);
    return result;
  } catch (err) {
    const cancellation =
      err instanceof RunCancelledError
        ? err
        : options.signal?.aborted
          ? new RunCancelledError(
              options.signal.reason === "app_shutdown" ? "interrupted" : "cancelled",
            )
          : null;
    if (cancellation) {
      if (options.signal?.reason === "approval_rejected") {
        const rejection = (await readActionApprovalState(runDir)).rejection;
        if (rejection) {
          const approvalRequest = approvalRequestFromAction(
            rejection,
            getActiveStage(task, stageRuntime)?.id,
          );
          const result = buildPausedResult({
            reason: "approval_rejected",
            runId,
            runDir,
            task,
            iterations,
            totalCost,
            totalUsage,
            startTime,
            useWorktree,
            workDir,
            worktreeInfo,
            stageRuntime,
            approvalRequest,
          });
          await writeSummary(runDir, result);
          await clearRunState(runDir);
          await clearActionRejection(runDir);
          if (useWorktree && worktreeInfo) {
            await discardRun(task.repoPath, workDir, worktreeInfo.branchName);
          }
          releaseLock(stateDir, task.repoPath, runId);
          return result;
        }
      }
      const stoppedReason = cancellation.reason;
      const partialFiles = partialIteration?.changedFiles ?? [];
      const result: RunResult = {
        reason: stoppedReason,
        iterations,
        totalDurationMs: Date.now() - startTime,
        totalCostUsd: totalCost,
        usageStatus: totalUsage?.status ?? "unknown",
        usage: totalUsage,
        runId,
        taskId: task.id,
        stageProgress: stageRuntime,
        evidenceManifestPath: join(runDir, "evidence", "manifest.json"),
        workspace:
          useWorktree && worktreeInfo
            ? {
                path: worktreeInfo.worktreePath,
                baseCommit: worktreeInfo.baseCommit,
                originalRepoCleanBeforeApply: worktreeInfo.originalRepoCleanBeforeApply ?? true,
                mode: "isolated",
                repoPath: worktreeInfo.repoPath ?? task.repoPath,
                repoHead: worktreeInfo.repoHead ?? worktreeInfo.baseCommit,
                repoStatus: worktreeInfo.repoStatus ?? "",
                repoFingerprint: worktreeInfo.repoFingerprint,
                branchName: worktreeInfo.branchName,
                setupDurationMs: worktreeInfo.setupDurationMs,
                warmed: worktreeInfo.warmed,
              }
            : {
                path: workDir,
                baseCommit: "",
                originalRepoCleanBeforeApply: false,
                mode: "direct",
                setupDurationMs: 0,
                warmed: false,
              },
        patch: {
          filesChanged: [
            ...new Set([
              ...iterations.flatMap((iteration) => iteration.changedFiles),
              ...partialFiles,
            ]),
          ].length,
          linesAdded:
            iterations.reduce((sum, iteration) => sum + (iteration.linesAdded ?? 0), 0) +
            (partialIteration?.linesAdded ?? 0),
          linesDeleted:
            iterations.reduce((sum, iteration) => sum + (iteration.linesDeleted ?? 0), 0) +
            (partialIteration?.linesDeleted ?? 0),
        },
        integritySummary: useIntegrity ? buildIntegritySummary(integrityViolations) : undefined,
        applyStatus: "pending",
        partialIteration,
        resumable: true,
        currentPhase,
      };

      await writeSummary(runDir, result);
      await saveRunState(runDir, {
        task,
        instruction,
        nextIteration: partialIteration?.index ?? Math.max(startIteration, iterations.length),
        totalCostUsd: totalCost,
        usageStatus: totalUsage?.status ?? "unknown",
        usage: totalUsage,
        totalDurationMs: Date.now() - startTime,
        lastSavedAt: new Date().toISOString(),
        useWorktree,
        useIntegrity,
        worktree: worktreeInfo ?? undefined,
        stageRuntime,
        phase: stoppedReason === "interrupted" ? "interrupted" : "stopped",
        currentPhase,
        currentStageId: getActiveStage(task, stageRuntime)?.id,
        partialIteration,
        lastError:
          stoppedReason === "interrupted"
            ? "App shut down before the run completed"
            : "User stopped the run before it completed",
      });
      releaseLock(stateDir, task.repoPath, runId);
      return result;
    }

    if (useWorktree && worktreeInfo) {
      log("  \u26a0 Error occurred. Preserving isolated workspace for resume.");
    }
    await saveRunState(runDir, {
      task,
      instruction,
      nextIteration: Math.max(startIteration, iterations.length),
      totalCostUsd: totalCost,
      usageStatus: totalUsage?.status ?? "unknown",
      usage: totalUsage,
      totalDurationMs: Date.now() - startTime,
      lastSavedAt: new Date().toISOString(),
      useWorktree,
      useIntegrity,
      worktree: worktreeInfo ?? undefined,
      stageRuntime,
      phase: "error",
      currentPhase,
      currentStageId: getActiveStage(task, stageRuntime)?.id,
      partialIteration,
      lastError: err instanceof Error ? err.message : String(err),
    });
    releaseLock(stateDir, task.repoPath, runId);
    throw err;
  }
}

function approvalRequestFromAction(
  action: {
    signature: string;
    command: string;
    tool: string;
    cwd?: string;
    categories: import("../types.js").RiskCategory[];
    reason: string;
  },
  stageId?: string,
): import("../types.js").ApprovalRequest {
  return {
    categories: action.categories,
    reason: action.reason,
    stageId,
    action: {
      signature: action.signature,
      command: action.command,
      tool: action.tool,
      cwd: action.cwd,
    },
  };
}

function buildPausedResult(options: {
  reason: "approval_required" | "approval_rejected";
  runId: string;
  runDir: string;
  task: TaskSpec;
  iterations: IterationRecord[];
  totalCost: number;
  totalUsage?: UsageSummary;
  startTime: number;
  useWorktree: boolean;
  workDir: string;
  worktreeInfo: Awaited<ReturnType<typeof createRunWorktree>> | null;
  stageRuntime: import("../types.js").StageRuntimeState;
  approvalRequest: import("../types.js").ApprovalRequest;
}): RunResult {
  return {
    reason: options.reason,
    iterations: options.iterations,
    totalDurationMs: Date.now() - options.startTime,
    totalCostUsd: options.totalCost,
    usageStatus: options.totalUsage?.status ?? "unknown",
    usage: options.totalUsage,
    runId: options.runId,
    taskId: options.task.id,
    workspace:
      options.useWorktree && options.worktreeInfo
        ? {
            path: options.worktreeInfo.worktreePath,
            baseCommit: options.worktreeInfo.baseCommit,
            originalRepoCleanBeforeApply: options.worktreeInfo.originalRepoCleanBeforeApply ?? true,
            mode: "isolated",
            repoPath: options.worktreeInfo.repoPath ?? options.task.repoPath,
            repoHead: options.worktreeInfo.repoHead ?? options.worktreeInfo.baseCommit,
            repoStatus: options.worktreeInfo.repoStatus ?? "",
            repoFingerprint: options.worktreeInfo.repoFingerprint,
            branchName: options.worktreeInfo.branchName,
            setupDurationMs: options.worktreeInfo.setupDurationMs,
            warmed: options.worktreeInfo.warmed,
          }
        : {
            path: options.workDir,
            baseCommit: "",
            originalRepoCleanBeforeApply: false,
            mode: "direct",
            setupDurationMs: 0,
            warmed: false,
          },
    patch: {
      filesChanged: [...new Set(options.iterations.flatMap((iteration) => iteration.changedFiles))]
        .length,
      linesAdded: options.iterations.reduce(
        (sum, iteration) => sum + (iteration.linesAdded ?? 0),
        0,
      ),
      linesDeleted: options.iterations.reduce(
        (sum, iteration) => sum + (iteration.linesDeleted ?? 0),
        0,
      ),
    },
    applyStatus: "pending",
    stageProgress: options.stageRuntime,
    approvalRequest: options.approvalRequest,
    evidenceManifestPath: join(options.runDir, "evidence", "manifest.json"),
  };
}

function acceptanceProtectedFiles(task: TaskSpec): string[] {
  const protectedFiles = new Set<string>();
  if (task.acceptance.custom?.script) protectedFiles.add(task.acceptance.custom.script);
  for (const step of task.acceptance.steps ?? []) {
    for (const candidate of [step.command, ...(step.args ?? [])]) {
      if (/\.(?:js|cjs|mjs|ts|cts|mts|sh|ps1)$/i.test(candidate)) {
        protectedFiles.add(candidate);
      }
    }
  }
  return [...protectedFiles];
}

function buildWorkspaceMetadata(
  task: TaskSpec,
  useWorktree: boolean,
  workDir: string,
  worktreeInfo: Awaited<ReturnType<typeof createRunWorktree>> | null,
): NonNullable<RunResult["workspace"]> {
  if (useWorktree && worktreeInfo) {
    return {
      path: worktreeInfo.worktreePath,
      baseCommit: worktreeInfo.baseCommit,
      originalRepoCleanBeforeApply: worktreeInfo.originalRepoCleanBeforeApply ?? true,
      mode: "isolated",
      repoPath: worktreeInfo.repoPath ?? task.repoPath,
      repoHead: worktreeInfo.repoHead ?? worktreeInfo.baseCommit,
      repoStatus: worktreeInfo.repoStatus ?? "",
      repoFingerprint: worktreeInfo.repoFingerprint,
      branchName: worktreeInfo.branchName,
      setupDurationMs: worktreeInfo.setupDurationMs,
      warmed: worktreeInfo.warmed,
    };
  }
  return {
    path: workDir,
    baseCommit: "",
    originalRepoCleanBeforeApply: false,
    mode: "direct",
    setupDurationMs: 0,
    warmed: false,
  };
}

function buildPatchMetadata(
  iterations: IterationRecord[],
  partial?: PartialIterationRecord,
): NonNullable<RunResult["patch"]> {
  const changedFiles = new Set(iterations.flatMap((iteration) => iteration.changedFiles));
  for (const file of partial?.changedFiles ?? []) changedFiles.add(file);
  return {
    filesChanged: changedFiles.size,
    linesAdded:
      iterations.reduce((sum, iteration) => sum + (iteration.linesAdded ?? 0), 0) +
      (partial?.linesAdded ?? 0),
    linesDeleted:
      iterations.reduce((sum, iteration) => sum + (iteration.linesDeleted ?? 0), 0) +
      (partial?.linesDeleted ?? 0),
  };
}

function toProviderErrorSummary(failure: DriverFailure): ProviderErrorSummary {
  return {
    category: failure.category ?? "unknown",
    statusCode: failure.statusCode,
    message: failure.message,
    retryable: failure.retryable,
  };
}

function buildIntegritySummary(
  findings: Array<{ iteration: number; violations: IntegrityViolation[] }>,
): RunResult["integritySummary"] {
  const violations = findings.flatMap((finding) => finding.violations);
  const criticalCount = violations.filter((violation) => violation.severity === "critical").length;
  const warningCount = violations.filter((violation) => violation.severity === "warning").length;
  return {
    status: violations.length > 0 ? "violations" : "ok",
    criticalCount,
    warningCount,
    issues: violations.map((violation) => ({
      rule: violation.rule,
      detail: violation.detail,
      severity: violation.severity,
    })),
  };
}

function appendPlanInstruction(instruction: string, plan: string): string {
  const marker = "## Implementation plan";
  if (instruction.includes(marker)) return instruction;
  return `${instruction.trim()}

${marker}
${plan.trim()}`;
}

function log(msg: string): void {
  emitLog(msg);
  // eslint-disable-next-line no-console
  console.log(msg);
}

function warn(msg: string): void {
  emitLog(msg);
  // eslint-disable-next-line no-console
  console.warn(msg);
}

function emitLog(message: string): void {
  const context = logContext.getStore();
  context?.events?.record({ type: "log", data: { message } });
  const onLog = context?.onLog;
  if (!onLog) return;
  try {
    onLog(message);
  } catch {
    // UI log sinks must never break the supervisor loop.
  }
}

function recordEvent(
  type: RunEventType,
  details: { iteration?: number; stageId?: string; data?: Record<string, unknown> } = {},
): void {
  logContext.getStore()?.events?.record({ type, ...details });
}

async function finalizeRunEvidence(
  runDir: string,
  _task: TaskSpec,
  _result: RunResult | undefined,
): Promise<void> {
  const taskFile = existsSync(join(runDir, "task.json")) ? "task.json" : "normalizedTask.json";
  const requiredFiles = [taskFile, "events.jsonl"];
  if (existsSync(join(runDir, "summary.json"))) requiredFiles.push("summary.json");
  const eventRecorder = logContext.getStore()?.events;
  await eventRecorder?.flush();
  await createEvidenceManifest(runDir, {
    model: getConfig().model,
    baseCommit: undefined,
    requiredFiles,
  });
}

function recordTerminalEvent(result: RunResult): void {
  const type: RunEventType =
    result.reason === "cancelled"
      ? "run_cancelled"
      : result.reason === "provider_error"
        ? "run_failed"
        : result.reason === "interrupted" || result.reason === "approval_required"
          ? "run_interrupted"
          : "run_completed";
  recordEvent(type, {
    data: {
      reason: result.reason,
      iterations: result.iterations.length,
      usageStatus: result.usageStatus ?? result.usage?.status ?? "unknown",
      totalCostUsd: result.usage?.costUsd ?? result.totalCostUsd,
      totalDurationMs: result.totalDurationMs,
      resumable: result.resumable ?? false,
      currentPhase: result.currentPhase,
      providerError: result.providerError
        ? {
            category: result.providerError.category,
            statusCode: result.providerError.statusCode,
            retryable: result.providerError.retryable,
          }
        : undefined,
    },
  });
}

async function runAndRecordHooks(
  task: TaskSpec,
  event: import("../types.js").LifecycleHookEvent,
  context: Record<string, unknown>,
  cwd: string,
): Promise<void> {
  const hooks = (task.hooks ?? []).filter((hook) => hook.event === event);
  if (hooks.length === 0) return;
  recordEvent("hook_started", { data: { event, count: hooks.length } });
  const results = await runLifecycleHooks(task, event, context, cwd);
  for (const result of results) {
    recordEvent(result.allowed ? "hook_completed" : "hook_failed", {
      data: { ...result },
    });
    if (!result.allowed && result.error) warn(`  ⚠ Hook ${result.script}: ${result.error}`);
  }
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new RunCancelledError(signal.reason === "app_shutdown" ? "interrupted" : "cancelled");
  }
}

function isPathInside(basePath: string, targetPath: string): boolean {
  const relativePath = relative(resolve(basePath), resolve(targetPath));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function isValidRunId(runId: string): boolean {
  return /^[a-zA-Z0-9\-_]{1,64}$/.test(runId);
}
