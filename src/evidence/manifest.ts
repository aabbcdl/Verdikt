import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonFile, writeJsonAtomic } from "../trace/atomicJson.js";

export interface EvidenceManifestFile {
  path: string;
  sha256: string;
  size: number;
}

export interface EvidenceManifest {
  version: 1;
  createdAt: string;
  environment: {
    node: string;
    platform: string;
    arch: string;
  };
  provenance: {
    verdiktVersion?: string;
    model?: string;
    baseCommit?: string;
  };
  files: EvidenceManifestFile[];
  requiredFiles?: string[];
}

export interface EvidenceManifestOptions {
  verdiktVersion?: string;
  model?: string;
  baseCommit?: string;
  requiredFiles?: string[];
}

export interface EvidenceVerification {
  valid: boolean;
  missing: string[];
  changed: string[];
  errors: string[];
}

const ROOT_EVIDENCE_FILES = [
  "task.json",
  "iterations.jsonl",
  "events.jsonl",
  "summary.json",
  "state.json",
  "approval.json",
  "action-approvals.json",
  "notes.json",
  "plan.md",
];

const ROOT_EVIDENCE_DIRECTORIES = ["checkpoints"];

export async function createEvidenceManifest(
  runDir: string,
  options: EvidenceManifestOptions = {},
): Promise<EvidenceManifest> {
  const root = resolve(runDir);
  const requiredFiles = options.requiredFiles ?? ["task.json"];
  for (const requiredFile of requiredFiles) {
    const requiredPath = resolve(root, requiredFile);
    if (
      !isPathInside(root, requiredPath) ||
      requiredFile.includes("\\") ||
      requiredFile.startsWith("/")
    ) {
      throw new Error(`Unsafe required evidence path: ${requiredFile}`);
    }
    if (!existsSync(requiredPath)) {
      throw new Error(`Required evidence file is missing: ${requiredFile}`);
    }
  }
  const paths = new Set<string>();
  for (const requiredFile of requiredFiles) paths.add(requiredFile);
  for (const fileName of ROOT_EVIDENCE_FILES) {
    if (existsSync(join(root, fileName))) paths.add(fileName);
  }
  for (const directory of ROOT_EVIDENCE_DIRECTORIES) {
    const directoryPath = join(root, directory);
    if (!existsSync(directoryPath)) continue;
    for (const filePath of await walkEvidenceFiles(directoryPath)) {
      paths.add(normalizePath(relative(root, filePath)));
    }
  }

  const evidenceDir = join(root, "evidence");
  if (existsSync(evidenceDir)) {
    for (const filePath of await walkEvidenceFiles(evidenceDir)) {
      const relativePath = normalizePath(relative(root, filePath));
      if (relativePath !== "evidence/manifest.json") paths.add(relativePath);
    }
  }

  const files: EvidenceManifestFile[] = [];
  for (const relativePath of [...paths].sort()) {
    const filePath = resolve(root, relativePath);
    if (!isPathInside(root, filePath)) continue;
    const content = await readFile(filePath);
    files.push({
      path: relativePath,
      sha256: createHash("sha256").update(content).digest("hex"),
      size: content.byteLength,
    });
  }

  const manifest: EvidenceManifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    provenance: {
      verdiktVersion: options.verdiktVersion ?? (await readVerdiktVersion()),
      model: options.model,
      baseCommit: options.baseCommit,
    },
    files,
    requiredFiles,
  };
  await writeJsonAtomic(join(evidenceDir, "manifest.json"), manifest, { backup: true });
  return manifest;
}

export async function refreshEvidenceManifest(runDir: string): Promise<EvidenceManifest> {
  const existing = await readJsonFile<EvidenceManifest>(
    join(resolve(runDir), "evidence", "manifest.json"),
  );
  return createEvidenceManifest(runDir, {
    verdiktVersion: existing?.provenance.verdiktVersion,
    model: existing?.provenance.model,
    baseCommit: existing?.provenance.baseCommit,
    requiredFiles: existing?.requiredFiles,
  });
}

export async function verifyEvidenceManifest(runDir: string): Promise<EvidenceVerification> {
  const root = resolve(runDir);
  const manifest = await readJsonFile<EvidenceManifest>(join(root, "evidence", "manifest.json"));
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.files)) {
    return { valid: false, missing: ["evidence/manifest.json"], changed: [], errors: [] };
  }

  const missing: string[] = [];
  const changed: string[] = [];
  const errors: string[] = [];
  const requiredFiles = manifest.requiredFiles ?? ["task.json"];
  for (const requiredFile of requiredFiles) {
    const requiredPath = resolve(root, requiredFile);
    if (isAbsolute(requiredFile) || !isPathInside(root, requiredPath)) {
      errors.push(`Unsafe required evidence path: ${requiredFile}`);
      continue;
    }
    if (!existsSync(requiredPath)) missing.push(requiredFile);
  }
  for (const entry of manifest.files) {
    const filePath = resolve(root, entry.path);
    if (isAbsolute(entry.path) || !isPathInside(root, filePath)) {
      errors.push(`Unsafe evidence path: ${entry.path}`);
      continue;
    }
    try {
      const content = await readFile(filePath);
      const digest = createHash("sha256").update(content).digest("hex");
      if (digest !== entry.sha256 || content.byteLength !== entry.size) changed.push(entry.path);
    } catch {
      missing.push(entry.path);
    }
  }

  return {
    valid: missing.length === 0 && changed.length === 0 && errors.length === 0,
    missing,
    changed,
    errors,
  };
}

async function walkEvidenceFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.endsWith(".bak") || entry.name.includes(".tmp-")) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkEvidenceFiles(fullPath)));
    } else if (entry.isFile() && (await stat(fullPath)).isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function isPathInside(basePath: string, targetPath: string): boolean {
  const relativePath = relative(resolve(basePath), resolve(targetPath));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

async function readVerdiktVersion(): Promise<string | undefined> {
  try {
    const packagePath = fileURLToPath(new URL("../../package.json", import.meta.url));
    const parsed = JSON.parse(await readFile(packagePath, "utf-8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}
