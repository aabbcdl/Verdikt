import { join, resolve } from "node:path";
import { readJsonFile, writeJsonAtomic } from "../trace/atomicJson.js";
import { deriveRunLifecycle } from "../trace/lifecycle.js";
import type { ApprovalAction, RiskCategory, TaskSpec } from "../types.js";

export type PersistedRunStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "cancelling"
  | "resumable"
  | "cancelled"
  | "completed"
  | "error";

export interface PersistedApprovalRequest {
  categories: RiskCategory[];
  reason: string;
  stageId?: string;
  action?: ApprovalAction;
}

export interface PersistedRunItem {
  runId: string;
  task: TaskSpec;
  mode: "new" | "resume";
  status: PersistedRunStatus;
  queuedAt: string;
  updatedAt: string;
  startedAt?: string;
  heartbeatAt?: string;
  ownerPid?: number;
  resumeRunDir?: string;
  currentStageId?: string;
  currentAction?: string;
  lastLog?: string;
  recoveryReason?: string;
  approvalRequest?: PersistedApprovalRequest;
  error?: string;
}

export interface PersistedRunQueueState {
  version: 1;
  activeRunId: string | null;
  order: string[];
  items: Record<string, PersistedRunItem>;
  updatedAt: string;
}

export interface RecoverQueueOptions {
  now?: Date;
  staleAfterMs?: number;
  isProcessAlive?: (pid: number) => boolean;
}

const DEFAULT_STALE_AFTER_MS = 2 * 60_000;

export function emptyPersistedRunQueue(now = new Date()): PersistedRunQueueState {
  return {
    version: 1,
    activeRunId: null,
    order: [],
    items: {},
    updatedAt: now.toISOString(),
  };
}

export async function loadPersistedRunQueue(stateDir: string): Promise<PersistedRunQueueState> {
  const loaded = await readJsonFile<PersistedRunQueueState>(queuePath(stateDir));
  if (!loaded || loaded.version !== 1 || !loaded.items || !Array.isArray(loaded.order)) {
    return emptyPersistedRunQueue();
  }
  return {
    ...loaded,
    activeRunId: typeof loaded.activeRunId === "string" ? loaded.activeRunId : null,
    order: loaded.order.filter((runId) => typeof runId === "string" && loaded.items[runId]),
  };
}

export async function savePersistedRunQueue(
  stateDir: string,
  state: PersistedRunQueueState,
): Promise<void> {
  await writeJsonAtomic(
    queuePath(stateDir),
    { ...state, updatedAt: new Date().toISOString() },
    { backup: true },
  );
}

export function upsertPersistedRun(
  state: PersistedRunQueueState,
  item: PersistedRunItem,
): PersistedRunQueueState {
  const order = state.order.filter((runId) => runId !== item.runId);
  if (item.status === "queued") order.push(item.runId);
  const activeRunId =
    item.status === "running"
      ? item.runId
      : state.activeRunId === item.runId
        ? null
        : state.activeRunId;
  return {
    ...state,
    activeRunId,
    order,
    items: { ...state.items, [item.runId]: item },
    updatedAt: new Date().toISOString(),
  };
}

export function removePersistedRun(
  state: PersistedRunQueueState,
  runId: string,
): PersistedRunQueueState {
  const items = { ...state.items };
  delete items[runId];
  return {
    ...state,
    activeRunId: state.activeRunId === runId ? null : state.activeRunId,
    order: state.order.filter((id) => id !== runId),
    items,
    updatedAt: new Date().toISOString(),
  };
}

