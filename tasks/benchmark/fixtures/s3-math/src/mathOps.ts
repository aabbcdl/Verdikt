/** Percentage calculation. Bug: uses integer division. */
export function percentage(value: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((value / total) * 100); // Bug: rounds too early
}

/** Average calculation. Bug: counts undefined as 0. */
export function average(numbers: (number | undefined)[]): number {
  const valid = numbers.filter((n): n is number => n !== undefined);
  if (valid.length === 0) return 0;
  // Bug: uses numbers.length instead of valid.length
  return valid.reduce((a, b) => a + b, 0) / numbers.length;
}
