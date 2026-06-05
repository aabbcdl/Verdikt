import { describe, expect, it } from "vitest";
import { toFilename } from "../src/normalize.js";

describe("toFilename", () => {
  it("normalizes spaces to underscores and lowercases", () => {
    expect(toFilename("Hello World")).toBe("hello_world");
  });

  it("keeps already-clean filenames unchanged", () => {
    expect(toFilename("Hello World")).toBe("Hello World");
  });

  it("removes special characters", () => {
    expect(toFilename("file@name!.txt")).toBe("filenametxt");
  });
});
