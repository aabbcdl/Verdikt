import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanFileText, scanWorkspace } from "./scan.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "verdikt-security-scan-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("security scan", () => {
  it("flags obvious hard-coded secrets", () => {
    const fakeApiKey = `sk-${"1234567890abcdefghijklmnopqrstuvwxyz"}`;
    const fakePassword = "correct-horse-battery-staple";
    const findings = scanFileText(
      "src/config.ts",
      [`const apiKey = "${fakeApiKey}";`, `const password = "${fakePassword}";`].join("\n"),
    );

    expect(findings.map((finding) => finding.rule)).toEqual([
      "openai-style-api-key",
      "hard-coded-secret-assignment",
    ]);
  });

  it("flags private key blocks", () => {
    const findings = scanFileText(
      "keys/example.pem",
      [
        "-----BEGIN " + "PRIVATE KEY-----",
        "MIICeAIBADANBgkqhkiG9w0BAQEFAASCAmIwggJeAgEAAoGBANfakefakefake",
        "-----END " + "PRIVATE KEY-----",
      ].join("\n"),
    );

    expect(findings).toEqual([expect.objectContaining({ rule: "private-key-block", line: 1 })]);
  });

  it("ignores placeholders and dependency lockfile integrity strings", () => {
    const text = [
      'const apiKey = "your-api-key-here";',
      'const token = "example-token-for-docs";',
      "integrity: sha512-lb7XXXzmm2h2ASzFnRvQpDo6onT1NmMJA3tkGTWiBFtRJ9lxGY3d3mm/Apt36gej2bkkOVLL/yTOtufDaFa/jA==",
    ].join("\n");

    expect(scanFileText("pnpm-lock.yaml", text)).toEqual([]);
    expect(scanFileText("README.md", text)).toEqual([]);
  });

  it("scans workspace files while skipping generated directories", async () => {
    const fakeApiKey = `sk-${"1234567890abcdefghijklmnopqrstuvwxyz"}`;
    await mkdir(join(tempDir, "src"), { recursive: true });
    await mkdir(join(tempDir, "node_modules", "pkg"), { recursive: true });
    await writeFile(
      join(tempDir, "src", "leak.ts"),
      `export const apiKey = "${fakeApiKey}";\n`,
      "utf-8",
    );
    await writeFile(
      join(tempDir, "node_modules", "pkg", "index.js"),
      `const apiKey = "${fakeApiKey}";\n`,
      "utf-8",
    );

    const result = await scanWorkspace(tempDir);

    expect(result.passed).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      filePath: "src/leak.ts",
      rule: "openai-style-api-key",
    });
  });
});
