/**
 * Debounce utility.
 * Bug 1: doesn't cancel previous timer
 * Bug 2: doesn't pass arguments to the debounced function
 */

export function debounce<T extends (...args: any[]) => any>(
  fn: T,
  delayMs: number,
): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;

  return (...args: Parameters<T>) => {
    // Bug: should clear previous timer first
    timer = setTimeout(() => {
      // Bug: should spread args: fn(...args)
      fn();
    }, delayMs);
  };
}

/**
 * Throttle utility.
 * Bug 3: doesn't respect the trailing call
 */

export function throttle<T extends (...args: any[]) => any>(
  fn: T,
  intervalMs: number,
): (...args: Parameters<T>) => void {
  let lastCall = 0;

  return (...args: Parameters<T>) => {
    const now = Date.now();
    if (now - lastCall >= intervalMs) {
      lastCall = now;
      fn(...args);
    }
    // Bug: missing trailing call — last call within interval is lost
  };
}
