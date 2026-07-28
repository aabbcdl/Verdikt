/**
 * Tests for test integrity guard and anti-cheating detection.
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type TestBaseline,
  captureTestBaseline,
  checkTestIntegrity,
  loadTestBaseline,
  saveTestBaseline,
} from "./integrity.js";

let testDir: string;

async function git(args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    execFile("git", args, { cwd: testDir, timeout: 60_000 }, (err, _stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve();
    });
  });
}

/** Stage and commit all files so git ls-files can find them */
async function commitAll(): Promise<void> {
  await git(["add", "-A"]);
  await git(["commit", "-m", "init", "--allow-empty", "--no-gpg-sign"]);
}

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "verdikt-integrity-"));
  await mkdir(join(testDir, "test"), { recursive: true });
  await mkdir(join(testDir, "src"), { recursive: true });
  await git(["init"]);
  await git(["config", "user.email", "test@test.com"]);
  await git(["config", "user.name", "test"]);
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

async function writeFileRel(path: string, content: string): Promise<void> {
  await writeFile(join(testDir, path), content, "utf-8");
}

// ── Baseline capture ─────────────────────────────────────────────────────────

describe("captureTestBaseline", () => {
  it("captures file hashes for test files", async () => {
    await writeFileRel("test/sum.test.ts", "expect(sum(1,2)).toBe(3);");
    await writeFileRel("package.json", JSON.stringify({ scripts: { test: "vitest run" } }));
    await commitAll();

    const baseline = await captureTestBaseline(testDir);

    expect(baseline.fileHashes.size).toBe(1);
    expect(baseline.fileHashes.has("test/sum.test.ts")).toBe(true);
    expect(baseline.assertionCounts.get("test/sum.test.ts")).toBe(1);
    expect(baseline.testScript).toBe("vitest run");
  });

  it("persists and reloads the complete integrity baseline", async () => {
    await writeFileRel("test/sum.test.ts", "expect(sum(1,2)).toBe(3);");
    await writeFileRel("judge.cjs", "module.exports = () => true;");
    await commitAll();
    const baseline = await captureTestBaseline(testDir, {
      protectedFiles: ["judge.cjs"],
      protectedGlobs: ["scripts/**"],
    });
    const runDir = join(testDir, ".verdikt", "run-1");

    await saveTestBaseline(runDir, baseline);
    const loaded = await loadTestBaseline(runDir);

    expect(loaded?.fileHashes).toEqual(baseline.fileHashes);
    expect(loaded?.protectedHashes).toEqual(baseline.protectedHashes);
    expect(loaded?.protectedGlobs).toEqual(["scripts/**"]);
  });

  it("counts multiple assertions", async () => {
    await writeFileRel(
      "test/math.test.ts",
      ["expect(1+1).toBe(2);", "expect(2+2).toBe(4);", "expect(3+3).toBe(6);"].join("\n"),
    );
    await commitAll();

    const baseline = await captureTestBaseline(testDir);
    expect(baseline.assertionCounts.get("test/math.test.ts")).toBe(3);
  });

  it("captures config file hashes", async () => {
    await writeFileRel("vitest.config.ts", "export default { test: { globals: true } };");
    await writeFileRel("tsconfig.json", '{ "strict": true }');
    await commitAll();

    const baseline = await captureTestBaseline(testDir);

    expect(baseline.configHashes.has("vitest.config.ts")).toBe(true);
    expect(baseline.configHashes.has("tsconfig.json")).toBe(true);
  });
});

// ── Integrity check ──────────────────────────────────────────────────────────

