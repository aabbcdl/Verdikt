import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TaskSpec } from "../types.js";
import {
  createPersistCoalescer,
  emptyPersistedRunQueue,
  loadPersistedRunQueue,
  recoverPersistedRunQueue,
  savePersistedRunQueue,
  upsertPersistedRun,
} from "./persistentQueue.js";

const TASK: TaskSpec = {
  id: "queue-task",
  goal: "Fix the queue",
  repoPath: "/tmp/repo",
  acceptance: { steps: [{ id: "test", command: "node", args: ["--version"] }] },
  maxIterations: 2,
};

describe("persistent run queue", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "verdikt-persistent-queue-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("round-trips queued tasks through queue.json", async () => {
    let state = emptyPersistedRunQueue();
    state = upsertPersistedRun(state, {
      runId: "run-1",
      task: TASK,
      mode: "new",
      status: "queued",
      queuedAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z",
    });

    await savePersistedRunQueue(tempDir, state);
    const loaded = await loadPersistedRunQueue(tempDir);

    expect(loaded.order).toEqual(["run-1"]);
    expect(loaded.items["run-1"]?.task.goal).toBe("Fix the queue");
  });

  it("recovers an abandoned running task as an automatically queued resume", async () => {
    const runDir = join(tempDir, "run-2");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "state.json"), "{}", "utf-8");
    let state = emptyPersistedRunQueue();
    state = upsertPersistedRun(state, {
      runId: "run-2",
      task: TASK,
      mode: "new",
      status: "running",
      queuedAt: "2026-07-16T00:00:00.000Z",
      startedAt: "2026-07-16T00:01:00.000Z",
      heartbeatAt: "2026-07-16T00:02:00.000Z",
      updatedAt: "2026-07-16T00:02:00.000Z",
      ownerPid: 999_999,
    });

    const recovered = await recoverPersistedRunQueue(tempDir, state, {
      now: new Date("2026-07-16T02:00:00.000Z"),
      staleAfterMs: 60_000,
      isProcessAlive: () => false,
    });

    expect(recovered.activeRunId).toBeNull();
    expect(recovered.items["run-2"]?.status).toBe("queued");
    expect(recovered.items["run-2"]?.mode).toBe("resume");
    expect(recovered.items["run-2"]?.resumeRunDir).toBe(runDir);
    expect(recovered.items["run-2"]?.recoveryReason).toContain("restart");
    expect(recovered.order).toEqual(["run-2"]);
  });

  it("does not steal a fresh task whose owner process is still alive", async () => {
    let state = emptyPersistedRunQueue();
    state = upsertPersistedRun(state, {
      runId: "run-live",
      task: TASK,
      mode: "new",
      status: "running",
      queuedAt: "2026-07-16T00:00:00.000Z",
      heartbeatAt: "2026-07-16T00:09:30.000Z",
      updatedAt: "2026-07-16T00:09:30.000Z",
      ownerPid: 1234,
    });

    const recovered = await recoverPersistedRunQueue(tempDir, state, {
      now: new Date("2026-07-16T00:10:00.000Z"),
      staleAfterMs: 60_000,
      isProcessAlive: (pid) => pid === 1234,
    });

    expect(recovered.items["run-live"]?.status).toBe("running");
    expect(recovered.activeRunId).toBe("run-live");
    expect(recovered.order).toEqual([]);
  });

  it("re-queues an interrupted run even though it wrote a summary alongside its state", async () => {
    // Graceful shutdown writes BOTH summary.json (resumable: true) and
    // state.json. The old recovery treated "summary exists" as terminal and
    // silently dropped the documented restart auto-continue.
    const runDir = join(tempDir, "run-interrupted");
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "summary.json"),
      JSON.stringify({ stopReason: "interrupted", resumable: true }),
      "utf-8",
    );
    await writeFile(
      join(runDir, "state.json"),
      JSON.stringify({ phase: "interrupted", nextIteration: 1 }),
      "utf-8",
    );
    let state = emptyPersistedRunQueue();
    state = upsertPersistedRun(state, {
      runId: "run-interrupted",
      task: TASK,
      mode: "resume",
      status: "resumable",
      queuedAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:10:00.000Z",
      resumeRunDir: runDir,
    });

    const recovered = await recoverPersistedRunQueue(tempDir, state);

    expect(recovered.items["run-interrupted"]?.status).toBe("queued");
    expect(recovered.items["run-interrupted"]?.mode).toBe("resume");
    expect(recovered.items["run-interrupted"]?.resumeRunDir).toBe(runDir);
    expect(recovered.order).toEqual(["run-interrupted"]);
  });

  it("does not auto-resume a run the user explicitly cancelled", async () => {
    const runDir = join(tempDir, "run-cancelled");
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "summary.json"),
      JSON.stringify({ stopReason: "cancelled", resumable: true }),
      "utf-8",
    );
    await writeFile(
      join(runDir, "state.json"),
      JSON.stringify({ phase: "stopped", nextIteration: 1 }),
      "utf-8",
    );
    let state = emptyPersistedRunQueue();
    state = upsertPersistedRun(state, {
      runId: "run-cancelled",
      task: TASK,
      mode: "resume",
      status: "cancelled",
      queuedAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:10:00.000Z",
      resumeRunDir: runDir,
    });

    const recovered = await recoverPersistedRunQueue(tempDir, state);

    expect(recovered.items["run-cancelled"]?.status).toBe("cancelled");
    expect(recovered.items["run-cancelled"]?.resumeRunDir).toBe(runDir);
    expect(recovered.order).toEqual([]);
  });

  it("marks summary-only runs as terminal", async () => {
    const runDir = join(tempDir, "run-done");
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "summary.json"),
      JSON.stringify({ stopReason: "passed" }),
      "utf-8",
    );
    let state = emptyPersistedRunQueue();
    state = upsertPersistedRun(state, {
      runId: "run-done",
      task: TASK,
      mode: "new",
      status: "running",
      queuedAt: "2026-07-16T00:00:00.000Z",
      heartbeatAt: "2026-07-16T00:00:30.000Z",
      updatedAt: "2026-07-16T00:00:30.000Z",
      ownerPid: 999_999,
    });

    const recovered = await recoverPersistedRunQueue(tempDir, state, {
      now: new Date("2026-07-16T02:00:00.000Z"),
      staleAfterMs: 60_000,
      isProcessAlive: () => false,
    });

    expect(recovered.items["run-done"]?.status).toBe("completed");
    expect(recovered.order).toEqual([]);
  });

  it("coalesces persist bursts into one in-flight write plus one trailing write", async () => {
    let writes = 0;
    let releaseFirstWrite: () => void = () => undefined;
    const firstWriteGate = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const persist = createPersistCoalescer(async () => {
      writes += 1;
      if (writes === 1) await firstWriteGate;
    });

    const first = persist();
    const burst = [persist(), persist(), persist(), persist()];
    expect(writes).toBe(1);

    releaseFirstWrite();
    await Promise.all([first, ...burst]);

    // Four requests during the in-flight write collapse into one trailing write.
    expect(writes).toBe(2);

    await persist();
    expect(writes).toBe(3);
  });

  it("keeps approval waits durable across restarts", async () => {
    let state = emptyPersistedRunQueue();
    state = upsertPersistedRun(state, {
      runId: "run-approval",
      task: TASK,
      mode: "resume",
      status: "waiting_approval",
      queuedAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:10:00.000Z",
      approvalRequest: { categories: ["deployment"], reason: "Production deployment" },
    });

    const recovered = await recoverPersistedRunQueue(tempDir, state);

    expect(recovered.items["run-approval"]?.status).toBe("waiting_approval");
    expect(recovered.order).toEqual([]);
  });
});
