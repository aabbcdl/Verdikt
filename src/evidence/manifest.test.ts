import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEvidenceManifest, verifyEvidenceManifest } from "./manifest.js";

describe("evidence manifest", () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), "verdikt-evidence-"));
    await mkdir(join(runDir, "evidence"), { recursive: true });
    await writeFile(join(runDir, "task.json"), JSON.stringify({ id: "task-1" }), "utf-8");
    await writeFile(join(runDir, "iterations.jsonl"), '{"index":0}\n', "utf-8");
    await writeFile(join(runDir, "events.jsonl"), '{"type":"run_started"}\n', "utf-8");
    await writeFile(join(runDir, "action-approvals.json"), JSON.stringify({ version: 1 }), "utf-8");
    await writeFile(join(runDir, "notes.json"), JSON.stringify({ version: 1 }), "utf-8");
    await writeFile(join(runDir, "plan.md"), "# Plan\n", "utf-8");
    await mkdir(join(runDir, "checkpoints"), { recursive: true });
    await writeFile(
      join(runDir, "checkpoints", "iteration-0.json"),
      JSON.stringify({ version: 1, iteration: 0 }),
      "utf-8",
    );
    await writeFile(
      join(runDir, "summary.json"),
      JSON.stringify({ stopReason: "passed" }),
      "utf-8",
    );
    await writeFile(
      join(runDir, "verdict.json"),
      JSON.stringify({ version: 1, status: "pass" }),
      "utf-8",
    );
    await writeFile(join(runDir, "evidence", "final.patch"), "diff --git a/a b/a\n", "utf-8");
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it("creates a hashed inventory with environment and provenance", async () => {
    const manifest = await createEvidenceManifest(runDir, {
      model: "test-model",
      baseCommit: "abc123",
      verdiktVersion: "0.1.0-test",
    });

    expect(manifest.environment.node).toBe(process.version);
    expect(manifest.environment.platform).toBe(process.platform);
    expect(manifest.provenance.model).toBe("test-model");
    expect(manifest.provenance.baseCommit).toBe("abc123");
    expect(manifest.files.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        "task.json",
        "iterations.jsonl",
        "summary.json",
        "verdict.json",
        "events.jsonl",
        "action-approvals.json",
        "notes.json",
        "plan.md",
        "checkpoints/iteration-0.json",
        "evidence/final.patch",
      ]),
    );
    expect(manifest.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true);
    expect((await verifyEvidenceManifest(runDir)).valid).toBe(true);
  });

  it("remains valid after the manifest is refreshed repeatedly", async () => {
    await createEvidenceManifest(runDir, { model: "first" });
    await createEvidenceManifest(runDir, { model: "second" });
    await createEvidenceManifest(runDir, { model: "third" });

    const verification = await verifyEvidenceManifest(runDir);
    expect(verification.valid).toBe(true);
    const manifest = JSON.parse(
      await readFile(join(runDir, "evidence", "manifest.json"), "utf-8"),
    ) as { files: Array<{ path: string }> };
    expect(manifest.files.map((file) => file.path)).not.toContain("evidence/manifest.json.bak");
  });

  it("refuses to create a manifest when required evidence is missing", async () => {
    await rm(join(runDir, "events.jsonl"));

    await expect(
      createEvidenceManifest(runDir, { requiredFiles: ["task.json", "events.jsonl"] }),
    ).rejects.toThrow("Required evidence file is missing: events.jsonl");
  });

  it("detects changed and missing evidence", async () => {
    await createEvidenceManifest(runDir);
    await writeFile(join(runDir, "evidence", "final.patch"), "tampered", "utf-8");

    const changed = await verifyEvidenceManifest(runDir);
    expect(changed.valid).toBe(false);
    expect(changed.changed).toContain("evidence/final.patch");

    await rm(join(runDir, "summary.json"));
    const missing = await verifyEvidenceManifest(runDir);
    expect(missing.missing).toContain("summary.json");
  });
});
