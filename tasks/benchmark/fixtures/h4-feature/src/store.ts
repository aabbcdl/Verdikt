/**
 * Simple key-value store — needs a "batch" feature added.
 * Current API: get, set, delete, has, keys
 * Missing: batch get, batch set, batch delete
 * The task asks to add batch operations and export them.
 */

export class KVStore {
  private data = new Map<string, string>();

  get(key: string): string | undefined { return this.data.get(key); }
  set(key: string, value: string): void { this.data.set(key, value); }
  delete(key: string): boolean { return this.data.delete(key); }
  has(key: string): boolean { return this.data.has(key); }
  keys(): string[] { return [...this.data.keys()]; }
  clear(): void { this.data.clear(); }
  size(): number { return this.data.size; }

  // TODO: implement batchGet, batchSet, batchDelete
}

export function createStore(): KVStore {
  return new KVStore();
}