describe("checkTestIntegrity", () => {
  it("passes when no test files are modified", async () => {
    await writeFileRel("test/sum.test.ts", "expect(sum(1,2)).toBe(3);");
    await commitAll();
    const baseline = await captureTestBaseline(testDir);

    const result = await checkTestIntegrity(testDir, baseline);

    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("detects deleted test files", async () => {
    await writeFileRel("test/sum.test.ts", "expect(sum(1,2)).toBe(3);");
    await commitAll();
    const baseline = await captureTestBaseline(testDir);

    // Delete the test file
    await rm(join(testDir, "test/sum.test.ts"));

    const result = await checkTestIntegrity(testDir, baseline);

    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.rule === "test-file-deleted")).toBe(true);
  });

  it("detects skipped tests", async () => {
    await writeFileRel("test/sum.test.ts", "it('test', () => { expect(1).toBe(1); });");
    await commitAll();
    const baseline = await captureTestBaseline(testDir);

    // Modify to add it.skip (baseline was different)
    await writeFileRel(
      "test/sum.test.ts",
      [
        "it('test', () => { expect(1).toBe(1); });",
        "it.skip('skipped', () => { expect(2).toBe(2); });",
      ].join("\n"),
    );

    const result = await checkTestIntegrity(testDir, baseline);

    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.rule === "test-skipped")).toBe(true);
  });

  it("detects focused tests", async () => {
    await writeFileRel("test/sum.test.ts", "it('test', () => { expect(1).toBe(1); });");
    await commitAll();
    const baseline = await captureTestBaseline(testDir);

    // Modify to add it.only
    await writeFileRel("test/sum.test.ts", "it.only('test', () => { expect(1).toBe(1); });");

    const result = await checkTestIntegrity(testDir, baseline);

    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.rule === "test-focused")).toBe(true);
  });

  it("detects focused tests added in new test files", async () => {
    await writeFileRel("test/sum.test.ts", "it('test', () => { expect(1).toBe(1); });");
    await commitAll();
    const baseline = await captureTestBaseline(testDir);

    await writeFileRel(
      "test/new.test.ts",
      "test.only('new focused test', () => { expect(2).toBe(2); });",
    );

    const result = await checkTestIntegrity(testDir, baseline);

    expect(result.passed).toBe(false);
    expect(
      result.violations.some((v) => v.rule === "test-focused" && v.file === "test/new.test.ts"),
    ).toBe(true);
  });

  it("detects changed test expectations when test changes are not allowed", async () => {
    await writeFileRel("test/sum.test.ts", "expect(sum(1,2)).toBe(3);");
    await commitAll();
    const baseline = await captureTestBaseline(testDir);

    await writeFileRel("test/sum.test.ts", "expect(sum(1,2)).toBe(99);");

    const result = await checkTestIntegrity(testDir, baseline);

    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.rule === "test-file-modified")).toBe(true);
  });

  it("detects decreased assertion count", async () => {
    await writeFileRel(
      "test/sum.test.ts",
      ["expect(1+1).toBe(2);", "expect(2+2).toBe(4);"].join("\n"),
    );
    await commitAll();
    const baseline = await captureTestBaseline(testDir);

    // Remove one assertion
    await writeFileRel("test/sum.test.ts", "expect(1+1).toBe(2);");

    const result = await checkTestIntegrity(testDir, baseline);

    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.rule === "assertions-decreased")).toBe(true);
  });

  it("detects commented-out assertions", async () => {
    await writeFileRel("test/sum.test.ts", "expect(1+1).toBe(2);");
    await commitAll();
    const baseline = await captureTestBaseline(testDir);

    // Comment out the assertion
    await writeFileRel("test/sum.test.ts", "// expect(1+1).toBe(2);");

    const result = await checkTestIntegrity(testDir, baseline);

    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.rule === "assertions-commented")).toBe(true);
  });

  it("detects modified test script in package.json", async () => {
    await writeFileRel("package.json", JSON.stringify({ scripts: { test: "vitest run" } }));
    await writeFileRel("test/sum.test.ts", "expect(1).toBe(1);");
    await commitAll();
    const baseline = await captureTestBaseline(testDir);

    // Weaken the test script
    await writeFileRel("package.json", JSON.stringify({ scripts: { test: "echo ok" } }));

    const result = await checkTestIntegrity(testDir, baseline);

    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.rule === "test-script-modified")).toBe(true);
  });

  it("detects removed test script in package.json", async () => {
    await writeFileRel("package.json", JSON.stringify({ scripts: { test: "vitest run" } }));
    await writeFileRel("test/sum.test.ts", "expect(1).toBe(1);");
    await commitAll();
    const baseline = await captureTestBaseline(testDir);

    await writeFileRel("package.json", JSON.stringify({ scripts: {} }));

    const result = await checkTestIntegrity(testDir, baseline);

    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.rule === "test-script-modified")).toBe(true);
  });

  it("blocks changes to a custom judge protected by the baseline", async () => {
    await writeFileRel("judge.cjs", "module.exports = () => ({ passed: false });");
    await commitAll();
    const baseline = await captureTestBaseline(testDir, { protectedFiles: ["judge.cjs"] });

    await writeFileRel("judge.cjs", "module.exports = () => ({ passed: true });");
    const result = await checkTestIntegrity(testDir, baseline);

    expect(result.passed).toBe(false);
    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule: "protected-file-modified", file: "judge.cjs" }),
      ]),
    );
  });

  it("blocks files matched by protectedGlobs and warns for suspiciousGlobs", async () => {
    await mkdir(join(testDir, "scripts"), { recursive: true });
    await mkdir(join(testDir, "docs"), { recursive: true });
    await writeFileRel("scripts/check.cjs", "module.exports = true;");
    await writeFileRel("docs/note.md", "before");
    await commitAll();
    const baseline = await captureTestBaseline(testDir, {
      protectedGlobs: ["scripts/**"],
      suspiciousGlobs: ["docs/**"],
    });

    await writeFileRel("scripts/check.cjs", "module.exports = false;");
    await writeFileRel("docs/note.md", "after");
    const result = await checkTestIntegrity(testDir, baseline);

    expect(result.passed).toBe(false);
    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: "critical", rule: "protected-file-modified" }),
        expect.objectContaining({ severity: "warning", rule: "suspicious-file-modified" }),
      ]),
    );
  });

  it("detects modified config files", async () => {
    await writeFileRel("vitest.config.ts", "export default { test: { globals: true } };");
    await writeFileRel("test/sum.test.ts", "expect(1).toBe(1);");
    await commitAll();
    const baseline = await captureTestBaseline(testDir);

    // Modify config
    await writeFileRel("vitest.config.ts", "export default { test: { globals: false } };");

    const result = await checkTestIntegrity(testDir, baseline);

    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.rule === "config-modified")).toBe(true);
  });
});
