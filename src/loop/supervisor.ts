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

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getConfig } from "../config.js";
import { runJudges } from "../judges/runJudges.js";
import { runExecutor } from "../roles/executor.js";
import { runVerifier } from "../roles/verifier.js";
import {
  clearRunState,
  createRunId,
  initRun,
  loadRunState,
  recordIteration,
  saveRunState,
  writeSummary,
} from "../trace/recorder.js";
import type { IterationRecord, RunResult, TaskSpec } from "../types.js";
import {
  type TestBaseline,
  captureTestBaseline,
  checkTestIntegrity,
} from "../workspace/integrity.js";
import { scanPatchRisk } from "../workspace/semantic-scanner.js";
import {
  applyFinalPatch,
  captureIterationDiff,
  checkpointIteration,
  createRunWorktree,
  discardRun,
  getFinalPatch,
  getHeadCommit,
} from "../workspace/worktree.js";
import { decideStop } from "./stopCondition.js";

export interface SupervisorOptions {
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
  const config = getConfig();
  const stateDir = config.stateDir;

  // M6: Resume support
  let runId: string;
  let runDir: string;
  let resumeState: Awaited<ReturnType<typeof loadRunState>> = null;
  let startIteration = 0;
  let activeTask = task;

  if (options.resumeFrom) {
    runDir = options.resumeFrom;
    resumeState = await loadRunState(runDir);
    if (!resumeState) {
      throw new Error(`Cannot resume: no state.json found in ${runDir}`);
    }
    runId = runDir.split(/[/\\]/).pop() ?? "unknown";
    startIteration = resumeState.nextIteration;
    activeTask = resumeState.task;
    log(`\n🔄 Resuming run ${runId} from iteration ${startIteration + 1}\n`);
  } else {
    runId = createRunId();
    runDir = await initRun(stateDir, runId);
    // Save task spec for apply/discard commands
    await writeFile(join(runDir, "task.json"), JSON.stringify(activeTask, null, 2));
  }

  // ── M2: Workspace isolation ────────────────────────────────────────────
  const useWorktree = !options.skipWorktree;
  const useIntegrity = !options.skipIntegrity;

  let workDir = activeTask.repoPath; // Default: work in the original repo
  let worktreeInfo: Awaited<ReturnType<typeof createRunWorktree>> | null = null;
  let baseline: TestBaseline | null = null;

  if (useWorktree) {
    log("  ▸ Creating isolated workspace...");
    worktreeInfo = await createRunWorktree(activeTask.repoPath, runDir, runId);
    workDir = worktreeInfo.worktreePath;
    log(`  ▸ Workspace: ${workDir}`);
    log(`  ▸ Base commit: ${worktreeInfo.baseCommit.slice(0, 8)}`);
  }

  if (useIntegrity) {
    log("  ▸ Capturing test baseline...");
    baseline = await captureTestBaseline(workDir);
    log(
      `  ▸ Baseline: ${baseline.fileHashes.size} test files, ${baseline.assertionCounts.size} assertion groups`,
    );
  }

  const iterations: IterationRecord[] = [];
  let instruction = resumeState?.instruction ?? activeTask.goal;
  let totalCost = resumeState?.totalCostUsd ?? 0;
  const integrityViolations: Array<{ iteration: number; violations: string[] }> = [];

  log(`\n${"═".repeat(60)}`);
  log(`Verdikt — Run ${runId}`);
  log(`Task: ${activeTask.id} — ${activeTask.goal}`);
  log(`Max iterations: ${activeTask.maxIterations} | State: ${runDir}`);
  log(`Workspace: ${useWorktree ? "isolated (git worktree)" : "direct"}`);
  log(`${"═".repeat(60)}\n`);

  const startTime = resumeState?.totalDurationMs
    ? Date.now() - resumeState.totalDurationMs
    : Date.now();

