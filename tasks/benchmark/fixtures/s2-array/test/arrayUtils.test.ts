import { describe, it, expect } from "vitest";
import { findMax, chunk } from "../src/arrayUtils.js";

describe("findMax", () => {
  it("finds max in positive array", () => expect(findMax([1, 3, 2])).toBe(3));
  it("finds max in negative array", () => expect(findMax([-5, -1, -3])).toBe(-1));
  it("handles single element", () => expect(findMax([42])).toBe(42));
  it("throws on empty array", () => expect(() => findMax([])).toThrow());
});

describe("chunk", () => {
  it("chunks evenly", () => expect(chunk([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]]));
  it("keeps last incomplete chunk", () => expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]));
  it("handles size larger than array", () => expect(chunk([1, 2], 5)).toEqual([[1, 2]]));
});
