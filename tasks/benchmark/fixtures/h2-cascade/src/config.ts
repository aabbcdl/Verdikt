/**
 * Config parser with cascading bugs.
 * Bug 1: parseLine crashes on empty value (split returns [])
 * Bug 2: mergeConfigs overwrites instead of merging (only keeps last)
 * Bug 3: formatOutput loses keys with dots (truncates at first dot)
 *
 * Bug 2 is only visible after Bug 1 is fixed (parseLine must work for merge to run).
 * Bug 3 is only visible after Bug 2 is fixed (merge must work for format to matter).
 */

export function parseLine(line: string): { key: string; value: string } {
  const parts = line.split("=");
  // Bug: no bounds check — crashes if line has no "="
  return { key: parts[0].trim(), value: parts[1].trim() };
}

export function mergeConfigs(...configs: Array<Record<string, string>>): Record<string, string> {
  // Bug: creates new object each time instead of merging
  let result: Record<string, string> = {};
  for (const config of configs) {
    result = { ...config }; // Bug: should be { ...result, ...config }
  }
  return result;
}

export function formatOutput(config: Record<string, string>): string {
  return Object.entries(config)
    .map(([k, v]) => {
      // Bug: truncates key at first dot
      const shortKey = k.split(".")[0];
      return `${shortKey}=${v}`;
    })
    .join("\n");
}

export function parseConfig(input: string): Record<string, string> {
  const lines = input.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
  const parsed = lines.map(parseLine);
  const result: Record<string, string> = {};
  for (const { key, value } of parsed) {
    result[key] = value;
  }
  return result;
}
