import { describe, it, expect, vi } from "vitest";
import { debounce, throttle } from "../src/timing.js";

describe("debounce", () => {
  it("delays execution", async () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounce(fn, 100);
    debounced();
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("passes arguments to the function", async () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounce(fn, 100);
    debounced("hello", 42);
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledWith("hello", 42);
    vi.useRealTimers();
  });

  it("cancels previous call on rapid invocation", async () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounce(fn, 100);
    debounced("first");
    vi.advanceTimersByTime(50);
    debounced("second");
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("second");
    vi.useRealTimers();
  });
});

describe("throttle", () => {
  it("executes immediately on first call", () => {
    const fn = vi.fn();
    const throttled = throttle(fn, 100);
    throttled("test");
    expect(fn).toHaveBeenCalledWith("test");
  });

  it("ignores calls within interval", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const throttled = throttle(fn, 100);
    throttled("first");
    throttled("second");
    expect(fn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("allows call after interval", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const throttled = throttle(fn, 100);
    throttled("first");
    vi.advanceTimersByTime(150);
    throttled("second");
    expect(fn).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
