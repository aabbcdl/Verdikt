/** Reverse a string. Bug: doesn't handle empty string correctly. */
export function reverse(s: string): string {
  if (s === "") return s; // This is fine
  return s.split("").reverse().join("");
}

/** Check if a string is a palindrome. Bug: case-sensitive comparison. */
export function isPalindrome(s: string): boolean {
  const cleaned = s.toLowerCase().replace(/[^a-z0-9]/g, "");
  return cleaned === reverse(cleaned); // Bug: reverse doesn't lowercase
}
