/**
 * Memoize utility — needs implementation.
 *
 * Must be a pure higher-order function that wraps any single-argument function
 * with a cache. The cache should be per-instance (created by memoize call),
 * not global.
 *
 * Requirements:
 * - Returns a new function that caches results
 * - Cache key is the string representation of the argument
 * - Each memoize() call creates an independent cache
 * - Must NOT use global mutable state
 */

export function memoize<T, R>(_fn: (arg: T) => R): (arg: T) => R {
  // TODO: implement this
  // The cache should be local to this closure, not global
  throw new Error("Not implemented");
}
