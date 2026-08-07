import { execFileSync } from "node:child_process";

const ALLOWED_PACKAGE_FILES = new Set([
  ".env.example",
  "DESIGN.md",
  "PRODUCT.md",
  "README.md",
  "USAGE_GUIDE.md",
  "package.json",
]);

const ALLOWED_PACKAGE_PREFIXES = ["apps/ui/", "dist/", "scripts/"];
const DEMO_PACKAGE_FILES = new Set([
  "assets/demo-project/package.json",
  "assets/demo-project/src/sum.js",
  "assets/demo-project/test/sum.test.js",
]);
const REQUIRED_PACKAGE_FILES = [
  "dist/index.js",
  "apps/ui/app.html",
  "scripts/start-verdikt-app.ps1",
  "scripts/start-verdikt-app.sh",
  ...DEMO_PACKAGE_FILES,
];
const TEST_ARTIFACT_PATTERN =
  /(?:^|\/)[^/]+\.(?:test|spec)\.(?:[cm]?js|[cm]?jsx|d\.ts|d\.ts\.map|js\.map)$/;

interface NpmPackFile {
  path?: unknown;
}

interface NpmPackResult {
  files?: NpmPackFile[];
}

export function validatePackageFiles(filePaths: string[]): string[] {
  const findings: string[] = [];
  const normalizedFiles = filePaths.map(normalizePath);
  const fileSet = new Set(normalizedFiles);

  for (const requiredFile of REQUIRED_PACKAGE_FILES) {
    if (!fileSet.has(requiredFile)) {
      findings.push(`Package is missing required runtime file: ${requiredFile}`);
    }
  }

  for (const filePath of normalizedFiles.sort()) {
    if (DEMO_PACKAGE_FILES.has(filePath)) continue;
    if (isTestArtifact(filePath)) {
      findings.push(`Package includes test artifact: ${filePath}`);
      continue;
    }

    if (isAllowedPackageFile(filePath)) continue;

    findings.push(`Package includes non-runtime file: ${filePath}`);
  }

  return findings;
}

function isAllowedPackageFile(filePath: string): boolean {
  if (ALLOWED_PACKAGE_FILES.has(filePath)) return true;
  return ALLOWED_PACKAGE_PREFIXES.some((prefix) => filePath.startsWith(prefix));
}

function isTestArtifact(filePath: string): boolean {
  return TEST_ARTIFACT_PATTERN.test(filePath);
}

function normalizePath(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}

function listDryRunPackageFiles(): string[] {
  const output =
    process.platform === "win32"
      ? execFileSync(
          process.env.ComSpec ?? "cmd.exe",
          ["/d", "/s", "/c", "npm pack --dry-run --json --ignore-scripts"],
          { encoding: "utf-8" },
        )
      : execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
          encoding: "utf-8",
        });
  const parsed = JSON.parse(output) as NpmPackResult[];
  const files = parsed[0]?.files ?? [];
  return files.map((file) => file.path).filter((path): path is string => typeof path === "string");
}

function main(): void {
  const findings = validatePackageFiles(listDryRunPackageFiles());
  if (findings.length > 0) {
    console.error("Verdikt package check failed");
    for (const finding of findings) {
      console.error(`- ${finding}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("Verdikt package check passed");
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("src/release/packageCheck.ts")) {
  main();
}
