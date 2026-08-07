/**
 * Configuration loader for Verdikt.
 */

import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ProviderAuthType, ProviderMode } from "./provider/types.js";

export interface VerdiktConfig {
  model: string;
  providerMode: ProviderMode;
  providerBaseUrl?: string;
  providerAuthType: ProviderAuthType;
  providerCredential?: string;
  defaultMaxIterations: number;
  defaultTimeoutMs: number;
  defaultSoftTimeoutMs: number;
  defaultAbsoluteTimeoutMs: number;
  maxRetries: number;
  stateDir: string;
  concurrency: number;
  verbose: boolean;
}

let cached: VerdiktConfig | null = null;

export function getConfig(): VerdiktConfig {
  if (!cached) cached = loadConfigFromEnv();
  return { ...cached };
}

export function setConfig(overrides: Partial<VerdiktConfig>): VerdiktConfig {
  cached = {
    ...(cached ?? loadConfigFromEnv({ migrateLegacy: overrides.stateDir === undefined })),
    ...overrides,
  };
  return { ...cached };
}

export function resetConfig(): void {
  cached = null;
}

function loadConfigFromEnv(options: { migrateLegacy?: boolean } = {}): VerdiktConfig {
  const defaultTimeoutMs = parseEnvInteger("VERDIKT_TIMEOUT_MS", 300_000, 1_000, 3_600_000);
  const defaultSoftTimeoutMs = parseEnvInteger("VERDIKT_SOFT_TIMEOUT_MS", 120_000, 0, 3_600_000);
  const defaultAbsoluteTimeoutMs = parseEnvInteger(
    "VERDIKT_ABSOLUTE_TIMEOUT_MS",
    600_000,
    1_000,
    7_200_000,
  );
  if (defaultSoftTimeoutMs > defaultTimeoutMs) {
    throw new Error("VERDIKT_SOFT_TIMEOUT_MS must not exceed VERDIKT_TIMEOUT_MS");
  }
  if (defaultAbsoluteTimeoutMs < defaultTimeoutMs) {
    throw new Error("VERDIKT_ABSOLUTE_TIMEOUT_MS must be at least VERDIKT_TIMEOUT_MS");
  }
  const model = process.env.VERDIKT_MODEL?.trim() || "sonnet";
  const providerBaseUrl = process.env.ANTHROPIC_BASE_URL?.trim() || undefined;
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN?.trim() || undefined;
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim() || undefined;
  const providerCredential = authToken ?? apiKey;
  const providerMode: ProviderMode =
    providerBaseUrl || providerCredential ? "anthropic_compatible" : "claude_login";
  const configuredStateDir = process.env.VERDIKT_STATE_DIR?.trim();
  const stateDir = configuredStateDir || defaultStateDir();
  if (!configuredStateDir && options.migrateLegacy !== false) migrateLegacyStateDir(stateDir);
  const verbose = parseEnvBoolean("VERDIKT_VERBOSE", false);
  return {
    model,
    providerMode,
    providerBaseUrl,
    providerAuthType: authToken ? "auth_token" : "api_key",
    providerCredential,
    defaultMaxIterations: parseEnvInteger("VERDIKT_MAX_ITERATIONS", 5, 1, 100),
    defaultTimeoutMs,
    defaultSoftTimeoutMs,
    defaultAbsoluteTimeoutMs,
    maxRetries: parseEnvInteger("VERDIKT_MAX_RETRIES", 2, 0, 10),
    stateDir,
    concurrency: 1,
    verbose,
  };
}

function defaultStateDir(): string {
  const homeDir = homedir();
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA?.trim() || join(homeDir, "AppData", "Local");
    return join(localAppData, "Verdikt");
  }
  if (process.platform === "darwin") {
    return join(homeDir, "Library", "Application Support", "Verdikt");
  }
  const stateHome = process.env.XDG_STATE_HOME?.trim() || join(homeDir, ".local", "state");
  return join(stateHome, "verdikt");
}

/**
 * Copy state created by older versions from the launch directory into the
 * stable platform data directory. The old directory is left intact so a
 * failed or interrupted migration never destroys the user's history.
 */
export function migrateLegacyStateDir(
  stateDirInput: string,
  legacyStateDirInput = join(process.cwd(), ".verdikt"),
): void {
  const stateDir = resolve(stateDirInput);
  const legacyStateDir = resolve(legacyStateDirInput);
  if (stateDir === legacyStateDir || !existsSync(legacyStateDir)) return;

  let entries: string[];
  try {
    entries = readdirSync(legacyStateDir);
  } catch {
    return;
  }
  if (entries.length === 0) return;

  try {
    mkdirSync(stateDir, { recursive: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!isLegacyStateEntry(entry)) continue;
    const source = join(legacyStateDir, entry);
    const destination = join(stateDir, entry);
    if (existsSync(destination)) continue;
    try {
      cpSync(source, destination, { recursive: true, force: false });
    } catch {
      // Migration is best effort. The original directory remains available.
    }
  }
}

function isLegacyStateEntry(entry: string): boolean {
  if (entry === "locks" || entry === ".integration") return false;
  return (
    entry === "queue.json" ||
    entry === "queue.json.bak" ||
    entry === "provider-settings.json" ||
    entry === "provider-settings.json.bak" ||
    /^[a-zA-Z0-9_-]{1,64}$/.test(entry)
  );
}

function parseEnvInteger(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^-?\d+$/.test(raw.trim())) {
    throw new Error(`${name} must be an integer between ${min} and ${max}; received "${raw}"`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}; received "${raw}"`);
  }
  return value;
}

function parseEnvBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  throw new Error(`${name} must be one of 1, 0, true, or false; received "${raw}"`);
}
