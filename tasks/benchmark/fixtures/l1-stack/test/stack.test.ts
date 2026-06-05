import { describe, expect, it } from "vitest";
import { Stack } from "../src/stack.js";
describe("Stack", () => {
  it("pushes and pops", () => {
    const s = new Stack<number>();
    s.push(1);
    s.push(2);
    expect(s.pop()).toBe(2);
    expect(s.pop()).toBe(1);
  });
  it("peek returns top without removing", () => {
    const s = new Stack<string>();
    s.push("a");
    s.push("b");
    expect(s.peek()).toBe("b");
    expect(s.peek()).toBe("b");
  });
  it("isEmpty returns true for empty stack", () => {
    const s = new Stack<number>();
    expect(s.isEmpty()).toBe(true);
  });
  it("isEmpty returns false for non-empty stack", () => {
    const s = new Stack<number>();
    s.push(1);
    expect(s.isEmpty()).toBe(false);
  });
  it("size returns count", () => {
    const s = new Stack<number>();
    s.push(1);
    s.push(2);
    s.push(3);
    expect(s.size()).toBe(3);
  });
  it("toArray returns copy", () => {
    const s = new Stack<number>();
    s.push(1);
    s.push(2);
    expect(s.toArray()).toEqual([1, 2]);
  });
});
