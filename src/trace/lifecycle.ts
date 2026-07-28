/**
 * Single source of truth for a run's lifecycle status.
 *
 * Historical bug class this module exists to prevent: "is this run
 * resumable?" was answered in four places with two contradictory rules.
 * Interrupted and provider_error runs write BOTH summary.json (with
 * `resumable: true`) and state.json; treating "summary exists" as terminal
 * silently disabled the documented restart auto-continue.
 *
 * Canonical rule:
 * - state.json exists and validates → the run is resumable, whether or not a
 *   summary was written.
 * - summary.json without state → terminal.
 * - `autoResume` additionally answers "is it safe to re-queue WITHOUT the
 *   user asking": explicit user cancellation and unexplained errors are
 *   manual-only; interruption and provider failures continue automatically.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { readJsonFile } from "./atomicJson.js";
import { type RunState, validateResumeState } from "./recorder.js";

export interface RunLifecycle {
  status: "missing" | "resumable" | "waiting_approval" | "terminal";
  resumable: boolean;
  /** Safe to re-queue automatically after an app restart. */
  autoResume: boolean;
  stopReason?: string;
  hasSummary: boolean;
  state: RunState | null;
}

export async function deriveRunLifecycle(runDir: string): Promise<RunLifecycle> {
  const root = resolve(runDir);
  const hasSummary = existsSync(join(root, "summary.json"));
  const summary = hasSummary
    ? await readJsonFile<Record<string, unknown>>(join(root, "summary.json"))
    : null;
  const stopReason = readSummaryStopReason(summary);
  const applyStatus = typeof summary?.applyStatus === "string" ? summary.applyStatus : undefined;
  const state = await readJsonFile<RunState>(join(root, "state.json"));

  if (applyStatus === "applied" || applyStatus === "discarded") {
    return {
      status: "terminal",
      resumable: false,
      autoResume: false,
      stopReason,
      hasSummary,
      state: null,
    };
  }

  if (!state || !(await validateResumeState(root, state)).valid) {
    return {
      status: hasSummary ? "terminal" : "missing",
      resumable: false,
      autoResume: false,
      stopReason,
      hasSummary,
      state: null,
    };
  }

  if (state.phase === "waiting_approval") {
    return {
      status: "waiting_approval",
      resumable: true,
      autoResume: false,
      stopReason,
      hasSummary,
      state,
    };
  }

  const manualOnly = stopReason === "cancelled" || state.phase === "error";
  return {
    status: "resumable",
    resumable: true,
    autoResume: !manualOnly,
    stopReason,
    hasSummary,
    state,
  };
}

function readSummaryStopReason(summary: Record<string, unknown> | null): string | undefined {
  const reason = summary?.stopReason ?? summary?.status;
  return typeof reason === "string" && reason.trim() ? reason : undefined;
}
