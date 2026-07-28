import { readFile, readdir } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export interface SecurityFinding {
  filePath: string;
  line: number;
  rule: string;
  message: string;
}

export interface SecurityScanResult {
  passed: boolean;
  scannedFiles: number;
  findings: SecurityFinding[];
}

const SKIPPED_DIRS = new Set([
  ".git",
  ".verdikt",
  "coverage",
  "dist",
  "node_modules",
  "out",
  ".vite",
]);

const SKIPPED_FILES = new Set(["package-lock.json", "pnpm-lock.yaml"]);
const SCANNED_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsonl",
  ".mjs",
  ".md",
  ".pem",
  ".ps1",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

const PLACEHOLDER_VALUES = [
  "change-me",
  "dummy",
  "example",
  "fake",
  "placeholder",
  "sample",
  "test",
  "your-",
];

const SECRET_ASSIGNMENT =
  /\b(api[_-]?key|secret|token|password)\b\s*[:=]\s*["']([^"'\r\n]{12,})["']/gi;

export function scanFileText(filePath: string, text: string): SecurityFinding[] {
  if (shouldSkipFile(filePath)) return [];

  const findings: SecurityFinding[] = [];
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const lineNumber = index + 1;

    if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(line)) {
      findings.push({
        filePath,
        line: lineNumber,
        rule: "private-key-block",
        message: "Private key material must not be committed.",
      });
    }

    const hasOpenAiStyleKey = /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{20,}\b/.test(line);
    if (hasOpenAiStyleKey) {
      findings.push({
        filePath,
        line: lineNumber,
        rule: "openai-style-api-key",
        message: "Looks like a hard-coded API key.",
      });
    }

    for (const match of line.matchAll(SECRET_ASSIGNMENT)) {
      const value = match[2];
      if (/\bsk-[A-Za-z0-9][A-Za-z0-9_-]{20,}\b/.test(value)) continue;
      if (isPlaceholderSecret(value)) continue;
      findings.push({
        filePath,
        line: lineNumber,
        rule: "hard-coded-secret-assignment",
        message: `Hard-coded ${match[1]} value must not be committed.`,
      });
    }
  }

  return findings;
}

export async function scanWorkspace(rootDir: string): Promise<SecurityScanResult> {
  const root = resolve(rootDir);
  const findings: SecurityFinding[] = [];
  let scannedFiles = 0;

  for await (const filePath of walkFiles(root)) {
    const relativePath = normalizePath(relative(root, filePath));
    if (shouldSkipFile(relativePath)) continue;

    const text = await readFile(filePath, "utf-8").catch(() => null);
    if (text === null) continue;

    scannedFiles += 1;
    findings.push(...scanFileText(relativePath, text));
  }

  return { passed: findings.length === 0, scannedFiles, findings };
}

export function formatSecurityScanResult(result: SecurityScanResult): string {
  const lines = [
    "",
    "Verdikt security scan",
    `Result: ${result.passed ? "passed" : "failed"}`,
    `Files scanned: ${result.scannedFiles}`,
  ];

  if (result.findings.length > 0) {
    lines.push("", "Findings:");
    for (const finding of result.findings) {
      lines.push(`- ${finding.filePath}:${finding.line} ${finding.rule} - ${finding.message}`);
    }
  }

  return lines.join("\n");
}

async function* walkFiles(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue;
      yield* walkFiles(fullPath);
      continue;
    }
    if (!entry.isFile()) continue;
    yield fullPath;
  }
}

function shouldSkipFile(filePath: string): boolean {
  const normalized = normalizePath(filePath);
  const parts = normalized.split("/");
  if (parts.some((part) => SKIPPED_DIRS.has(part))) return true;
  if (SKIPPED_FILES.has(parts.at(-1) ?? "")) return true;
  const extension = extname(normalized);
  return extension.length > 0 && !SCANNED_EXTENSIONS.has(extension);
}

function isPlaceholderSecret(value: string): boolean {
  const normalized = value.toLowerCase();
  return PLACEHOLDER_VALUES.some((placeholder) => normalized.includes(placeholder));
}

function normalizePath(filePath: string): string {
  return filePath.split(sep).join("/");
}

async function main(): Promise<void> {
  const result = await scanWorkspace(process.cwd());
  console.log(formatSecurityScanResult(result));
  if (!result.passed) {
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
