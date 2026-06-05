import { describe, it, expect } from "vitest";
import { createLogger, type LogLevel } from "../src/logger.js";

function captureOutput(): { lines: string[]; output: (line: string) => void } {
  const lines: string[] = [];
  return { lines, output: (line: string) => lines.push(line) };
}

describe("createLogger", () => {
  it("logs at or above min level", () => {
    const { lines, output } = captureOutput();
    const logger = createLogger("warn", "", output);
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(lines).toHaveLength(2);
  });

  it("formats with level and message", () => {
    const { lines, output } = captureOutput();
    const logger = createLogger("info", "", output);
    logger.info("hello");
    expect(lines[0]).toMatch(/INFO/);
    expect(lines[0]).toContain("hello");
  });

  it("includes prefix in output", () => {
    const { lines, output } = captureOutput();
    const logger = createLogger("info", "APP", output);
    logger.info("started");
    expect(lines[0]).toContain("[APP]");
    expect(lines[0]).toContain("started");
  });

  it("child logger inherits parent prefix", () => {
    const { lines, output } = captureOutput();
    const parent = createLogger("info", "APP", output);
    const child = parent.child("DB");
    child.info("connected");
    expect(lines[0]).toContain("[APP]");
    expect(lines[0]).toContain("[DB]");
  });
});
