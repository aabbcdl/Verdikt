/**
 * Staged judge task: fix the logic bug AND the type error.
 *
 * Bug 1 (test fails): square uses n + n instead of n * n
 * Bug 2 (typecheck fails, only visible after Bug 1 is fixed):
 *   squareRoot accepts number | string but test passes number,
 *   and Math.sqrt expects number. When square returned 0 (number literal),
 *   the type flow was masked. After fixing square, TypeScript may catch
 *   the union type issue in squareRoot.
 */

export function square(n: number): number {
  return n + n; // Bug: should be n * n
}

export function squareRoot(n: number | string): number {
  // This is used by tests but has a type consideration
  return Math.sqrt(Number(n));
}

export function hypotenuse(a: number, b: number): number {
  // Uses square — after fixing square, this should work correctly
  return Math.sqrt(square(a) + square(b));
}
