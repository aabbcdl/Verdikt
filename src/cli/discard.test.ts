import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfig, setConfig } from "../config.js";
import { verifyEvidenceManifest } from "../evidence/manifest.js";
import { discardSavedRun } from "./discard.js";

vi.mock("../workspace/worktree.js", () => ({
  discardRun: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../workspace/lock.js", () => ({
  releaseLock: vi.fn(),
}));

describe("discardSavedRun", () => {
  let tempDir: string;
  let stateDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = await mkdtemp(join(tmpdir(), "verdikt-discard-test-"));
    stateDir = join(tempDir, ".verdikt");
    await mkdir(stateDir, { recursive: true });
    setConfig({ stateDir });
  });

  afterEach(async () => {
    resetConfig();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("discards a saved run and records the discard status", async () => {
    const runId = "run-discard-001";
    const repoPath = join(tempDir, "repo");
    const runDir = join(stateDir, runId);
    await mkdir(join(runDir, "workspace"), { recursive: true });
    await mkdir(repoPath, { recursive: true });
    await mkdir(join(repoPath, ".git"), { recursive: true });
    await writeFile(
      join(runDir, "summary.json"),
      JSON.stringify({ stopReason: "passed", applyStatus: "pending" }, null, 2),
      "utf-8",
    );
    await writeFile(join(runDir, "state.json"), JSON.stringify({ phase: "stopped" }), "utf-8");
    await writeFile(join(runDir, "task.json"), JSON.stringify({ repoPath }, null, 2), "utf-8");

    const result = await discardSavedRun(runId);

    const { discardRun } = await import("../workspace/worktree.js");
    const { releaseLock } = await import("../workspace/lock.js");
    expect(discardRun).toHaveBeenCalledWith(
      repoPath,
      join(runDir, "workspace"),
      `verdikt/${runId}`,
    );
    expect(releaseLock).toHaveBeenCalledWith(stateDir, repoPath, runId);
    expect(result.discarded).toBe(true);
    const summary = JSON.parse(await readFile(join(runDir, "summary.json"), "utf-8"));
    expect(summary.applyStatus).toBe("discarded");
    expect(summary.discardedAt).toBeDefined();
    expect(existsSync(join(runDir, "state.json"))).toBe(false);
    expect((await verifyEvidenceManifest(runDir)).valid).toBe(true);
  });

  it("records discard status even when the saved workspace was already removed", async () => {
    const runId = "run-discard-no-workspace";
    const runDir = join(stateDir, runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "summary.json"),
      JSON.stringify({ stopReason: "passed", applyStatus: "pending" }, null, 2),
      "utf-8",
    );

    const result = await discardSavedRun(runId);

    const { discardRun } = await import("../workspace/worktree.js");
    const { releaseLock } = await import("../workspace/lock.js");
    expect(result.discarded).toBe(false);
    expect(discardRun).not.toHaveBeenCalled();
    expect(releaseLock).not.toHaveBeenCalled();
    const summary = JSON.parse(await readFile(join(runDir, "summary.json"), "utf-8"));
    expect(summary.applyStatus).toBe("discarded");
    expect(summary.discardedAt).toBeDefined();
  });

  it("refuses to discard a run that was already applied", async () => {
    const runId = "run-already-applied";
    const repoPath = join(tempDir, "repo");
    const runDir = join(stateDir, runId);
    await mkdir(join(runDir, "workspace"), { recursive: true });
    await mkdir(repoPath, { recursive: true });
    await mkdir(join(repoPath, ".git"), { recursive: true });
    await writeFile(
      join(runDir, "summary.json"),
      JSON.stringify({ stopReason: "passed", applyStatus: "applied" }, null, 2),
      "utf-8",
    );
    await writeFile(join(runDir, "task.json"), JSON.stringify({ repoPath }, null, 2), "utf-8");

    await expect(discardSavedRun(runId)).rejects.toThrow("already applied");

    const { discardRun } = await import("../workspace/worktree.js");
    const { releaseLock } = await import("../workspace/lock.js");
    expect(discardRun).not.toHaveBeenCalled();
    expect(releaseLock).not.toHaveBeenCalled();
    const summary = JSON.parse(await readFile(join(runDir, "summary.json"), "utf-8"));
    expect(summary.applyStatus).toBe("applied");
  });

  it("rejects run IDs that try to leave the state directory", async () => {
    await expect(discardSavedRun("../outside")).rejects.toThrow("Invalid run ID");
  });

  it("refuses to discard a workspace when the original repo path is missing", async () => {
    const runId = "run-missing-task";
    const runDir = join(stateDir, runId);
    await mkdir(join(runDir, "workspace"), { recursive: true });

    await expect(discardSavedRun(runId)).rejects.toThrow("task.json is missing");
  });

  it("refuses to discard when task.json has no repoPath", async () => {
    const runId = "run-missing-repo-path";
    const runDir = join(stateDir, runId);
    await mkdir(join(runDir, "workspace"), { recursive: true });
    await writeFile(join(runDir, "task.json"), JSON.stringify({}, null, 2), "utf-8");

    await expect(discardSavedRun(runId)).rejects.toThrow("repoPath is missing");

    const { discardRun } = await import("../workspace/worktree.js");
    const { releaseLock } = await import("../workspace/lock.js");
    expect(discardRun).not.toHaveBeenCalled();
    expect(releaseLock).not.toHaveBeenCalled();
  });
});
