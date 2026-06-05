import { describe, it, expect } from "vitest";
import { capitalize, camelCase, kebabCase, truncate, clamp, lerp, roundTo, sum } from "../src/utils.js";

describe("string utils", () => {
  it("capitalize", () => expect(capitalize("hello")).toBe("Hello"));
  it("camelCase", () => expect(camelCase("hello-world")).toBe("helloWorld"));
  it("kebabCase", () => expect(kebabCase("helloWorld")).toBe("hello-world"));
  it("truncate", () => expect(truncate("hello world", 8)).toBe("hello..."));
  it("truncate short string", () => expect(truncate("hi", 10)).toBe("hi"));
});

describe("number utils", () => {
  it("clamp within range", () => expect(clamp(5, 0, 10)).toBe(5));
  it("clamp below min", () => expect(clamp(-5, 0, 10)).toBe(0));
  it("clamp above max", () => expect(clamp(15, 0, 10)).toBe(10));
  it("lerp", () => expect(lerp(0, 10, 0.5)).toBe(5));
  it("roundTo", () => expect(roundTo(3.14159, 2)).toBe(3.14));
  it("sum", () => expect(sum([1, 2, 3, 4])).toBe(10));
  it("sum empty", () => expect(sum([])).toBe(0));
});
