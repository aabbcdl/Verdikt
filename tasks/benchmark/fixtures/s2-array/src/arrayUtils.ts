/** Find max value. Bug: returns 0 for negative-only arrays. */
export function findMax(arr: number[]): number {
  if (arr.length === 0) throw new Error("Empty array");
  let max = 0; // Bug: should be arr[0] or -Infinity
  for (const n of arr) {
    if (n > max) max = n;
  }
  return max;
}

/** Chunk array into groups. Bug: drops last incomplete chunk. */
export function chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    const group = arr.slice(i, i + size);
    if (group.length === size) result.push(group); // Bug: drops incomplete
  }
  return result;
}