export async function recoverPersistedRunQueue(
  stateDir: string,
  state: PersistedRunQueueState,
  options: RecoverQueueOptions = {},
): Promise<PersistedRunQueueState> {
  const now = options.now ?? new Date();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  let recovered = emptyPersistedRunQueue(now);

  for (const item of Object.values(state.items)) {
    const runDir = join(resolve(stateDir), item.runId);
    const lifecycle = await deriveRunLifecycle(runDir);

    // Another live process still owns this run — leave it untouched.
    if (item.status === "running" || item.status === "cancelling") {
      const heartbeat = Date.parse(item.heartbeatAt ?? item.updatedAt);
      const heartbeatFresh = Number.isFinite(heartbeat) && now.getTime() - heartbeat < staleAfterMs;
      const ownerAlive = typeof item.ownerPid === "number" && isProcessAlive(item.ownerPid);
      if (heartbeatFresh && ownerAlive) {
        recovered = upsertPersistedRun(recovered, item);
        continue;
      }
    }

    // state.phase stays "waiting_approval" until the resumed run rewrites it,
    // so an approved-and-queued continuation (item.status "queued") must not
    // be flipped back to waiting here.
    if (lifecycle.status === "waiting_approval" && item.status !== "queued") {
      recovered = upsertPersistedRun(recovered, { ...item, status: "waiting_approval" });
      continue;
    }

    if (lifecycle.resumable) {
      // A summary may exist alongside state (interrupted / provider_error
      // runs write both) — state is what decides resumability. An item the
      // user already queued (approved continuation, manual resume) carries
      // explicit intent and is re-queued even when autoResume is false.
      if (lifecycle.autoResume || item.status === "queued") {
        recovered = upsertPersistedRun(recovered, {
          ...item,
          status: "queued",
          mode: "resume",
          resumeRunDir: runDir,
          ownerPid: undefined,
          heartbeatAt: undefined,
          recoveryReason: "Recovered after app restart from saved state",
          updatedAt: now.toISOString(),
        });
      } else {
        // Explicit user cancellation or an unexplained error: keep the saved
        // workspace for a MANUAL continue, never re-queue on our own.
        recovered = upsertPersistedRun(recovered, {
          ...item,
          status: lifecycle.stopReason === "cancelled" ? "cancelled" : "error",
          mode: "resume",
          resumeRunDir: runDir,
          ownerPid: undefined,
          heartbeatAt: undefined,
          updatedAt: now.toISOString(),
        });
      }
      continue;
    }

    if (lifecycle.hasSummary) {
      recovered = upsertPersistedRun(recovered, {
        ...item,
        status:
          item.status === "cancelled" || lifecycle.stopReason === "cancelled"
            ? "cancelled"
            : "completed",
        updatedAt: now.toISOString(),
      });
      continue;
    }

    if (item.status === "queued" || item.status === "running" || item.status === "cancelling") {
      // Never started (or died before any state was saved) — run it fresh.
      recovered = upsertPersistedRun(recovered, {
        ...item,
        status: "queued",
        mode: "new",
        resumeRunDir: undefined,
        ownerPid: undefined,
        heartbeatAt: undefined,
        recoveryReason: "Recovered queued task after app restart",
        updatedAt: now.toISOString(),
      });
      continue;
    }

    recovered = upsertPersistedRun(recovered, item);
  }

  return recovered;
}

/**
 * Collapse bursts of persist requests into at most one in-flight write plus
 * one queued trailing write. The snapshot is built at write time, so the
 * trailing write always captures the latest state, and every caller's promise
 * resolves only after a write that includes its change. Without this, every
 * supervisor log line and heartbeat rewrote the entire queue.json.
 */
export function createPersistCoalescer(write: () => Promise<void>): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  let queued: Promise<void> | null = null;

  const run = (): Promise<void> => {
    const attempt = write().finally(() => {
      if (inFlight === attempt) inFlight = null;
    });
    inFlight = attempt;
    return attempt;
  };

  return () => {
    if (!inFlight) return run();
    if (!queued) {
      queued = inFlight
        .catch(() => undefined)
        .then(() => {
          queued = null;
          return run();
        });
    }
    return queued;
  };
}

function queuePath(stateDir: string): string {
  return join(resolve(stateDir), "queue.json");
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
