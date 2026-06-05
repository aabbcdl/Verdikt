import { describe, it, expect, vi } from "vitest";
import { memoize } from "../src/memoize.js";

describe("memoize", () => {
  it("returns correct result", () => {
    const double = memoize((n: number) => n * 2);
    expect(double(5)).toBe(10);
  });

  it("caches results (function not called twice for same arg)", () => {
    const spy = vi.fn((n: number) => n * n);
    const cached = memoize(spy);
    expect(cached(3)).toBe(9);
    expect(cached(3)).toBe(9);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("different args get different results", () => {
    const cached = memoize((n: number) => n * n);
    expect(cached(2)).toBe(4);
    expect(cached(3)).toBe(9);
    expect(cached(4)).toBe(16);
  });

  it("each memoize call creates independent cache", () => {
    let counter = 0;
    const cached1 = memoize(() => ++counter);
    const cached2 = memoize(() => ++counter);
    expect(cached1("x")).toBe(1);
    expect(cached2("x")).toBe(2); // independent cache
    expect(cached1("x")).toBe(1); // still cached from cached1
  });

  it("works with string arguments", () => {
    const upper = memoize((s: string) => s.toUpperCase());
    expect(upper("hello")).toBe("HELLO");
    expect(upper("hello")).toBe("HELLO");
    expect(upper("world")).toBe("WORLD");
  });
});
