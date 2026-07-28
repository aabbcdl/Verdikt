import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readJsonFile, writeJsonAtomic } from "./atomicJson.js";

describe("atomic JSON files", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "verdikt-atomic-json-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("writes parseable JSON without leaving a temporary file", async () => {
    const filePath = join(tempDir, "state.json");

    await writeJsonAtomic(filePath, { version: 1, status: "queued" });

    expect(JSON.parse(await readFile(filePath, "utf-8"))).toEqual({
      version: 1,
      status: "queued",
    });
    expect(existsSync(`${filePath}.tmp`)).toBe(false);
  });

  it("keeps the previous valid value as a backup when replacing a file", async () => {
    const filePath = join(tempDir, "state.json");
    await writeJsonAtomic(filePath, { version: 1 });

    await writeJsonAtomic(filePath, { version: 2 }, { backup: true });

    expect(await readJsonFile<{ version: number }>(filePath)).toEqual({ version: 2 });
    expect(await readJsonFile<{ version: number }>(`${filePath}.bak`)).toEqual({ version: 1 });
  });

  it("reliably replaces a file while readers are polling it", async () => {
    const filePath = join(tempDir, "queue.json");
    await writeJsonAtomic(filePath, { version: 0 });

    let reading = true;
    const reader = (async () => {
      while (reading) {
        await readJsonFile(filePath);
      }
    })();

    try {
      for (let version = 1; version <= 25; version += 1) {
        await writeJsonAtomic(filePath, { version }, { backup: true });
      }
    } finally {
      reading = false;
      await reader;
    }

    expect(await readJsonFile<{ version: number }>(filePath)).toEqual({ version: 25 });
  });

  it("returns null for a missing or malformed JSON file", async () => {
    expect(await readJsonFile(join(tempDir, "missing.json"))).toBeNull();
    const filePath = join(tempDir, "bad.json");
    await writeJsonAtomic(filePath, { valid: true });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(filePath, "not-json", "utf-8");
    expect(await readJsonFile(filePath)).toBeNull();
  });
});
