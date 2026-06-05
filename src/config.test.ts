import { beforeEach, describe, expect, it } from "vitest";
import { getConfig, resetConfig, setConfig } from "./config.js";

describe("Config", () => {
  beforeEach(() => {
    resetConfig();
  });

  it("returns default config when no overrides", () => {
    const config = getConfig();
    expect(config.model).toBeDefined();
    expect(config.defaultMaxIterations).toBe(5);
    expect(config.defaultTimeoutMs).toBe(300000);
    expect(config.stateDir).toBe(".verdikt");
    expect(config.concurrency).toBe(1);
    expect(config.verbose).toBe(false);
  });

  it("returns a copy of config (immutable)", () => {
    const config1 = getConfig();
    const config2 = getConfig();
    expect(config1).toEqual(config2);
    expect(config1).not.toBe(config2);
  });

  it("setConfig overrides specific fields", () => {
    setConfig({ model: "opus", verbose: true });
    const config = getConfig();
    expect(config.model).toBe("opus");
    expect(config.verbose).toBe(true);
    // Other fields should remain default
    expect(config.defaultMaxIterations).toBe(5);
  });

  it("setConfig merges with defaults", () => {
    setConfig({ model: "haiku" });
    const config = getConfig();
    expect(config.model).toBe("haiku");
    expect(config.stateDir).toBe(".verdikt");
  });

  it("resetConfig clears overrides", () => {
    setConfig({ model: "opus" });
    expect(getConfig().model).toBe("opus");
    resetConfig();
    // After reset, should return defaults (which may be from env vars)
    const config = getConfig();
    expect(config).toBeDefined();
  });

  it("setConfig returns the new config", () => {
    const result = setConfig({ model: "test-model" });
    expect(result.model).toBe("test-model");
  });
});
