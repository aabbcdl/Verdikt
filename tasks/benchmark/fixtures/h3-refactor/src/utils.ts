/**
 * Monolithic utils module — needs to be split.
 *
 * Task: Extract string utilities into stringUtils.ts and number utilities
 * into numberUtils.ts. Keep the main utils.ts as a re-export barrel.
 * All existing tests must continue to pass without modification.
 */

// String utilities
export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function camelCase(s: string): string {
  return s
    .replace(/[-_\s]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : ""))
    .replace(/^[A-Z]/, (c) => c.toLowerCase());
}

export function kebabCase(s: string): string {
  return s
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();
}

export function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3) + "...";
}

// Number utilities
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function sum(numbers: number[]): number {
  return numbers.reduce((a, b) => a + b, 0);
}
