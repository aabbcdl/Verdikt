/**
 * Configuration loader for Verdikt.
 *
 * Reads from environment variables with sensible defaults.
 * No .env file parsing — use `dotenv` or shell exports if needed.
 */

export interface VerdiktConfig {
  /** Model to use for both executor and verifier */
  model: string;
  /** Max iterations per run (overridable per task) */
  defaultMaxIterations: number;
  /** Default idle timeout per Claude call in ms */
  defaultTimeoutMs: number;
  /** Directory for run artifacts */
  stateDir: string;
  /** Max concurrent iterations (MVP is always 1) */
  concurrency: number;
  /** Verbose logging */
  verbose: boolean;
}

const DEFAULTS: VerdiktConfig = {
  model: process.env.VERDIKT_MODEL ?? "sonnet",
  defaultMaxIterations: Number.parseInt(process.env.VERDIKT_MAX_ITERATIONS ?? "5", 10),
  defaultTimeoutMs: Number.parseInt(process.env.VERDIKT_TIMEOUT_MS ?? "300000", 10), // 5 min
  stateDir: process.env.VERDIKT_STATE_DIR ?? ".verdikt",
  concurrency: 1,
  verbose: process.env.VERDIKT_VERBOSE === "1" || process.env.VERDIKT_VERBOSE === "true",
};

let cached: VerdiktConfig | null = null;

export function getConfig(): VerdiktConfig {
  if (!cached) {
    cached = { ...DEFAULTS };
  }
  return { ...cached };
}

/**
 * Override config (useful for testing).
 */
export function setConfig(overrides: Partial<VerdiktConfig>): VerdiktConfig {
  cached = { ...DEFAULTS, ...overrides };
  return { ...cached };
}

export function resetConfig(): void {
  cached = null;
}
