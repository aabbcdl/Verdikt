import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isVerdictResult, readVerdictResult } from "./store.js";

function validVerdict(resultId?: string): Record<string, unknown> {
  return {
    version: 1,
    ...(resultId ? { resultId } : {}),
    run: {
      runId: "run-store-test",
      stopReason: "passed",
      totalDurationMs: 1,
      usageStatus: "complete",
    },
    status: "pass",
    summary: {
      title: "Accept",
      explanation: "All required checks passed",
      requiredPassed: 1,
      requiredTotal: 1,
    },
    recommendation: "accept_change",
    scope: {
      status: "skipped",
      expectedPaths: [],
      changedFiles: [],
      outOfScopeFiles: [],
      filesChanged: 0,
    },
    criteria: [
      {
        id: "test",
        name: "Tests",
        required: true,
        status: "pass",
        summary: "exit 0",
        evidenceIds: ["command:test"],
      },
    ],
    integrity: {
      status: "pass",
      testsModified: false,
      acceptanceWeakened: false,
      evidenceRecorded: true,
      criticalCount: 0,
      warningCount: 0,
      findings: [],
    },
    evidence: [
      {
        id: "command:test",
        kind: "test",
        source: "verified_execution",
        assurance: "verified",
        title: "Tests",
        summary: "exit 0",
      },
    ],
    findings: [],
    provenance: {},
    createdAt: "2026-08-01T00:00:00.000Z",
  };
}

describe("verdict store validation", () => {
  let runDir = "";

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), "verdikt-verdict-store-"));
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it("rejects a PASS without required evidence and criteria", () => {
    const malformed = validVerdict();
    malformed.criteria = [];
    malformed.evidence = [];
    expect(isVerdictResult(malformed)).toBe(false);
  });

  it("rejects dangling evidence references", () => {
    const malformed = validVerdict();
    (malformed.criteria as Array<Record<string, unknown>>)[0].evidenceIds = ["missing"];
    expect(isVerdictResult(malformed)).toBe(false);
  });

  it("rejects a summary and verdict written with different result IDs", async () => {
    await writeFile(join(runDir, "summary.json"), JSON.stringify({ resultId: "summary-id" }));
    await writeFile(join(runDir, "verdict.json"), JSON.stringify(validVerdict("verdict-id")));

    const result = await readVerdictResult(runDir);
    expect(result).toEqual({
      status: "invalid",
      error: "Summary and verdict results are from different writes",
    });
  });

  it("accepts a paired result with the same result ID", async () => {
    await writeFile(join(runDir, "summary.json"), JSON.stringify({ resultId: "shared-id" }));
    await writeFile(join(runDir, "verdict.json"), JSON.stringify(validVerdict("shared-id")));

    const result = await readVerdictResult(runDir);
    expect(result.status).toBe("ok");
  });
});
