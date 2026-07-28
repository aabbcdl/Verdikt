import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { consumeQueuedNotes, queueRunNote, readRunNotes } from "./notes.js";

describe("queued run notes", () => {
  let runDir: string;
  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), "verdikt-notes-"));
  });
  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it("queues notes durably and consumes them exactly once", async () => {
    await queueRunNote(runDir, "Keep the public API unchanged", "web");
    await queueRunNote(runDir, "Also cover the empty case", "cli");
    expect((await readRunNotes(runDir)).queued).toHaveLength(2);

    const consumed = await consumeQueuedNotes(runDir, 2);
    expect(consumed.map((note) => note.text)).toEqual([
      "Keep the public API unchanged",
      "Also cover the empty case",
    ]);
    expect(await consumeQueuedNotes(runDir, 3)).toEqual([]);
    expect((await readRunNotes(runDir)).history).toHaveLength(2);
  });

  it("rejects empty or excessively large notes", async () => {
    await expect(queueRunNote(runDir, "   ", "web")).rejects.toThrow("must not be empty");
    await expect(queueRunNote(runDir, "x".repeat(5001), "web")).rejects.toThrow("too long");
  });
});
