import { describe, it, expect } from "vitest";
import { square, squareRoot, hypotenuse } from "../src/math.js";

describe("square", () => {
  it("squares positive numbers", () => expect(square(3)).toBe(9));
  it("squares zero", () => expect(square(0)).toBe(0));
  it("squares negative numbers", () => expect(square(-4)).toBe(16));
});

describe("squareRoot", () => {
  it("computes square root", () => expect(squareRoot(9)).toBe(3));
  it("handles string input", () => expect(squareRoot("16")).toBe(4));
});

describe("hypotenuse", () => {
  it("computes 3-4-5 triangle", () => expect(hypotenuse(3, 4)).toBe(5));
});
