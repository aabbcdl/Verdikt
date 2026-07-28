import { join } from "node:path";
import { readJsonFile, writeJsonAtomic } from "./atomicJson.js";

export interface RunNote {
  id: string;
  text: string;
  source: string;
  queuedAt: string;
  consumedAt?: string;
  iteration?: number;
}

export interface RunNotesState {
  version: 1;
  queued: RunNote[];
  history: RunNote[];
}

const queues = new Map<string, Promise<unknown>>();

export async function readRunNotes(runDir: string): Promise<RunNotesState> {
  const loaded = await readJsonFile<RunNotesState>(notesPath(runDir));
  return loaded?.version === 1
    ? {
        version: 1,
        queued: Array.isArray(loaded.queued) ? loaded.queued : [],
        history: Array.isArray(loaded.history) ? loaded.history : [],
      }
    : { version: 1, queued: [], history: [] };
}

export async function queueRunNote(
  runDir: string,
  text: string,
  source = "user",
): Promise<RunNote> {
  const normalized = text.trim();
  if (!normalized) throw new Error("Run note must not be empty");
  if (normalized.length > 5000) throw new Error("Run note is too long (maximum 5000 characters)");
  return updateNotes(runDir, async (state) => {
    const note: RunNote = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      text: normalized,
      source,
      queuedAt: new Date().toISOString(),
    };
    return [{ ...state, queued: [...state.queued, note] }, note];
  });
}

export async function consumeQueuedNotes(runDir: string, iteration: number): Promise<RunNote[]> {
  return updateNotes(runDir, async (state) => {
    if (state.queued.length === 0) return [state, []];
    const consumedAt = new Date().toISOString();
    const consumed = state.queued.map((note) => ({ ...note, consumedAt, iteration }));
    return [
      { ...state, queued: [], history: [...state.history, ...consumed].slice(-200) },
      consumed,
    ];
  });
}

async function updateNotes<T>(
  runDir: string,
  mutate: (state: RunNotesState) => Promise<[RunNotesState, T]>,
): Promise<T> {
  const path = notesPath(runDir);
  const previous = queues.get(path) ?? Promise.resolve();
  let result: T | undefined;
  const current = previous
    .catch(() => undefined)
    .then(async () => {
      const [next, value] = await mutate(await readRunNotes(runDir));
      await writeJsonAtomic(path, next, { backup: true });
      result = value;
    });
  queues.set(path, current);
  try {
    await current;
  } finally {
    if (queues.get(path) === current) queues.delete(path);
  }
  return result as T;
}

function notesPath(runDir: string): string {
  return join(runDir, "notes.json");
}
