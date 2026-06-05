import { describe, expect, it } from "vitest";
import { average, percentage } from "../src/mathOps.js";

describe("percentage", () => {
  it("calculates basic percentage", () => expect(percentage(25, 100)).toBe(25));
  it("handles fractional results", () => expect(percentage(1, 3)).toBeCloseTo(33.33, 1));
  it("handles zero total", () => expect(percentage(5, 0)).toBe(0));
  it("handles 100%", () => expect(percentage(50, 50)).toBe(100));
});

describe("average", () => {
  it("calculates average of numbers", () => expect(average([2, 4, 6])).toBe(4));
  it("ignores undefined values", () => expect(average([2, undefined, 6])).toBe(4));
  it("handles all undefined", () => expect(average([undefined, undefined])).toBe(0));
  it("handles empty array", () => expect(average([])).toBe(0));
});
