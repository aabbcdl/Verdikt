import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type EvidenceVerification, verifyEvidenceManifest } from "../evidence/manifest.js";
import { isPathInside, isValidRunId } from "./localServer.js";
import { parseArgs } from "./parseArgs.js";

export async function verifyRunEvidence(runId: string): Promise<EvidenceVerification> {
  const config = (await import("../config.js")).getConfig();
  const stateDir = resolve(config.stateDir);
  const runDir = resolve(stateDir, runId);
  if (!isValidRunId(runId) || !isPathInside(stateDir, runDir)) {
    throw new Error("Invalid run ID");
  }
  if (!existsSync(runDir)) throw new Error(`Run not found: ${runId}`);
  return verifyEvidenceManifest(runDir);
}

export async function handleVerifyEvidence(args: string[]): Promise<void> {
  const { positional } = parseArgs(args, {
    positional: { min: 1, max: 1, names: ["run-id"] },
  });
  const runId = positional[0];
  const result = await verifyRunEvidence(runId);
  if (result.valid) {
    console.log(`Evidence for ${runId} is valid.`);
    return;
  }

  console.error(`Evidence for ${runId} failed verification.`);
  if (result.missing.length > 0) console.error(`Missing: ${result.missing.join(", ")}`);
  if (result.changed.length > 0) console.error(`Changed: ${result.changed.join(", ")}`);
  if (result.errors.length > 0) console.error(`Errors: ${result.errors.join("; ")}`);
  process.exitCode = 1;
}
