import { describe, expect, it } from "vitest";
import { KVStore, createStore } from "../src/store.js";

describe("KVStore basic operations", () => {
  it("sets and gets", () => {
    const s = createStore();
    s.set("a", "1");
    expect(s.get("a")).toBe("1");
  });
  it("returns undefined for missing key", () => {
    const s = createStore();
    expect(s.get("missing")).toBeUndefined();
  });
  it("deletes key", () => {
    const s = createStore();
    s.set("a", "1");
    s.delete("a");
    expect(s.get("a")).toBeUndefined();
  });
  it("checks has", () => {
    const s = createStore();
    s.set("a", "1");
    expect(s.has("a")).toBe(true);
    expect(s.has("b")).toBe(false);
  });
  it("lists keys", () => {
    const s = createStore();
    s.set("a", "1");
    s.set("b", "2");
    expect(s.keys().sort()).toEqual(["a", "b"]);
  });
});

describe("KVStore batch operations", () => {
  it("batchSet sets multiple keys", () => {
    const s = createStore();
    s.batchSet([
      ["a", "1"],
      ["b", "2"],
      ["c", "3"],
    ]);
    expect(s.get("a")).toBe("1");
    expect(s.get("b")).toBe("2");
    expect(s.get("c")).toBe("3");
  });

  it("batchGet returns values for existing keys", () => {
    const s = createStore();
    s.set("a", "1");
    s.set("b", "2");
    const result = s.batchGet(["a", "b", "c"]);
    expect(result).toEqual([
      ["a", "1"],
      ["b", "2"],
    ]);
  });

  it("batchDelete removes multiple keys", () => {
    const s = createStore();
    s.set("a", "1");
    s.set("b", "2");
    s.set("c", "3");
    const deleted = s.batchDelete(["a", "c"]);
    expect(deleted).toBe(2);
    expect(s.has("a")).toBe(false);
    expect(s.has("b")).toBe(true);
    expect(s.has("c")).toBe(false);
  });
});
