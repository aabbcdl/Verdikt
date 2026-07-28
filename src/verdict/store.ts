import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { VerdictResult } from "./types.js";

export type VerdictReadResult =
  | { status: "ok"; verdict: VerdictResult }
  | { status: "missing" }
  | { status: "unsupported"; version: unknown }
  | { status: "invalid"; error: string };

export async function readVerdictResult(runDir: string): Promise<VerdictReadResult> {
  let raw: string;
  try {
    raw = await readFile(join(runDir, "verdict.json"), "utf-8");
  } catch (error) {
    if (isMissingFile(error)) return { status: "missing" };
    return { status: "invalid", error: "Verdict result could not be read" };
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { status: "invalid", error: "Verdict result is not valid JSON" };
  }

  const version = isRecord(value) ? value.version : undefined;
  if (version !== 1) return { status: "unsupported", version };
  if (!isVerdictResult(value)) {
    return { status: "invalid", error: "Verdict result does not match version 1" };
  }
  return { status: "ok", verdict: value };
}

export function isVerdictResult(value: unknown): value is VerdictResult {
  if (!isRecord(value) || value.version !== 1) return false;
  if (!["pass", "fail", "needs_review", "incomplete"].includes(String(value.status))) {
    return false;
  }
  if (!isRecord(value.run) || typeof value.run.runId !== "string") return false;
  if (!isRecord(value.summary) || typeof value.summary.title !== "string") return false;
  if (!Array.isArray(value.criteria) || !Array.isArray(value.evidence)) return false;
  if (!isRecord(value.scope) || !isRecord(value.integrity)) return false;
  if (!Array.isArray(value.findings) || !isRecord(value.provenance)) return false;
  return typeof value.createdAt === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
