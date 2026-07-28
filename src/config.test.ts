import { afterEach, describe, expect, it } from "vitest";
import { getConfig, resetConfig } from "./config.js";

describe("configuration", () => {
  afterEach(() => {
    Reflect.deleteProperty(process.env, "VERDIKT_MAX_ITERATIONS");
    Reflect.deleteProperty(process.env, "VERDIKT_TIMEOUT_MS");
    Reflect.deleteProperty(process.env, "VERDIKT_SOFT_TIMEOUT_MS");
    Reflect.deleteProperty(process.env, "VERDIKT_ABSOLUTE_TIMEOUT_MS");
    Reflect.deleteProperty(process.env, "VERDIKT_MAX_RETRIES");
    Reflect.deleteProperty(process.env, "VERDIKT_VERBOSE");
    resetConfig();
  });

  it("rejects NaN environment values instead of entering a run", () => {
    process.env.VERDIKT_MAX_ITERATIONS = "not-a-number";
    expect(() => getConfig()).toThrow("VERDIKT_MAX_ITERATIONS must be an integer");
  });

  it("rejects timeout values outside safe bounds", () => {
    process.env.VERDIKT_TIMEOUT_MS = "10";
    expect(() => getConfig()).toThrow("VERDIKT_TIMEOUT_MS must be an integer");
  });

  it("rejects inconsistent timeout ordering", () => {
    process.env.VERDIKT_TIMEOUT_MS = "1000";
    process.env.VERDIKT_SOFT_TIMEOUT_MS = "0";
    process.env.VERDIKT_ABSOLUTE_TIMEOUT_MS = "1000";
    expect(() => getConfig()).not.toThrow();
    process.env.VERDIKT_SOFT_TIMEOUT_MS = "2000";
    resetConfig();
    expect(() => getConfig()).toThrow("VERDIKT_SOFT_TIMEOUT_MS must not exceed");
  });
});
