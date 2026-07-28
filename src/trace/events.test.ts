import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendRunEvent, readRunEvents } from "./events.js";

describe("run event timeline", () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), "verdikt-events-"));
  });

  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  it("appends ordered events and reads them back with stable sequence numbers", async () => {
    await appendRunEvent(runDir, { type: "run_started", runId: "run-1", data: { goal: "fix" } });
    await appendRunEvent(runDir, {
      type: "iteration_started",
      runId: "run-1",
      iteration: 0,
    });

    const events = await readRunEvents(runDir);
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(events.map((event) => event.type)).toEqual(["run_started", "iteration_started"]);
    expect(events[0].data).toEqual({ goal: "fix" });
  });

  it("preserves complete events when the final line is truncated", async () => {
    await appendRunEvent(runDir, { type: "run_started", runId: "run-1" });
    await appendFile(join(runDir, "events.jsonl"), '{"type":"broken"', "utf-8");

    const events = await readRunEvents(runDir);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("run_started");
  });

  it("serializes concurrent appends without corrupting the timeline", async () => {
    await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        appendRunEvent(runDir, {
          type: "log",
          runId: "run-1",
          data: { index },
        }),
      ),
    );

    const raw = await readFile(join(runDir, "events.jsonl"), "utf-8");
    expect(raw.trim().split(/\r?\n/)).toHaveLength(30);
    const events = await readRunEvents(runDir);
    expect(events).toHaveLength(30);
    expect(new Set(events.map((event) => event.sequence)).size).toBe(30);
  });

  it("supports incremental reads after a known sequence", async () => {
    for (let index = 0; index < 5; index += 1) {
      await appendRunEvent(runDir, { type: "log", runId: "run-1", data: { index } });
    }

    const events = await readRunEvents(runDir, { after: 2, limit: 2 });
    expect(events.map((event) => event.sequence)).toEqual([3, 4]);
  });
});
