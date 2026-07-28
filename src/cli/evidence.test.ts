import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetConfig, setConfig } from "../config.js";
import { createEvidenceManifest } from "../evidence/manifest.js";
import { verifyRunEvidence } from "./evidence.js";

describe("evidence CLI verification", () => {
  let tempDir: string;
  let stateDir: string;
  let runDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "verdikt-evidence-cli-"));
    stateDir = join(tempDir, ".verdikt");
    runDir = join(stateDir, "run-evidence-001");
    await mkdir(join(runDir, "evidence"), { recursive: true });
    await writeFile(join(runDir, "task.json"), JSON.stringify({ id: "task" }), "utf-8");
    await createEvidenceManifest(runDir);
    setConfig({ stateDir });
  });

  afterEach(async () => {
    resetConfig();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns a valid verification for unchanged evidence", async () => {
    expect((await verifyRunEvidence("run-evidence-001")).valid).toBe(true);
  });

  it("returns changed files after tampering", async () => {
    await writeFile(join(runDir, "task.json"), JSON.stringify({ id: "changed" }), "utf-8");
    const result = await verifyRunEvidence("run-evidence-001");
    expect(result.valid).toBe(false);
    expect(result.changed).toContain("task.json");
  });

  it("rejects paths outside the state directory", async () => {
    await expect(verifyRunEvidence("../outside")).rejects.toThrow("Invalid run ID");
  });
});
