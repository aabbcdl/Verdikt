import type {
  JudgeResult,
  StageRuntimeState,
  TaskSpec,
  TaskStage,
  VerifierVerdict,
} from "../types.js";

export function createStageRuntime(task: TaskSpec): StageRuntimeState {
  return {
    stageIndex: task.stages && task.stages.length > 0 ? 0 : -1,
    stageIteration: 0,
    stageCostUsd: 0,
    completedStageIds: [],
  };
}

export function getActiveStage(task: TaskSpec, runtime: StageRuntimeState): TaskStage | null {
  if (!task.stages || runtime.stageIndex < 0) return null;
  return task.stages[runtime.stageIndex] ?? null;
}

export function isFinalStage(task: TaskSpec, runtime: StageRuntimeState): boolean {
  return Boolean(task.stages?.length) && runtime.stageIndex === (task.stages?.length ?? 0) - 1;
}

export function stageRequiresJudgePass(task: TaskSpec, runtime: StageRuntimeState): boolean {
  const stage = getActiveStage(task, runtime);
  if (!stage) return true;
  return Boolean(stage.acceptance) || isFinalStage(task, runtime);
}

export function isStageComplete(options: {
  task: TaskSpec;
  runtime: StageRuntimeState;
  judge: JudgeResult;
  verdict: VerifierVerdict;
}): boolean {
  const { task, runtime, judge, verdict } = options;
  if (!verdict.done || verdict.problems.length > 0) return false;
  return stageRequiresJudgePass(task, runtime) ? judge.passed : true;
}

export function advanceStage(task: TaskSpec, runtime: StageRuntimeState): StageRuntimeState {
  const active = getActiveStage(task, runtime);
  if (!active) return runtime;
  return {
    stageIndex: Math.min(runtime.stageIndex + 1, task.stages?.length ?? runtime.stageIndex + 1),
    stageIteration: 0,
    stageCostUsd: 0,
    completedStageIds: [...new Set([...runtime.completedStageIds, active.id])],
  };
}

export function recordStageAttempt(runtime: StageRuntimeState, costUsd: number): StageRuntimeState {
  if (runtime.stageIndex < 0) return runtime;
  return {
    ...runtime,
    stageIteration: runtime.stageIteration + 1,
    stageCostUsd: runtime.stageCostUsd + costUsd,
  };
}

export function stageLimitFailure(task: TaskSpec, runtime: StageRuntimeState): string | null {
  const stage = getActiveStage(task, runtime);
  if (!stage) return null;
  if (stage.maxIterations != null && runtime.stageIteration >= stage.maxIterations) {
    return `Stage ${stage.id} reached its iteration limit (${stage.maxIterations})`;
  }
  if (stage.maxBudgetUsd != null && runtime.stageCostUsd >= stage.maxBudgetUsd) {
    return `Stage ${stage.id} reached its cost stop target ($${stage.maxBudgetUsd})`;
  }
  return null;
}
