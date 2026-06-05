import { describe, it, expect } from "vitest";
import { slugify, truncate, capitalizeWords } from "../src/transformer.js";

describe("slugify", () => {
  it("converts to lowercase hyphenated", () => expect(slugify("Hello World")).toBe("hello-world"));
  it("removes special chars", () => expect(slugify("Hello, World!")).toBe("hello-world"));
  it("collapses multiple spaces", () => expect(slugify("hello   world")).toBe("hello-world"));
  it("handles already slugified", () => expect(slugify("hello-world")).toBe("hello-world"));
});

describe("truncate", () => {
  it("returns short string unchanged", () => expect(truncate("hi", 10)).toBe("hi"));
  it("truncates with ellipsis", () => expect(truncate("hello world", 8)).toBe("hello..."));
  it("exact length unchanged", () => expect(truncate("hello", 5)).toBe("hello"));
});

describe("capitalizeWords", () => {
  it("capitalizes each word", () => expect(capitalizeWords("hello world")).toBe("Hello World"));
  it("handles single word", () => expect(capitalizeWords("hello")).toBe("Hello"));
  it("handles empty string", () => expect(capitalizeWords("")).toBe(""));
});
