import { join } from "node:path";
import { readJsonFile, writeJsonAtomic } from "../trace/atomicJson.js";
import type { RiskCategory } from "../types.js";

export interface ActionApprovalRequest {
  signature: string;
  command: string;
  tool: string;
  categories: RiskCategory[];
  reason: string;
  cwd?: string;
  requestedAt: string;
}

export interface ActionApprovalDecision extends ActionApprovalRequest {
  status: "approved" | "rejected";
  scope?: "once" | "run";
  decidedAt: string;
  decisionNote?: string;
}

interface ActionGrant {
  signature: string;
  scope: "once" | "run";
  remainingUses?: number;
  approvedAt: string;
}

export interface ActionApprovalState {
  version: 1;
  pending?: ActionApprovalRequest;
  rejection?: ActionApprovalDecision;
  grants: ActionGrant[];
  history: ActionApprovalDecision[];
}

const stateQueues = new Map<string, Promise<unknown>>();

export async function readActionApprovalState(runDir: string): Promise<ActionApprovalState> {
  const loaded = await readJsonFile<ActionApprovalState>(statePath(runDir));
  if (!loaded || loaded.version !== 1) return emptyState();
  return {
    version: 1,
    pending: loaded.pending,
    rejection: loaded.rejection,
    grants: Array.isArray(loaded.grants) ? loaded.grants : [],
    history: Array.isArray(loaded.history) ? loaded.history : [],
  };
}

export async function requestActionApproval(
  runDir: string,
  request: Omit<ActionApprovalRequest, "requestedAt">,
): Promise<ActionApprovalRequest> {
  return updateState(runDir, async (state) => {
    if (state.pending?.signature === request.signature) return [state, state.pending];
    const pending: ActionApprovalRequest = {
      ...request,
      categories: [...new Set(request.categories)],
      requestedAt: new Date().toISOString(),
    };
    return [{ ...state, pending, rejection: undefined }, pending];
  });
}

export async function approvePendingAction(
  runDir: string,
  scope: "once" | "run" = "once",
  note?: string,
): Promise<ActionApprovalDecision> {
  return updateState(runDir, async (state) => {
    if (!state.pending) throw new Error("No pending exact action approval found");
    const decision: ActionApprovalDecision = {
      ...state.pending,
      status: "approved",
      scope,
      decidedAt: new Date().toISOString(),
      decisionNote: note,
    };
    const grants = state.grants.filter((grant) => grant.signature !== state.pending?.signature);
    grants.push({
      signature: state.pending.signature,
      scope,
      remainingUses: scope === "once" ? 1 : undefined,
      approvedAt: decision.decidedAt,
    });
    return [
      {
        ...state,
        pending: undefined,
        rejection: undefined,
        grants,
        history: [...state.history, decision].slice(-100),
      },
      decision,
    ];
  });
}

export async function rejectPendingAction(
  runDir: string,
  note?: string,
): Promise<ActionApprovalDecision> {
  return updateState(runDir, async (state) => {
    if (!state.pending) throw new Error("No pending exact action approval found");
    const decision: ActionApprovalDecision = {
      ...state.pending,
      status: "rejected",
      decidedAt: new Date().toISOString(),
      decisionNote: note,
    };
    return [
      {
        ...state,
        pending: undefined,
        rejection: decision,
        grants: state.grants.filter((grant) => grant.signature !== state.pending?.signature),
        history: [...state.history, decision].slice(-100),
      },
      decision,
    ];
  });
}

export async function consumeActionGrant(runDir: string, signature: string): Promise<boolean> {
  return updateState(runDir, async (state) => {
    const index = state.grants.findIndex((grant) => grant.signature === signature);
    if (index < 0) return [state, false];
    const grant = state.grants[index];
    if (grant.scope === "run") return [state, true];
    const remaining = grant.remainingUses ?? 0;
    if (remaining <= 0) return [state, false];
    const grants = [...state.grants];
    if (remaining === 1) grants.splice(index, 1);
    else grants[index] = { ...grant, remainingUses: remaining - 1 };
    return [{ ...state, grants }, true];
  });
}

export async function clearActionRejection(runDir: string): Promise<void> {
  await updateState(runDir, async (state) => [{ ...state, rejection: undefined }, undefined]);
}

async function updateState<T>(
  runDir: string,
  mutate: (state: ActionApprovalState) => Promise<[ActionApprovalState, T]>,
): Promise<T> {
  const path = statePath(runDir);
  const previous = stateQueues.get(path) ?? Promise.resolve();
  let result: T | undefined;
  const current = previous
    .catch(() => undefined)
    .then(async () => {
      const [next, value] = await mutate(await readActionApprovalState(runDir));
      await writeJsonAtomic(path, next, { backup: true });
      result = value;
    });
  stateQueues.set(path, current);
  try {
    await current;
  } finally {
    if (stateQueues.get(path) === current) stateQueues.delete(path);
  }
  return result as T;
}

function emptyState(): ActionApprovalState {
  return { version: 1, grants: [], history: [] };
}

function statePath(runDir: string): string {
  return join(runDir, "action-approvals.json");
}
