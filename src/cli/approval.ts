import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type ActionApprovalDecision,
  approvePendingAction,
  readActionApprovalState,
  rejectPendingAction,
} from "../approval/actionStore.js";
import { type ApprovalRecord, approveRequest, rejectRequest } from "../approval/store.js";
import { refreshEvidenceManifest } from "../evidence/manifest.js";
import { resumeSupervisorLoop } from "../loop/supervisor.js";
import { isPathInside, isValidRunId } from "./localServer.js";
import { getFlag, parseArgs } from "./parseArgs.js";

export interface ApprovalDecisionResult {
  runId: string;
  runDir: string;
  kind: "task" | "action";
  record: ApprovalRecord | ActionApprovalDecision;
}

export async function decideRunApproval(
  runId: string,
  decision: "approve" | "reject",
  note?: string,
  scope: "once" | "run" = "once",
): Promise<ApprovalDecisionResult> {
  const config = (await import("../config.js")).getConfig();
  const stateDir = resolve(config.stateDir);
  const runDir = resolve(stateDir, runId);
  if (!isValidRunId(runId) || !isPathInside(stateDir, runDir)) {
    throw new Error("Invalid run ID");
  }
  if (!existsSync(join(runDir, "state.json"))) {
    throw new Error(`Run ${runId} has no resumable approval state.`);
  }

  const actionState = await readActionApprovalState(runDir);
  if (actionState.pending) {
    const record =
      decision === "approve"
        ? await approvePendingAction(runDir, scope, note)
        : await rejectPendingAction(runDir, note);
    await refreshEvidenceManifest(runDir);
    return { runId, runDir, kind: "action", record };
  }

  const record =
    decision === "approve"
      ? await approveRequest(runDir, "user", note)
      : await rejectRequest(runDir, note);
  await refreshEvidenceManifest(runDir);
  return { runId, runDir, kind: "task", record };
}

export async function handleApprove(args: string[]): Promise<void> {
  await handleDecision(args, "approve");
}

export async function handleReject(args: string[]): Promise<void> {
  await handleDecision(args, "reject");
}

async function handleDecision(args: string[], decision: "approve" | "reject"): Promise<void> {
  const parsed = parseArgs(args, {
    optional: ["note", "scope"],
    positional: { min: 1, max: 1, names: ["run-id"] },
  });
  const runId = parsed.positional[0];
  const note = getFlag(parsed, "note", "") || undefined;
  const scopeValue = getFlag(parsed, "scope", "once");
  if (scopeValue !== "once" && scopeValue !== "run") {
    throw new Error('Flag --scope must be either "once" or "run".');
  }
  const scope = scopeValue;
  const saved = await decideRunApproval(runId, decision, note, scope);
  console.log(`${decision === "approve" ? "Approved" : "Rejected"} run ${runId}.`);
  console.log("Continuing the saved run so the decision is completed safely...");

  const result = await resumeSupervisorLoop(saved.runDir, { stream: true });
  console.log(`Run ${runId} stopped with: ${result.reason}`);
  if (decision === "approve" && result.reason !== "passed") {
    process.exitCode = 1;
  }
}
