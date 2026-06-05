import { describe, expect, it } from "vitest";
import { sum } from "../src/sum.js";

describe("sum", () => {
  it("adds two positive numbers", () => {
    expect(sum(2, 3)).toBe(5);
  });

  it("adds negative numbers", () => {
    expect(sum(-1, -2)).toBe(-3);
  });

  it("handles zero", () => {
    expect(sum(0, 5)).toBe(5);
  });
});
