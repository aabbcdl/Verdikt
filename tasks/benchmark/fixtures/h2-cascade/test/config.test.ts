import { describe, expect, it } from "vitest";
import { formatOutput, mergeConfigs, parseConfig, parseLine } from "../src/config.js";

describe("parseLine", () => {
  it("parses key=value", () =>
    expect(parseLine("host=localhost")).toEqual({ key: "host", value: "localhost" }));
  it("handles empty value", () => expect(parseLine("debug=")).toEqual({ key: "debug", value: "" }));
  it("handles value with equals", () =>
    expect(parseLine("url=http://a.com?q=1")).toEqual({ key: "url", value: "http://a.com?q=1" }));
});

describe("mergeConfigs", () => {
  it("merges two configs", () =>
    expect(mergeConfigs({ a: "1" }, { b: "2" })).toEqual({ a: "1", b: "2" }));
  it("later config overrides earlier", () =>
    expect(mergeConfigs({ a: "1" }, { a: "2" })).toEqual({ a: "2" }));
  it("merges three configs", () =>
    expect(mergeConfigs({ a: "1" }, { b: "2" }, { c: "3" })).toEqual({ a: "1", b: "2", c: "3" }));
});

describe("formatOutput", () => {
  it("formats simple keys", () =>
    expect(formatOutput({ host: "localhost" })).toBe("host=localhost"));
  it("preserves dotted keys", () =>
    expect(formatOutput({ "db.host": "localhost" })).toBe("db.host=localhost"));
  it("formats multiple entries", () => {
    const result = formatOutput({ a: "1", b: "2" });
    expect(result).toContain("a=1");
    expect(result).toContain("b=2");
  });
});

describe("parseConfig", () => {
  it("parses multiline config", () => expect(parseConfig("a=1\nb=2")).toEqual({ a: "1", b: "2" }));
  it("skips comments", () => expect(parseConfig("# comment\na=1")).toEqual({ a: "1" }));
  it("skips empty lines", () => expect(parseConfig("a=1\n\nb=2")).toEqual({ a: "1", b: "2" }));
});
