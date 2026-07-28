import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readActionApprovalState } from "../approval/actionStore.js";
import { buildHookDecision, resolveHookDecision } from "./commandHook.js";
import { createActionSignature } from "./commandPolicy.js";

describe("Claude command policy hook", () => {
  it("denies an unapproved high-risk shell command", () => {
    expect(
      buildHookDecision(
        { tool_name: "Bash", tool_input: { command: "git push origin main" } },
        { repoRoot: "/repo", approvedCategories: [] },
      ),
    ).toEqual({
      hookSpecificOutput: expect.objectContaining({ permissionDecision: "deny" }),
    });
  });

  it("allows approved commands and ignores non-shell tools", () => {
    expect(
      buildHookDecision(
        { tool_name: "Bash", tool_input: { command: "npm publish" } },
        {
          repoRoot: "/repo",
          approvedCategories: ["deployment"],
          approvedActionSignatures: [createActionSignature("npm publish", "/repo")],
        },
      ),
    ).toEqual({
      hookSpecificOutput: expect.objectContaining({ permissionDecision: "allow" }),
    });
    expect(
      buildHookDecision(
        { tool_name: "Read", tool_input: { command: "rm -rf /" } },
        { repoRoot: "/repo", approvedCategories: [] },
      ),
    ).toEqual({});
  });
  it("records the exact blocked command for later user approval", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "verdikt-command-hook-"));
    try {
      const decision = await resolveHookDecision(
        { tool_name: "Bash", tool_input: { command: "git push origin main" } },
        { repoRoot: "/repo", approvedCategories: [], runDir },
      );
      expect(decision).toEqual({
        hookSpecificOutput: expect.objectContaining({ permissionDecision: "deny" }),
      });
      const state = await readActionApprovalState(runDir);
      expect(state.pending).toEqual(
        expect.objectContaining({ command: "git push origin main", tool: "Bash" }),
      );
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });
});
