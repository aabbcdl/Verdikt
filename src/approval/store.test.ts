import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  approveRequest,
  createApprovalRequest,
  isApprovalSatisfied,
  readApprovalRecord,
  rejectRequest,
} from "./store.js";

describe("approval store", () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), "verdikt-approval-"));
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it("persists a pending request and an approval decision", async () => {
    await createApprovalRequest(runDir, {
      categories: ["deployment", "production"],
      reason: "Production deployment",
      stageId: "release",
    });
    expect((await readApprovalRecord(runDir))?.status).toBe("pending");

    await approveRequest(runDir, "user");
    const record = await readApprovalRecord(runDir);
    expect(record?.status).toBe("approved");
    expect(record?.decidedBy).toBe("user");
    expect(isApprovalSatisfied(record, ["deployment", "production"], "release")).toBe(true);
  });

  it("records rejection and does not satisfy the request", async () => {
    await createApprovalRequest(runDir, { categories: ["database"], reason: "Migration" });
    await rejectRequest(runDir, "unsafe");
    const record = await readApprovalRecord(runDir);
    expect(record?.status).toBe("rejected");
    expect(record?.decisionNote).toBe("unsafe");
    expect(isApprovalSatisfied(record, ["database"])).toBe(false);
  });
});
