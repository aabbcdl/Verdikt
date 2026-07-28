import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type RunEventType =
  | "run_started"
  | "run_resumed"
  | "run_completed"
  | "run_interrupted"
  | "run_failed"
  | "run_cancel_requested"
  | "run_cancelled"
  | "state_saved"
  | "log"
  | "iteration_started"
  | "executor_started"
  | "executor_output"
  | "executor_completed"
  | "executor_stalled"
  | "provider_error"
  | "phase_stalled"
  | "judges_started"
  | "judges_completed"
  | "verifier_started"
  | "verifier_completed"
  | "iteration_completed"
  | "approval_requested"
  | "approval_approved"
  | "approval_rejected"
  | "note_queued"
  | "note_consumed"
  | "plan_started"
  | "plan_completed"
  | "plan_approved"
  | "plan_rejected"
  | "review_started"
  | "review_output"
  | "review_stalled"
  | "review_completed"
  | "checkpoint_rewound"
  | "checkpoint_forked"
  | "patch_ready"
  | "patch_applied"
  | "patch_discarded"
  | "hook_started"
  | "hook_completed"
  | "hook_failed"
  | "workspace_ready";

export interface RunEventInput {
  type: RunEventType;
  runId: string;
  timestamp?: string;
  iteration?: number;
  stageId?: string;
  data?: Record<string, unknown>;
}

export interface RunEvent extends RunEventInput {
  id: string;
  timestamp: string;
  sequence: number;
}

export interface ReadRunEventsOptions {
  after?: number;
  limit?: number;
}

interface AppendState {
  tail: Promise<void>;
  sequence?: number;
}

const appendStates = new Map<string, AppendState>();

export async function appendRunEvent(runDir: string, input: RunEventInput): Promise<RunEvent> {
  const path = eventPath(runDir);
  const state = appendStates.get(path) ?? { tail: Promise.resolve() };
  appendStates.set(path, state);
  let appended: RunEvent | undefined;

  const current = state.tail
    .catch(() => undefined)
    .then(async () => {
      if (state.sequence === undefined) {
        state.sequence = (await readRunEvents(runDir)).length;
      }
      const sequence = state.sequence + 1;
      const event: RunEvent = {
        ...input,
        id: createEventId(),
        timestamp: input.timestamp ?? new Date().toISOString(),
        sequence,
      };
      await mkdir(dirname(path), { recursive: true });
      const { sequence: _sequence, ...stored } = event;
      await appendFile(path, `${JSON.stringify(stored)}\n`, "utf-8");
      state.sequence = sequence;
      appended = event;
    });
  state.tail = current;

  // The per-path state stays cached: dropping it after every append forced a
  // FULL re-read and re-parse of events.jsonl per event (O(n²) over a run's
  // lifetime) just to recompute the sequence counter. Entries are tiny and
  // bounded by the number of runs touched by this process.
  await current;

  if (!appended) throw new Error("Run event append did not complete");
  return appended;
}

export async function readRunEvents(
  runDir: string,
  options: ReadRunEventsOptions = {},
): Promise<RunEvent[]> {
  const raw = await readFile(eventPath(runDir), "utf-8").catch(() => "");
  const after = Math.max(0, options.after ?? 0);
  const limit = options.limit === undefined ? Number.POSITIVE_INFINITY : Math.max(0, options.limit);
  const events: RunEvent[] = [];
  let sequence = 0;

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Omit<RunEvent, "sequence">;
      if (!isStoredEvent(parsed)) continue;
      sequence += 1;
      if (sequence <= after) continue;
      events.push({ ...parsed, sequence });
      if (events.length >= limit) break;
    } catch {
      // Preserve all complete events if a process stopped during the final append.
    }
  }
  return events;
}

export class RunEventRecorder {
  private pending: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly runDir: string,
    private readonly runId: string,
  ) {}

  record(input: Omit<RunEventInput, "runId">): void {
    this.pending = this.pending
      .catch(() => undefined)
      .then(() => appendRunEvent(this.runDir, { ...input, runId: this.runId }));
  }

  async recordNow(input: Omit<RunEventInput, "runId">): Promise<RunEvent> {
    await this.flush();
    return appendRunEvent(this.runDir, { ...input, runId: this.runId });
  }

  async flush(): Promise<void> {
    await this.pending;
  }
}

export function eventPath(runDir: string): string {
  return join(runDir, "events.jsonl");
}

function isStoredEvent(value: unknown): value is Omit<RunEvent, "sequence"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.id === "string" &&
    typeof event.type === "string" &&
    typeof event.runId === "string" &&
    typeof event.timestamp === "string"
  );
}

function createEventId(): string {
  return `${Date.now().toString(36)}-${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
