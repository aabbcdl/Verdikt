import { describe, it, expect } from "vitest";
import { parse } from "../src/parser.js";
describe("parse", () => {
  it("parses key=value", () => expect(parse("a=1")).toEqual({ a: "1" }));
  it("trims values", () => expect(parse("a= 1 ")).toEqual({ a: "1" }));
  it("handles quoted values", () => expect(parse('a="hello world"')).toEqual({ a: '"hello world"' }));
  it("ignores comments", () => expect(parse("# comment\na=1")).toEqual({ a: "1" }));
  it("preserves # inside quotes", () => expect(parse('a="hello # world"')).toEqual({ a: '"hello # world"' }));
  it("handles multiple lines", () => expect(parse("a=1\nb=2")).toEqual({ a: "1", b: "2" }));
});
