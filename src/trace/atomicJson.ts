import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface AtomicWriteOptions {
  backup?: boolean;
}

export async function writeJsonAtomic(
  filePath: string,
  value: unknown,
  options: AtomicWriteOptions = {},
): Promise<void> {
  await writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, options);
}

export async function writeTextAtomic(
  filePath: string,
  content: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  try {
    if (options.backup) {
      await copyFile(filePath, `${filePath}.bak`).catch(() => undefined);
    }
    await writeFile(tempPath, content, "utf-8");
    await renameWithRetry(tempPath, filePath);
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

async function renameWithRetry(source: string, destination: string): Promise<void> {
  const retryableCodes = new Set(["EACCES", "EBUSY", "EPERM"]);
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
      if (!retryableCodes.has(code) || attempt >= 40) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(100, 5 + attempt * 5)));
    }
  }
}
