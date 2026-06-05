import { describe, expect, it } from "vitest";
import { isPalindrome, reverse } from "../src/utils.js";

describe("reverse", () => {
  it("reverses a simple string", () => expect(reverse("hello")).toBe("olleh"));
  it("handles empty string", () => expect(reverse("")).toBe(""));
  it("handles single char", () => expect(reverse("a")).toBe("a"));
});

describe("isPalindrome", () => {
  it("detects palindrome ignoring case", () => expect(isPalindrome("Racecar")).toBe(true));
  it("detects non-palindrome", () => expect(isPalindrome("hello")).toBe(false));
  it("handles spaces and punctuation", () =>
    expect(isPalindrome("A man, a plan, a canal: Panama")).toBe(true));
});
