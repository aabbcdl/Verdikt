/**
 * Tests for test integrity guard and anti-cheating detection.
 */

import { exec } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type TestBaseline, captureTestBaseline, checkTestIntegrity } from "./integrity.js";

const TEST_DIR = join(tmpdir(), `verdikt-test-${Date.now()}`);

async function execAsync(cmd: string, cwd: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    exec(cmd, { cwd, shell: process.platform === "win32" ? "powershell" : undefined }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/** Stage and commit all files so git ls-files can find them */
async function commitAll(): Promise<void> {
  await execAsync("git add -A", TEST_DIR);
  await execAsync('git commit -m "init" --allow-empty', TEST_DIR);
}

beforeEach(async () => {
  await mkdir(join(TEST_DIR, "test"), { recursive: true });
  await mkdir(join(TEST_DIR, "src"), { recursive: true });
  await execAsync("git init", TEST_DIR);
  await execAsync("git config user.email test@test.com", TEST_DIR);
  await execAsync("git config user.name test", TEST_DIR);
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

async function writeFileRel(path: string, content: string): Promise<void> {
  await writeFile(join(TEST_DIR, path), content, "utf-8");
}

// ── Baseline capture ─────────────────────────────────────────────────────────

describe("captureTestBaseline", () => {
  it("captures file hashes for test files", async () => {
    await writeFileRel("test/sum.test.ts", "expect(sum(1,2)).toBe(3);");
    await writeFileRel("package.json", JSON.stringify({ scripts: { test: "vitest run" } }));
    await commitAll();

    const baseline = await captureTestBaseline(TEST_DIR);

    expect(baseline.fileHashes.size).toBe(1);
    expect(baseline.fileHashes.has("test/sum.test.ts")).toBe(true);
    expect(baseline.assertionCounts.get("test/sum.test.ts")).toBe(1);
    expect(baseline.testScript).toBe("vitest run");
  });

  it("counts multiple assertions", async () => {
    await writeFileRel(
      "test/math.test.ts",
      ["expect(1+1).toBe(2);", "expect(2+2).toBe(4);", "expect(3+3).toBe(6);"].join("\n"),
    );
    await commitAll();

    const baseline = await captureTestBaseline(TEST_DIR);
    expect(baseline.assertionCounts.get("test/math.test.ts")).toBe(3);
  });

  it("captures config file hashes", async () => {
    await writeFileRel("vitest.config.ts", "export default { test: { globals: true } };");
    await writeFileRel("tsconfig.json", '{ "strict": true }');
    await commitAll();

    const baseline = await captureTestBaseline(TEST_DIR);

    expect(baseline.configHashes.has("vitest.config.ts")).toBe(true);
    expect(baseline.configHashes.has("tsconfig.json")).toBe(true);
  });
});

// ── Integrity check ──────────────────────────────────────────────────────────

describe("checkTestIntegrity", () => {
  it("passes when no test files are modified", async () => {
    await writeFileRel("test/sum.test.ts", "expect(sum(1,2)).toBe(3);");
    await commitAll();
    const baseline = await captureTestBaseline(TEST_DIR);

    const result = await checkTestIntegrity(TEST_DIR, baseline);

    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("detects deleted test files", async () => {
    await writeFileRel("test/sum.test.ts", "expect(sum(1,2)).toBe(3);");
    await commitAll();
    const baseline = await captureTestBaseline(TEST_DIR);

    // Delete the test file
    await rm(join(TEST_DIR, "test/sum.test.ts"));

    const result = await checkTestIntegrity(TEST_DIR, baseline);

    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.rule === "test-file-deleted")).toBe(true);
  });

  it("detects skipped tests", async () => {
    await writeFileRel("test/sum.test.ts", "it('test', () => { expect(1).toBe(1); });");
    await commitAll();
    const baseline = await captureTestBaseline(TEST_DIR);

    // Modify to add it.skip (baseline was different)
    await writeFileRel(
      "test/sum.test.ts",
      [
        "it('test', () => { expect(1).toBe(1); });",
        "it.skip('skipped', () => { expect(2).toBe(2); });",
      ].join("\n"),
    );

    const result = await checkTestIntegrity(TEST_DIR, baseline);

    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.rule === "test-skipped")).toBe(true);
  });

  it("detects focused tests", async () => {
    await writeFileRel("test/sum.test.ts", "it('test', () => { expect(1).toBe(1); });");
    await commitAll();
    const baseline = await captureTestBaseline(TEST_DIR);

    // Modify to add it.only
    await writeFileRel("test/sum.test.ts", "it.only('test', () => { expect(1).toBe(1); });");

    const result = await checkTestIntegrity(TEST_DIR, baseline);

    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.rule === "test-focused")).toBe(true);
  });

  it("detects decreased assertion count", async () => {
    await writeFileRel(
      "test/sum.test.ts",
      ["expect(1+1).toBe(2);", "expect(2+2).toBe(4);"].join("\n"),
    );
    await commitAll();
    const baseline = await captureTestBaseline(TEST_DIR);

    // Remove one assertion
    await writeFileRel("test/sum.test.ts", "expect(1+1).toBe(2);");

    const result = await checkTestIntegrity(TEST_DIR, baseline);

    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.rule === "assertions-decreased")).toBe(true);
  });

  it("detects commented-out assertions", async () => {
    await writeFileRel("test/sum.test.ts", "expect(1+1).toBe(2);");
    await commitAll();
    const baseline = await captureTestBaseline(TEST_DIR);

    // Comment out the assertion
    await writeFileRel("test/sum.test.ts", "// expect(1+1).toBe(2);");

    const result = await checkTestIntegrity(TEST_DIR, baseline);

    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.rule === "assertions-commented")).toBe(true);
  });

  it("detects modified test script in package.json", async () => {
    await writeFileRel("package.json", JSON.stringify({ scripts: { test: "vitest run" } }));
    await writeFileRel("test/sum.test.ts", "expect(1).toBe(1);");
    await commitAll();
    const baseline = await captureTestBaseline(TEST_DIR);

    // Weaken the test script
    await writeFileRel("package.json", JSON.stringify({ scripts: { test: "echo ok" } }));

    const result = await checkTestIntegrity(TEST_DIR, baseline);

    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.rule === "test-script-modified")).toBe(true);
  });

  it("detects modified config files", async () => {
    await writeFileRel("vitest.config.ts", "export default { test: { globals: true } };");
    await writeFileRel("test/sum.test.ts", "expect(1).toBe(1);");
    await commitAll();
    const baseline = await captureTestBaseline(TEST_DIR);

    // Modify config
    await writeFileRel("vitest.config.ts", "export default { test: { globals: false } };");

    const result = await checkTestIntegrity(TEST_DIR, baseline);

    expect(result.violations.some((v) => v.rule === "config-modified")).toBe(true);
  });
});
