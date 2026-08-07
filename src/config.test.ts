import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getConfig, resetConfig } from "./config.js";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

describe("configuration", () => {
  afterEach(() => {
    Reflect.deleteProperty(process.env, "VERDIKT_MAX_ITERATIONS");
    Reflect.deleteProperty(process.env, "VERDIKT_TIMEOUT_MS");
    Reflect.deleteProperty(process.env, "VERDIKT_SOFT_TIMEOUT_MS");
    Reflect.deleteProperty(process.env, "VERDIKT_ABSOLUTE_TIMEOUT_MS");
    Reflect.deleteProperty(process.env, "VERDIKT_MAX_RETRIES");
    Reflect.deleteProperty(process.env, "VERDIKT_VERBOSE");
    Reflect.deleteProperty(process.env, "VERDIKT_STATE_DIR");
    Reflect.deleteProperty(process.env, "LOCALAPPDATA");
    Reflect.deleteProperty(process.env, "XDG_STATE_HOME");
    if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
    resetConfig();
  });

  it.each([
    [
      "win32",
      { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" },
      "C:/Users/tester/AppData/Local/Verdikt",
    ],
    ["darwin", {}, `${homedir().replaceAll("\\", "/")}/Library/Application Support/Verdikt`],
    ["linux", { XDG_STATE_HOME: "/var/lib/tester" }, "/var/lib/tester/verdikt"],
    ["linux", {}, `${homedir().replaceAll("\\", "/")}/.local/state/verdikt`],
  ])("uses a stable default state directory on %s", (platform, env, expected) => {
    Object.defineProperty(process, "platform", { configurable: true, value: platform });
    Object.assign(process.env, env);

    expect(getConfig().stateDir.replaceAll("\\", "/")).toBe(expected);
  });

  it("keeps legacy .verdikt history discoverable when the default directory changes", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "verdikt-config-legacy-"));
    const legacyStateDir = join(fixtureRoot, "project", ".verdikt");
    await mkdir(join(legacyStateDir, "run-legacy"), { recursive: true });
    await mkdir(join(legacyStateDir, "locks"), { recursive: true });
    await mkdir(join(legacyStateDir, ".integration"), { recursive: true });
    await writeFile(join(legacyStateDir, "locks", "old.lock"), "stale", "utf-8");
    await writeFile(join(legacyStateDir, ".integration", "old.txt"), "temporary", "utf-8");
    await writeFile(
      join(legacyStateDir, "run-legacy", "summary.json"),
      JSON.stringify({ runId: "run-legacy", goal: "old history" }),
      "utf-8",
    );

    const originalCwd = vi.spyOn(process, "cwd").mockReturnValue(join(fixtureRoot, "project"));
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    process.env.LOCALAPPDATA = join(fixtureRoot, "AppData", "Local");

    try {
      const config = getConfig();
      expect(config.stateDir.replaceAll("\\", "/")).toBe(
        join(fixtureRoot, "AppData", "Local", "Verdikt").replaceAll("\\", "/"),
      );
      await expect(
        readFile(join(config.stateDir, "run-legacy", "summary.json"), "utf-8"),
      ).resolves.toContain("old history");
      await expect(
        readFile(join(config.stateDir, "locks", "old.lock"), "utf-8"),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        readFile(join(config.stateDir, ".integration", "old.txt"), "utf-8"),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      originalCwd.mockRestore();
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("keeps VERDIKT_STATE_DIR as the explicit state directory override", () => {
    process.env.VERDIKT_STATE_DIR = "D:\\custom-verdikt-state";

    expect(getConfig().stateDir).toBe("D:\\custom-verdikt-state");
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
