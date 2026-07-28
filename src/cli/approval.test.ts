import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { consumeActionGrant, requestActionApproval } from "../approval/actionStore.js";
import { createApprovalRequest, readApprovalRecord } from "../approval/store.js";
import { resetConfig, setConfig } from "../config.js";
import { verifyEvidenceManifest } from "../evidence/manifest.js";
import { decideRunApproval } from "./approval.js";

describe("approval CLI decisions", () => {
  let tempDir: string;
  let stateDir: string;
  let runDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "verdikt-approval-cli-"));
    stateDir = join(tempDir, ".verdikt");
    runDir = join(stateDir, "run-approval-001");
    await mkdir(join(runDir, "evidence"), { recursive: true });
    await writeFile(join(runDir, "task.json"), JSON.stringify({ id: "task" }), "utf-8");
    await writeFile(join(runDir, "state.json"), JSON.stringify({ task: { id: "task" } }), "utf-8");
    await createApprovalRequest(runDir, {
      categories: ["deployment"],
      reason: "Production release",
    });
    setConfig({ stateDir });
  });

  afterEach(async () => {
    resetConfig();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("approves a saved request and refreshes its evidence", async () => {
    const decision = await decideRunApproval("run-approval-001", "approve", "checked");

    expect(decision.record.status).toBe("approved");
    expect((await readApprovalRecord(runDir))?.decisionNote).toBe("checked");
    expect((await verifyEvidenceManifest(runDir)).valid).toBe(true);
  });

  it("rejects a saved request and refreshes its evidence", async () => {
    const decision = await decideRunApproval("run-approval-001", "reject", "unsafe");

    expect(decision.record.status).toBe("rejected");
    expect((await verifyEvidenceManifest(runDir)).valid).toBe(true);
  });

  it("approves a pending exact action before broad task approval", async () => {
    await requestActionApproval(runDir, {
      signature: "exact-1",
      command: "git push origin main",
      tool: "Bash",
      categories: ["external_write"],
      reason: "Exact external write",
    });

    const decision = await decideRunApproval("run-approval-001", "approve", "checked", "once");

    expect(decision.kind).toBe("action");
    expect(await consumeActionGrant(runDir, "exact-1")).toBe(true);
    expect(await consumeActionGrant(runDir, "exact-1")).toBe(false);
  });

  it("keeps an exact action approved for the rest of the run when requested", async () => {
    await requestActionApproval(runDir, {
      signature: "exact-run",
      command: "npm publish",
      tool: "Bash",
      categories: ["deployment", "external_write"],
      reason: "Publish package",
    });

    const decision = await decideRunApproval("run-approval-001", "approve", "checked", "run");

    expect(decision.kind).toBe("action");
    expect(await consumeActionGrant(runDir, "exact-run")).toBe(true);
    expect(await consumeActionGrant(runDir, "exact-run")).toBe(true);
  });

  it("rejects invalid run IDs", async () => {
    await expect(decideRunApproval("../outside", "approve")).rejects.toThrow("Invalid run ID");
  });
});
