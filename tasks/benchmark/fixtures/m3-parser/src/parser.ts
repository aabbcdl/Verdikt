/**
 * Simple key-value parser.
 * Bug 1: doesn't trim values
 * Bug 2: doesn't handle quoted values
 * Bug 3: treats # as comment even inside quoted strings
 */
export function parse(input: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of input.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1); // Bug: no trim
    // Bug: strips comments inside quotes
    const commentIdx = value.indexOf("#");
    if (commentIdx !== -1) value = value.slice(0, commentIdx);
    result[key] = value;
  }
  return result;
}
