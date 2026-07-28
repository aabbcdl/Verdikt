import { describe, expect, it } from "vitest";
import { getFlag, hasFlag, parseArgs } from "./parseArgs.js";

describe("parseArgs", () => {
  describe("positional arguments", () => {
    it("collects positional arguments", () => {
      const result = parseArgs(["run", "--task", "file.json"], {
        required: ["task"],
      });
      expect(result.positional).toEqual(["run"]);
    });

    it("validates minimum positional count", () => {
      expect(() =>
        parseArgs([], {
          positional: { min: 1 },
        }),
      ).toThrow("Expected at least 1 positional arguments");
    });

    it("validates maximum positional count", () => {
      expect(() =>
        parseArgs(["a", "b", "c"], {
          positional: { max: 2 },
        }),
      ).toThrow("Expected at most 2 positional arguments");
    });
  });

  describe("required flags", () => {
    it("parses required flag with value", () => {
      const result = parseArgs(["--task", "file.json"], {
        required: ["task"],
      });
      expect(result.flags.get("task")).toBe("file.json");
    });

    it("throws when required flag is missing", () => {
      expect(() =>
        parseArgs([], {
          required: ["task"],
        }),
      ).toThrow("Missing required flag: --task");
    });

    it("throws when required flag has no value", () => {
      expect(() =>
        parseArgs(["--task"], {
          required: ["task"],
        }),
      ).toThrow("Flag --task requires a value");
    });

    it("throws when required flag value is another flag", () => {
      expect(() =>
        parseArgs(["--task", "--other"], {
          required: ["task"],
        }),
      ).toThrow("Flag --task requires a value");
    });
  });

  describe("optional flags", () => {
    it("parses optional flag with value", () => {
      const result = parseArgs(["--out", "/tmp/output"], {
        optional: ["out"],
      });
      expect(result.flags.get("out")).toBe("/tmp/output");
    });

    it("parses inline flag values", () => {
      const result = parseArgs(["--out=/tmp/output"], {
        optional: ["out"],
      });
      expect(result.flags.get("out")).toBe("/tmp/output");
    });

    it("does not throw when optional flag is missing", () => {
      expect(() =>
        parseArgs([], {
          optional: ["out"],
        }),
      ).not.toThrow();
    });

    it("throws when optional flag has no value", () => {
      expect(() =>
        parseArgs(["--out"], {
          optional: ["out"],
        }),
      ).toThrow("Flag --out requires a value");
    });
  });

  describe("boolean flags", () => {
    it("parses boolean flag", () => {
      const result = parseArgs(["--json"], {
        boolean: ["json"],
      });
      expect(result.flags.get("json")).toBe(true);
    });

    it("does not throw when boolean flag is missing", () => {
      const result = parseArgs([], {
        boolean: ["json"],
      });
      expect(result.flags.has("json")).toBe(false);
    });

    it("rejects values attached to boolean flags", () => {
      expect(() => parseArgs(["--json=false"], { boolean: ["json"] })).toThrow(
        "Flag --json does not take a value",
      );
    });
  });

  describe("unknown flags", () => {
    it("throws on unknown flag", () => {
      expect(() =>
        parseArgs(["--unknown"], {
          required: ["task"],
        }),
      ).toThrow("Unknown flag: --unknown");
    });

    it("lists known flags in error message", () => {
      expect(() =>
        parseArgs(["--unknown"], {
          required: ["task"],
          boolean: ["json"],
        }),
      ).toThrow("--task, --json");
    });

    it("rejects unknown short flags", () => {
      expect(() => parseArgs(["-x"], { boolean: ["json"] })).toThrow("Unknown flag: -x");
    });
  });

  describe("mixed arguments", () => {
    it("handles complex argument combinations", () => {
      const result = parseArgs(["run", "--task", "file.json", "--json", "--out", "/tmp"], {
        required: ["task"],
        optional: ["out"],
        boolean: ["json"],
      });

      expect(result.positional).toEqual(["run"]);
      expect(result.flags.get("task")).toBe("file.json");
      expect(result.flags.get("json")).toBe(true);
      expect(result.flags.get("out")).toBe("/tmp");
    });
  });
});

describe("getFlag", () => {
  it("returns flag value when present", () => {
    const parsed = parseArgs(["--task", "file.json"], { required: ["task"] });
    expect(getFlag(parsed, "task", "default")).toBe("file.json");
  });

  it("returns default when flag is missing", () => {
    const parsed = parseArgs([], {});
    expect(getFlag(parsed, "task", "default")).toBe("default");
  });
});

describe("hasFlag", () => {
  it("returns true when boolean flag is set", () => {
    const parsed = parseArgs(["--json"], { boolean: ["json"] });
    expect(hasFlag(parsed, "json")).toBe(true);
  });

  it("returns false when boolean flag is not set", () => {
    const parsed = parseArgs([], {});
    expect(hasFlag(parsed, "json")).toBe(false);
  });
});
