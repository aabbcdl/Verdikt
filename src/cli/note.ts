import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { getConfig } from "../config.js";
import { appendRunEvent } from "../trace/events.js";
import { queueRunNote } from "../trace/notes.js";
import { isPathInside, isValidRunId } from "./localServer.js";
import { parseArgs } from "./parseArgs.js";

export async function addRunNote(runId: string, text: string, source = "cli") {
  const stateDir = resolve(getConfig().stateDir);
  const runDir = resolve(stateDir, runId);
  if (!isValidRunId(runId) || !isPathInside(stateDir, runDir) || !existsSync(runDir)) {
    throw new Error("Run not found or invalid run ID");
  }
  const note = await queueRunNote(runDir, text, source);
  await appendRunEvent(runDir, {
    type: "note_queued",
    runId,
    data: { id: note.id, text: note.text, source: note.source },
  });
  return note;
}

export async function handleNote(args: string[]): Promise<void> {
  const { positional } = parseArgs(args, {
    positional: { min: 2, names: ["run-id", "message"] },
  });
  const runId = positional[0];
  const text = positional.slice(1).join(" ").trim();
  if (!runId || !text) throw new Error('Usage: verdikt note <run-id> "<message>"');
  const note = await addRunNote(runId, text);
  console.log(`Queued note ${note.id} for the next safe iteration boundary.`);
}
