import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deriveRunLifecycle } from "./lifecycle.js";

let tempDir = "";

async function writeRun(
  runId: string,
  files: { summary?: Record<string, unknown>; state?: Record<string, unknown> },
): Promise<string> {
  const runDir = join(tempDir, runId);
  await mkdir(runDir, { recursive: true });
  if (files.summary) {
    await writeFile(join(runDir, "summary.json"), JSON.stringify(files.summary), "utf-8");
  }
  if (files.state) {
    await writeFile(join(runDir, "state.json"), JSON.stringify(files.state), "utf-8");
  }
  return runDir;
}

describe("deriveRunLifecycle", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "verdikt-lifecycle-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns missing for an empty run directory", async () => {
    const runDir = await writeRun("empty", {});
    const lifecycle = await deriveRunLifecycle(runDir);
    expect(lifecycle.status).toBe("missing");
    expect(lifecycle.resumable).toBe(false);
  });

  it("treats state-only runs as auto-resumable", async () => {
    const runDir = await writeRun("state-only", { state: { phase: "running" } });
    const lifecycle = await deriveRunLifecycle(runDir);
    expect(lifecycle.status).toBe("resumable");
    expect(lifecycle.autoResume).toBe(true);
  });

  it("keeps interrupted runs resumable even though a summary was written", async () => {
    const runDir = await writeRun("interrupted", {
      summary: { stopReason: "interrupted", resumable: true },
      state: { phase: "interrupted" },
    });
    const lifecycle = await deriveRunLifecycle(runDir);
    expect(lifecycle.status).toBe("resumable");
    expect(lifecycle.autoResume).toBe(true);
    expect(lifecycle.stopReason).toBe("interrupted");
  });

  it("keeps provider_error runs auto-resumable", async () => {
    const runDir = await writeRun("provider", {
      summary: { stopReason: "provider_error", resumable: true },
      state: { phase: "stopped" },
    });
    const lifecycle = await deriveRunLifecycle(runDir);
    expect(lifecycle.autoResume).toBe(true);
  });

  it("marks cancelled runs resumable but manual-only", async () => {
    const runDir = await writeRun("cancelled", {
      summary: { stopReason: "cancelled", resumable: true },
      state: { phase: "stopped" },
    });
    const lifecycle = await deriveRunLifecycle(runDir);
    expect(lifecycle.resumable).toBe(true);
    expect(lifecycle.autoResume).toBe(false);
  });

  it("treats discarded runs as terminal even when stale state remains", async () => {
    const runDir = await writeRun("discarded", {
      summary: { stopReason: "cancelled", applyStatus: "discarded", resumable: true },
      state: { phase: "stopped" },
    });
    const lifecycle = await deriveRunLifecycle(runDir);
    expect(lifecycle.status).toBe("terminal");
    expect(lifecycle.resumable).toBe(false);
    expect(lifecycle.autoResume).toBe(false);
  });

  it("marks error-phase runs resumable but manual-only", async () => {
    const runDir = await writeRun("errored", { state: { phase: "error" } });
    const lifecycle = await deriveRunLifecycle(runDir);
    expect(lifecycle.resumable).toBe(true);
    expect(lifecycle.autoResume).toBe(false);
  });

  it("reports waiting_approval without autoResume", async () => {
    const runDir = await writeRun("waiting", { state: { phase: "waiting_approval" } });
    const lifecycle = await deriveRunLifecycle(runDir);
    expect(lifecycle.status).toBe("waiting_approval");
    expect(lifecycle.autoResume).toBe(false);
  });

  it("treats summary-only runs as terminal", async () => {
    const runDir = await writeRun("done", { summary: { stopReason: "passed" } });
    const lifecycle = await deriveRunLifecycle(runDir);
    expect(lifecycle.status).toBe("terminal");
    expect(lifecycle.resumable).toBe(false);
    expect(lifecycle.stopReason).toBe("passed");
  });

  it("refuses isolated runs whose saved workspace is gone", async () => {
    const runDir = await writeRun("lost-workspace", {
      state: {
        phase: "interrupted",
        useWorktree: true,
        worktree: { worktreePath: join(tempDir, "missing-workspace") },
      },
    });
    const lifecycle = await deriveRunLifecycle(runDir);
    expect(lifecycle.resumable).toBe(false);
  });
});
