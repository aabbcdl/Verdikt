/**
 * Configuration loader for Verdikt.
 */

export interface VerdiktConfig {
  model: string;
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
  cached = { ...loadConfigFromEnv(), ...overrides };
  return { ...cached };
}

export function resetConfig(): void {
  cached = null;
}

function loadConfigFromEnv(): VerdiktConfig {
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
  const stateDir = process.env.VERDIKT_STATE_DIR?.trim() || ".verdikt";
  const verbose = parseEnvBoolean("VERDIKT_VERBOSE", false);
  return {
    model,
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
