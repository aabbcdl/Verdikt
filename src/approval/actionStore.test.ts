import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  approvePendingAction,
  consumeActionGrant,
  readActionApprovalState,
  rejectPendingAction,
  requestActionApproval,
} from "./actionStore.js";

describe("exact action approval store", () => {
  let runDir: string;
  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), "verdikt-action-approval-"));
  });
  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it("approves an exact action once and consumes the grant", async () => {
    await requestActionApproval(runDir, {
      signature: "sig-1",
      command: "git push origin main",
      tool: "Bash",
      categories: ["external_write"],
      reason: "External write",
    });
    await approvePendingAction(runDir, "once", "checked");

    expect(await consumeActionGrant(runDir, "sig-1")).toBe(true);
    expect(await consumeActionGrant(runDir, "sig-1")).toBe(false);
  });

  it("keeps a run-scoped grant available for repeated exact actions", async () => {
    await requestActionApproval(runDir, {
      signature: "sig-2",
      command: "npm publish",
      tool: "Bash",
      categories: ["deployment"],
      reason: "Publish",
    });
    await approvePendingAction(runDir, "run");
    expect(await consumeActionGrant(runDir, "sig-2")).toBe(true);
    expect(await consumeActionGrant(runDir, "sig-2")).toBe(true);
  });

  it("preserves a rejection for the supervisor to finalize safely", async () => {
    await requestActionApproval(runDir, {
      signature: "sig-3",
      command: "rm -rf dist",
      tool: "Bash",
      categories: ["destructive"],
      reason: "Destructive",
    });
    await rejectPendingAction(runDir, "unsafe");
    const state = await readActionApprovalState(runDir);
    expect(state.rejection?.signature).toBe("sig-3");
    expect(state.rejection?.decisionNote).toBe("unsafe");
  });

  it("deduplicates repeated requests for the same exact action", async () => {
    const first = await requestActionApproval(runDir, {
      signature: "sig-4",
      command: "git push",
      tool: "Bash",
      categories: ["external_write"],
      reason: "Push",
    });
    const second = await requestActionApproval(runDir, {
      signature: "sig-4",
      command: "git push",
      tool: "Bash",
      categories: ["external_write"],
      reason: "Push again",
    });
    expect(second.requestedAt).toBe(first.requestedAt);
  });
});
