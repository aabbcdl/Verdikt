/**
 * Normalize a string for use as a filename.
 * Bug: normalizes ALL inputs, but test expects "Hello World" to stay unchanged.
 * This creates an impossible conflict: either normalize breaks the "keep" test,
 * or not normalizing breaks the "normalize" test.
 */
export function toFilename(input: string): string {
  return input
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_.-]/g, "");
}
