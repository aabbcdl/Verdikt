import { join } from "node:path";
import { readJsonFile, writeJsonAtomic } from "../trace/atomicJson.js";
import type { ApprovalRequest, RiskCategory } from "../types.js";

export interface ApprovalRecord extends ApprovalRequest {
  status: "pending" | "approved" | "rejected";
  requestedAt: string;
  decidedAt?: string;
  decidedBy?: string;
  decisionNote?: string;
}

export async function createApprovalRequest(
  runDir: string,
  request: ApprovalRequest,
): Promise<ApprovalRecord> {
  const existing = await readApprovalRecord(runDir);
  if (
    existing?.status === "approved" &&
    isApprovalSatisfied(existing, request.categories, request.stageId)
  ) {
    return existing;
  }
  const record: ApprovalRecord = {
    ...request,
    categories: [...new Set(request.categories)],
    status: "pending",
    requestedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(approvalPath(runDir), record, { backup: true });
  return record;
}

export async function readApprovalRecord(runDir: string): Promise<ApprovalRecord | null> {
  return readJsonFile<ApprovalRecord>(approvalPath(runDir));
}

export async function approveRequest(
  runDir: string,
  decidedBy = "user",
  note?: string,
): Promise<ApprovalRecord> {
  const record = await requireRecord(runDir);
  const approved: ApprovalRecord = {
    ...record,
    status: "approved",
    decidedAt: new Date().toISOString(),
    decidedBy,
    decisionNote: note,
  };
  await writeJsonAtomic(approvalPath(runDir), approved, { backup: true });
  return approved;
}

export async function rejectRequest(runDir: string, note?: string): Promise<ApprovalRecord> {
  const record = await requireRecord(runDir);
  const rejected: ApprovalRecord = {
    ...record,
    status: "rejected",
    decidedAt: new Date().toISOString(),
    decidedBy: "user",
    decisionNote: note,
  };
  await writeJsonAtomic(approvalPath(runDir), rejected, { backup: true });
  return rejected;
}

export function isApprovalSatisfied(
  record: ApprovalRecord | null,
  categories: RiskCategory[],
  stageId?: string,
): boolean {
  if (!record || record.status !== "approved") return false;
  if ((record.stageId ?? undefined) !== (stageId ?? undefined)) return false;
  const approved = new Set(record.categories);
  return categories.every((category) => approved.has(category));
}

async function requireRecord(runDir: string): Promise<ApprovalRecord> {
  const record = await readApprovalRecord(runDir);
  if (!record) throw new Error("No pending approval request found");
  return record;
}

function approvalPath(runDir: string): string {
  return join(runDir, "approval.json");
}
