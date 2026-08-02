import { describe, expect, it } from "vitest";
import { folderPickerInvocation } from "./folderPicker.js";

describe("folder picker", () => {
  it("uses a native folder dialog on Windows", () => {
    const invocation = folderPickerInvocation("win32");

    expect(invocation?.command).toBe("powershell.exe");
    expect(invocation?.args).toContain("-STA");
    expect(invocation?.args.join(" ")).toContain("FolderBrowserDialog");
  });

  it("uses platform folder pickers without interpolating user input", () => {
    expect(folderPickerInvocation("darwin")?.command).toBe("osascript");
    expect(folderPickerInvocation("linux")?.command).toBe("zenity");
    expect(folderPickerInvocation("aix")).toBeNull();
  });
});