  try {
    for (let i = startIteration; i < activeTask.maxIterations; i++) {
      log(`── Iteration ${i + 1}/${activeTask.maxIterations} ──`);

      // M5.1: Record pre-executor HEAD so patch always captures executor's changes
      let preExecutorCommit: string | undefined;
      if (useWorktree && worktreeInfo) {
        preExecutorCommit = (await getHeadCommit(workDir)).trim();
      }

      // (1) Executor: make code changes in the worktree
      log("  ▸ Executor running...");
      const useStreaming = options.stream !== false;
      const execResult = await runExecutor(
        { ...task, repoPath: workDir },
        instruction,
        useStreaming
          ? {
              onChunk: (text) => {
                process.stdout.write(text);
              },
              onComplete: () => {
                process.stdout.write("\n");
              },
            }
          : undefined,
      );
      log(
        `  ▸ Executor done (${execResult.durationMs}ms${execResult.costUsd ? `, $${execResult.costUsd.toFixed(4)}` : ""})`,
      );

      if (execResult.costUsd) totalCost += execResult.costUsd;

      // Budget check after executor
      if (activeTask.maxBudgetUsd) {
        const pct = totalCost / activeTask.maxBudgetUsd;
        if (pct >= 1.0) {
          warn(
            `  💰 Budget exceeded: $${totalCost.toFixed(2)} / $${activeTask.maxBudgetUsd.toFixed(2)}`,
          );
        } else if (pct >= 0.8) {
          warn(
            `  💰 Budget warning: $${totalCost.toFixed(2)} / $${activeTask.maxBudgetUsd.toFixed(2)} (${(pct * 100).toFixed(0)}%)`,
          );
        }
      }

      // (2) Capture diff (against pre-executor HEAD) and checkpoint
      let changedFiles: string[] = [];
      let patchPath: string | undefined;
      let iterLinesAdded = 0;
      let iterLinesDeleted = 0;

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
        await checkpointIteration(workDir, i);
        log(
          `  ▸ Patch: ${patchPath} (${changedFiles.length} files, +${iterLinesAdded}/-${iterLinesDeleted})`,
        );
      } else {
        const { collectEvidence } = await import("../workspace/collectEvidence.js");
        changedFiles = await collectEvidence(workDir);
      }
      log(`  ▸ Changed files: ${changedFiles.length > 0 ? changedFiles.join(", ") : "(none)"}`);

      // (3) M2: Integrity check
      let integrityOk = true;
      if (useIntegrity && baseline) {
        const integrity = await checkTestIntegrity(workDir, baseline, activeTask.integrity ?? {});
        if (!integrity.passed) {
          integrityOk = false;
          const critViolations = integrity.violations.filter((v) => v.severity === "critical");
          integrityViolations.push({
            iteration: i,
            violations: critViolations.map((v) => `[${v.rule}] ${v.detail}`),
          });
          log(`  ⚠ INTEGRITY VIOLATION: ${critViolations.length} critical issue(s)`);
          for (const v of critViolations) {
            log(`    • ${v.rule}: ${v.detail}`);
          }
        } else {
          log("  ▸ Integrity: OK ✓");
        }
      }

      // (4) Judge: objective verification (run in worktree)
      log("  ▸ Judges running...");
      const judge = await runJudges(activeTask.acceptance, workDir);
      const passedCount = judge.checks.filter((c) => c.passed).length;
      log(`  ▸ Judges: ${passedCount}/${judge.checks.length} passed ${judge.passed ? "✅" : "❌"}`);

      // M4: Semantic risk gate check (after judge, before verifier)
      let semanticGateFailed = false;
      let semanticFindings: import("../workspace/semantic-scanner.js").SemanticRiskResult | null =
        null;
      if (activeTask.semantic?.maxRisk && useWorktree && worktreeInfo) {
        try {
          const { readFile } = await import("node:fs/promises");
          const patchPath = join(worktreeInfo.evidenceDir, `iteration-${i}.patch`);
          const patchContent = await readFile(patchPath, "utf-8");
          const { scanPatchRisk } = await import("../workspace/semantic-scanner.js");
          semanticFindings = scanPatchRisk(patchContent, changedFiles);

          const riskOrder = { none: 0, low: 1, medium: 2, high: 3 };
          const maxAllowed = riskOrder[activeTask.semantic.maxRisk];
          const actualRisk = riskOrder[semanticFindings.level];

          if (actualRisk > maxAllowed && judge.passed) {
            semanticGateFailed = true;
            log(
              `  ⚠ SEMANTIC GATE FAILED: risk=${semanticFindings.level}, max=${activeTask.semantic.maxRisk}`,
            );
            for (const f of semanticFindings.findings.slice(0, 3)) {
              log(`    • [${f.severity}] ${f.rule}: ${f.snippet}`);
            }
          } else if (judge.passed) {
            log(`  ▸ Semantic risk: ${semanticFindings.level} ≤ ${activeTask.semantic.maxRisk} ✓`);
          }
        } catch {
          // Patch read failed — don't block
        }
      }

      // If integrity failed AND judge passed, override: this is suspicious
      if (!integrityOk && judge.passed) {
        log("  ⚠ SUSPICIOUS: Judge passed but integrity violations detected");
        // Don't override judge.passed, but flag it in the record
      }

      // If semantic gate failed, override judge.passed for stop decision
      const effectiveJudge = semanticGateFailed
        ? {
            ...judge,
            passed: false,
            checks: [
              ...judge.checks,
              {
                name: "semantic-risk",
                passed: false,
                output: `Semantic risk ${semanticFindings?.level} exceeds max ${activeTask.semantic?.maxRisk}`,
                exitCode: 1,
                durationMs: 0,
              },
            ],
          }
        : judge;

      // (5) Verifier: interpret judge results, generate next instruction
      log("  ▸ Verifier running...");
      // Use effectiveJudge (may include semantic gate failure) so verifier sees it
      const verifierResult = await runVerifier(
        { ...task, repoPath: workDir },
        effectiveJudge,
        execResult.text,
      );
      const verdict = verifierResult.verdict;
      if (verifierResult.costUsd) totalCost += verifierResult.costUsd;
      log(
        `  ▸ Verifier: done=${verdict.done}, problems=${verdict.problems.length}${verifierResult.costUsd ? `, $${verifierResult.costUsd.toFixed(4)}` : ""}`,
      );

      // Budget check after verifier
      if (activeTask.maxBudgetUsd) {
        const pct = totalCost / activeTask.maxBudgetUsd;
        if (pct >= 1.0) {
          warn(
            `  💰 Budget exceeded: $${totalCost.toFixed(2)} / $${activeTask.maxBudgetUsd.toFixed(2)}`,
          );
        } else if (pct >= 0.8) {
          warn(
            `  💰 Budget warning: $${totalCost.toFixed(2)} / $${activeTask.maxBudgetUsd.toFixed(2)} (${(pct * 100).toFixed(0)}%)`,
          );
        }
      }
      if (verdict.problems.length > 0) {
        for (const p of verdict.problems) {
          log(`    • ${p}`);
        }
      }

      // (6) Record this iteration (M3: extended fields)
      const iterCost = (execResult.costUsd ?? 0) + (verifierResult.costUsd ?? 0);

      // Build integrity snapshot for this iteration
      let integritySnapshot: import("../types.js").IntegritySnapshot | undefined;
      if (useIntegrity && baseline) {
        const check = await checkTestIntegrity(workDir, baseline, activeTask.integrity ?? {});
        const crits = check.violations.filter((v) => v.severity === "critical");
        const warns = check.violations.filter((v) => v.severity === "warning");
        integritySnapshot = {
          status: crits.length > 0 ? "violations" : "ok",
          criticalCount: crits.length,
          warningCount: warns.length,
          issues: check.violations.map((v) => ({ rule: v.rule, detail: v.detail })),
        };
      }

      const record: IterationRecord = {
        index: i,
        executorOutput: execResult.text,
        changedFiles,
        judge: effectiveJudge,
        verifierVerdict: verdict,
        tokensUsed: undefined,
        costUsd: iterCost > 0 ? iterCost : undefined,
        durationMs: execResult.durationMs,
        // M3 fields
        patchPath: patchPath ?? undefined,
        integrity: integritySnapshot,
        judgeExitCode: judge.checks[0]?.exitCode,
        linesAdded: iterLinesAdded || undefined,
        linesDeleted: iterLinesDeleted || undefined,
      };
      iterations.push(record);
      await recordIteration(runDir, record);

      // M6: Save run state for resume capability
      await saveRunState(runDir, {
        task,
        instruction,
        nextIteration: i + 1,
        totalCostUsd: totalCost,
        totalDurationMs: Date.now() - startTime,
        lastSavedAt: new Date().toISOString(),
        useWorktree,
        useIntegrity,
      });

      // (7) Stop decision
      const decision = decideStop(iterations, task, totalCost);

      if (decision.stop) {
        const totalDurationMs = Date.now() - startTime;
        log(`\n${"═".repeat(60)}`);
        log(`STOP: ${decision.reason} after ${iterations.length} iteration(s)`);
        log(`Duration: ${(totalDurationMs / 1000).toFixed(1)}s | Cost: $${totalCost.toFixed(4)}`);
        log(`${"═".repeat(60)}\n`);

        // M3: Compute patch stats
        let finalPatchPath: string | undefined;
        const totalLinesAdded = 0;
        const totalLinesDeleted = 0;
        if (useWorktree && worktreeInfo) {
          finalPatchPath = join(worktreeInfo.evidenceDir, "final.patch");
        }

        const _applyStatus: "applied" | "discarded" | "pending" = "pending";

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

        const result: RunResult = {
          reason: decision.reason ?? "max_iterations",
          iterations,
          totalDurationMs,
          totalCostUsd: totalCost,
          // M3 fields
          runId,
          taskId: activeTask.id,
          workspace:
            useWorktree && worktreeInfo
              ? {
                  path: worktreeInfo.worktreePath,
                  baseCommit: worktreeInfo.baseCommit,
                  originalRepoCleanBeforeApply: true,
                  mode: "isolated",
                }
              : {
                  path: workDir,
                  baseCommit: "",
                  originalRepoCleanBeforeApply: false,
                  mode: "direct",
                },
          patch: {
            finalPatchPath,
            filesChanged: [...new Set(iterations.flatMap((it) => it.changedFiles))].length,
            linesAdded: totalLinesAdded,
            linesDeleted: totalLinesDeleted,
          },
          integritySummary:
            integrityViolations.length > 0
              ? {
                  status: "violations",
                  criticalCount: integrityViolations.reduce((s, v) => s + v.violations.length, 0),
                  warningCount: 0,
                  issues: integrityViolations.flatMap((v) =>
                    v.violations.map((d) => ({ rule: "violation", detail: d })),
                  ),
                }
              : { status: "ok", criticalCount: 0, warningCount: 0, issues: [] },
          applyStatus: "pending",
          semanticRisk: semanticRiskSummary,
        };
        await writeSummary(runDir, result);
        await clearRunState(runDir);

        // ── M2: Apply or discard based on outcome ─────────────────────
        if (decision.reason === "passed" && useWorktree && worktreeInfo) {
          if (options.autoApply) {
            log("  ▸ Auto-applying changes to original repo...");
            await applyFinalPatch(activeTask.repoPath, workDir, worktreeInfo.baseCommit);
            log("  ▸ Changes applied ✓");
            await discardRun(activeTask.repoPath, workDir, worktreeInfo.branchName);
            log("  ▸ Workspace cleaned up ✓");
          } else {
            // Save final patch for explicit apply
            const finalPatch = await getFinalPatch(workDir, worktreeInfo.baseCommit);
            const patchPath = join(worktreeInfo.evidenceDir, "final.patch");
            await writeFile(patchPath, finalPatch, "utf-8");
            log(`  ▸ Run passed. Patch saved: ${patchPath}`);
            log(`  ▸ To apply: verdikt apply ${runId}`);
            log(`  ▸ To discard: verdikt discard ${runId}`);
            // Keep worktree alive for explicit apply/discard
          }
        } else if (useWorktree && worktreeInfo) {
          log("  ▸ Discarding workspace (run did not pass)...");
          await discardRun(activeTask.repoPath, workDir, worktreeInfo.branchName);
          log("  ▸ Workspace discarded ✓");
        }

        if (integrityViolations.length > 0) {
          log("  ⚠ Integrity violations were detected during this run:");
          for (const iv of integrityViolations) {
            log(`    Iteration ${iv.iteration + 1}: ${iv.violations.join("; ")}`);
          }
        }

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
    };
    await writeSummary(runDir, result);
    await clearRunState(runDir);

    // Discard on max_iterations
    if (useWorktree && worktreeInfo) {
      await discardRun(activeTask.repoPath, workDir, worktreeInfo.branchName);
      log("  ▸ Workspace discarded (max iterations reached)");
    }

    return result;
  } catch (err) {
    // On any error, ensure we clean up the worktree
    if (useWorktree && worktreeInfo) {
      log("  ▸ Error occurred, discarding workspace...");
      try {
        await discardRun(activeTask.repoPath, workDir, worktreeInfo.branchName);
      } catch {
        // Best effort cleanup
      }
    }
    throw err;
  }
}

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(msg);
}

function warn(msg: string): void {
  // eslint-disable-next-line no-console
  console.warn(msg);
}
