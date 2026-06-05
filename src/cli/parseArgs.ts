/**
 * Structured CLI argument parser with validation.
 *
 * Replaces manual indexOf parsing with schema-based validation.
 * Provides clear error messages for missing or invalid arguments.
 */

export interface ArgSpec {
  /** Required flags that must have a value (e.g., --task <file>) */
  required?: string[];
  /** Optional flags that take a value (e.g., --out <dir>) */
  optional?: string[];
  /** Boolean flags that don't take a value (e.g., --json, --dry-run) */
  boolean?: string[];
  /** Expected number of positional arguments */
  positional?: { min?: number; max?: number; names?: string[] };
}

export interface ParsedArgs {
  /** Positional arguments (non-flag args) */
  positional: string[];
  /** Flag values (flag name → value or true for boolean flags) */
  flags: Map<string, string | boolean>;
}

/**
 * Parse CLI arguments according to the given spec.
 *
 * @throws {Error} if required flags are missing or unknown flags are present
 */
export function parseArgs(args: string[], spec: ArgSpec = {}): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();

  const allKnownFlags = new Set([
    ...(spec.required ?? []),
    ...(spec.optional ?? []),
    ...(spec.boolean ?? []),
  ]);

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg.startsWith("--")) {
      const flagName = arg.slice(2);

      // Check if it's a known boolean flag
      if (spec.boolean?.includes(flagName)) {
        flags.set(flagName, true);
        i++;
        continue;
      }

      // Check if it's a known value flag
      if (spec.required?.includes(flagName) || spec.optional?.includes(flagName)) {
        const value = args[i + 1];
        if (!value || value.startsWith("--")) {
          throw new Error(`Flag --${flagName} requires a value.\nUsage: --${flagName} <value>`);
        }
        flags.set(flagName, value);
        i += 2;
        continue;
      }

      // Unknown flag
      throw new Error(
        `Unknown flag: --${flagName}\nKnown flags: ${[...allKnownFlags].map((f) => `--${f}`).join(", ")}`,
      );
    }

    // Positional argument
    positional.push(arg);
    i++;
  }

  // Validate required flags
  for (const req of spec.required ?? []) {
    if (!flags.has(req)) {
      throw new Error(`Missing required flag: --${req}\nUsage: --${req} <value>`);
    }
  }

  // Validate positional count
  if (spec.positional?.min !== undefined && positional.length < spec.positional.min) {
    const names = spec.positional.names ?? [];
    const expected = names.length > 0 ? names.join(" ") : `${spec.positional.min} arguments`;
    throw new Error(
      `Expected at least ${spec.positional.min} positional arguments (${expected}), got ${positional.length}`,
    );
  }

  if (spec.positional?.max !== undefined && positional.length > spec.positional.max) {
    throw new Error(
      `Expected at most ${spec.positional.max} positional arguments, got ${positional.length}`,
    );
  }

  return { positional, flags };
}

/**
 * Helper to get a flag value with a default.
 */
export function getFlag(parsed: ParsedArgs, name: string, defaultValue: string): string {
  const value = parsed.flags.get(name);
  if (typeof value === "string") return value;
  return defaultValue;
}

/**
 * Helper to check if a boolean flag is set.
 */
export function hasFlag(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags.get(name) === true;
}
