import { describe, expect, it } from "vitest";
import { connectedTaskFindings, readConnectedRuntimeOutput } from "./connectedTask.js";

describe("connected release task gate", () => {
  it("accepts only an adoptable objectively verified result", () => {
    expect(
      connectedTaskFindings({
        stopReason: "passed",
        verdictStatus: "pass",
        recommendation: "accept_change",
        requiredPassed: 1,
        requiredTotal: 1,
        patchFilesChanged: 1,
        patchContainsExpectedChange: true,
      }),
    ).toEqual([]);
  });

  it("rejects a provider stop even if partial work exists", () => {
    expect(
      connectedTaskFindings({
        stopReason: "provider_error",
        verdictStatus: "incomplete",
        recommendation: "continue_fixing",
        requiredPassed: 0,
        requiredTotal: 1,
        patchFilesChanged: 1,
        patchContainsExpectedChange: true,
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("stopReason"),
        expect.stringContaining("verdict"),
      ]),
    );
  });

  it("reports no runtime output after a failed workspace has been discarded", async () => {
    await expect(
      readConnectedRuntimeOutput("Z:\\verdikt-missing-connected-workspace"),
    ).resolves.toBe("");
  });
});
