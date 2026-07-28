import { describe, expect, it } from "vitest";
import { createActionSignature, evaluateCommandPolicy } from "./commandPolicy.js";

describe("runtime command policy", () => {
  it("allows ordinary repository-local development commands", () => {
    expect(evaluateCommandPolicy("pnpm test", "D:/repo", [])).toEqual(
      expect.objectContaining({ allowed: true, categories: [] }),
    );
  });

  it("blocks destructive, deployment, and external write commands before approval", () => {
    expect(evaluateCommandPolicy("rm -rf dist", "/repo", []).categories).toContain("destructive");
    expect(evaluateCommandPolicy("npm publish", "/repo", []).categories).toContain("deployment");
    expect(evaluateCommandPolicy("git push origin main", "/repo", []).categories).toContain(
      "external_write",
    );
    expect(evaluateCommandPolicy("git push origin main", "/repo", []).allowed).toBe(false);
  });

  it("requires an exact action grant even after a broad category is approved", () => {
    const command = "npm publish";
    const signature = createActionSignature(command, "/repo");
    expect(evaluateCommandPolicy(command, "/repo", ["deployment"]).allowed).toBe(false);
    expect(
      evaluateCommandPolicy(command, "/repo", ["deployment"], false, [signature]).allowed,
    ).toBe(true);
    expect(evaluateCommandPolicy("npm publish && git push", "/repo", ["deployment"]).allowed).toBe(
      false,
    );
  });

  it("blocks commands that escape the repository", () => {
    const result = evaluateCommandPolicy("cat ../secrets.txt", "/repo", []);
    expect(result.allowed).toBe(false);
    expect(result.categories).toContain("outside_repo");
  });

  it("does not let broad allow mode bypass exact approval for dangerous actions", () => {
    const command = "rm -rf /tmp/demo";
    const signature = createActionSignature(command, "/repo");
    expect(evaluateCommandPolicy(command, "/repo", [], true).allowed).toBe(false);
    expect(evaluateCommandPolicy(command, "/repo", [], true, [signature]).allowed).toBe(true);
  });

  it("normalizes whitespace into a stable exact-action signature", () => {
    expect(createActionSignature("git   push origin main", "/repo")).toBe(
      createActionSignature(" git push origin main ", "/repo"),
    );
  });
});
