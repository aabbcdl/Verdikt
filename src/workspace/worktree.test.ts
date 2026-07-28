import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureIterationDiff,
  checkpointIteration,
  createRunWorktree,
  discardRun,
  getHeadCommit,
} from "./worktree.js";

// Mock child_process
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

// Mock fs/promises
vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn(),
  rm: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

// Mock fs (for createWriteStream)
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    createWriteStream: vi.fn(() => {
      let finishHandler: (() => void) | undefined;
      const stream = {
        end: vi.fn(() => {
          finishHandler?.();
        }),
        on: vi.fn((event: string, handler: unknown) => {
          if (event === "finish") finishHandler = handler as () => void;
          return stream;
        }),
        write: vi.fn(),
      };
      return stream;
    }),
  };
});

describe("Worktree operations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("getHeadCommit", () => {
    it("returns trimmed commit hash", async () => {
      const { execFile } = await import("node:child_process");

      (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (
          _cmd: string,
          _args: string[],
          _opts: unknown,
          cb: (err: null, stdout: string) => void,
        ) => {
          cb(null, "abc123def456\n");
        },
      );

      const hash = await getHeadCommit("/repo");
      expect(hash).toBe("abc123def456");
    });

    it("rejects on git error", async () => {
      const { execFile } = await import("node:child_process");

      (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (
          _cmd: string,
          _args: string[],
          _opts: unknown,
          cb: (err: Error, stdout: string, stderr: string) => void,
        ) => {
          cb(new Error("not a git repo"), "", "fatal: not a git repository");
        },
      );

      await expect(getHeadCommit("/not-repo")).rejects.toThrow("not a git repo");
    });
  });

  describe("createRunWorktree", () => {
    it("creates worktree and returns info", async () => {
      const { execFile } = await import("node:child_process");

      (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (_cmd: string, args: string[], _opts: unknown, cb: (err: null, stdout: string) => void) => {
          if (args[0] === "rev-parse") cb(null, "abc123\n");
          else cb(null, "");
        },
      );

      const info = await createRunWorktree("/repo", "/run-dir", "run-001");

      expect(info.worktreePath).toContain("workspace");
      expect(info.branchName).toBe("verdikt/run-001");
      expect(info.baseCommit).toBe("abc123");
      expect(info.evidenceDir).toContain("evidence");
    });

    it("cleans up a partially created worktree when checkout fails", async () => {
      const { execFile } = await import("node:child_process");
      const { rm } = await import("node:fs/promises");
      (rm as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      const calls: string[][] = [];
      (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (
          _cmd: string,
          args: string[],
          _opts: unknown,
          cb: (err: Error | null, stdout: string, stderr: string) => void,
        ) => {
          calls.push(args);
          if (args[0] === "rev-parse") {
            cb(null, "abc123\n", "");
            return;
          }
          if (args[0] === "worktree" && args[1] === "add") {
            cb(null, "", "");
            return;
          }
          if (args[0] === "checkout") {
            cb(new Error("checkout failed"), "", "fatal checkout failed");
            return;
          }
          if (args[0] === "worktree" && args[1] === "remove") {
            cb(null, "", "");
            return;
          }
          cb(null, "", "");
        },
      );

      await expect(createRunWorktree("/repo", "/run-dir", "run-001")).rejects.toThrow(
        "checkout failed",
      );

      expect(calls.some((args) => args[0] === "worktree" && args[1] === "remove")).toBe(true);
      expect(rm).toHaveBeenCalledWith(expect.stringContaining("workspace"), {
        recursive: true,
        force: true,
      });
    });
  });

  describe("captureIterationDiff", () => {
    it("generates patch file with changed files", async () => {
      const { execFile, spawn } = await import("node:child_process");

      // Mock git diff --name-only
      (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (_cmd: string, args: string[], _opts: unknown, cb: (err: null, stdout: string) => void) => {
          if (args.includes("--name-only")) {
            cb(null, "src/app.ts\nsrc/utils.ts\n");
          } else if (args.includes("--numstat")) {
            cb(null, "10\t5\tsrc/app.ts\n3\t2\tsrc/utils.ts\n");
          } else if (args[0] === "ls-files") {
            cb(null, "");
          }
        },
      );

      // Mock spawn for diff streaming
      const mockChild = {
        stdout: { pipe: vi.fn() },
        on: vi.fn(),
      };
      (spawn as ReturnType<typeof vi.fn>).mockReturnValue(mockChild);

      // Simulate spawn close
      (mockChild.on as ReturnType<typeof vi.fn>).mockImplementation(
        (event: string, handler: unknown) => {
          if (event === "close") (handler as (code: number) => void)(0);
        },
      );

      const result = await captureIterationDiff("/worktree", "/evidence", 0, "abc123");

      expect(result.changedFiles).toContain("src/app.ts");
      expect(result.changedFiles).toContain("src/utils.ts");
      expect(result.linesAdded).toBe(13);
      expect(result.linesDeleted).toBe(7);
      expect(result.patchPath).toContain("iteration-0.patch");
    });

    it("marks untracked files for diff capture before writing the patch", async () => {
      const { execFile, spawn } = await import("node:child_process");

      const calls: string[][] = [];
      (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (_cmd: string, args: string[], _opts: unknown, cb: (err: null, stdout: string) => void) => {
          calls.push(args);
          if (args.includes("--name-only")) {
            cb(null, "");
          } else if (args[0] === "ls-files") {
            cb(null, "src/new-risk.ts\n");
          } else if (args[0] === "add" && args[1] === "-N") {
            cb(null, "");
          } else if (args.includes("--numstat")) {
            cb(null, "1\t0\tsrc/new-risk.ts\n");
          }
        },
      );

      const mockChild = {
        stdout: { pipe: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn(),
      };
      (spawn as ReturnType<typeof vi.fn>).mockReturnValue(mockChild);
      (mockChild.on as ReturnType<typeof vi.fn>).mockImplementation(
        (event: string, handler: unknown) => {
          if (event === "close") (handler as (code: number) => void)(0);
        },
      );

      const result = await captureIterationDiff("/worktree", "/evidence", 0, "abc123");

      expect(result.changedFiles).toEqual(["src/new-risk.ts"]);
      expect(calls).toContainEqual(["add", "-N", "--", "src/new-risk.ts"]);
    });

    it("rejects when patch evidence cannot be written", async () => {
      const { execFile, spawn } = await import("node:child_process");

      (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (_cmd: string, args: string[], _opts: unknown, cb: (err: null, stdout: string) => void) => {
          if (args.includes("--name-only")) {
            cb(null, "src/app.ts\n");
          } else if (args.includes("--numstat")) {
            cb(null, "1\t1\tsrc/app.ts\n");
          } else if (args[0] === "ls-files") {
            cb(null, "");
          }
        },
      );

      const mockChild = {
        stdout: { pipe: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn(),
      };
      (spawn as ReturnType<typeof vi.fn>).mockReturnValue(mockChild);

      (mockChild.stderr.on as ReturnType<typeof vi.fn>).mockImplementation(
        (event: string, handler: unknown) => {
          if (event === "data") (handler as (chunk: Buffer) => void)(Buffer.from("fatal diff"));
        },
      );
      (mockChild.on as ReturnType<typeof vi.fn>).mockImplementation(
        (event: string, handler: unknown) => {
          if (event === "close") (handler as (code: number) => void)(2);
        },
      );

      await expect(captureIterationDiff("/worktree", "/evidence", 0, "abc123")).rejects.toThrow(
        "git diff abc123 failed",
      );
    });

    it("waits for the patch file stream to finish before returning", async () => {
      const { execFile, spawn } = await import("node:child_process");
      const { createWriteStream } = await import("node:fs");

      (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (_cmd: string, args: string[], _opts: unknown, cb: (err: null, stdout: string) => void) => {
          if (args.includes("--name-only")) {
            cb(null, "src/app.ts\n");
          } else if (args.includes("--numstat")) {
            cb(null, "1\t0\tsrc/app.ts\n");
          } else if (args[0] === "ls-files") {
            cb(null, "");
          }
        },
      );

      let closeHandler: ((code: number) => void) | undefined;
      const mockChild = {
        stdout: { pipe: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event: string, handler: unknown) => {
          if (event === "close") closeHandler = handler as (code: number) => void;
        }),
      };
      (spawn as ReturnType<typeof vi.fn>).mockReturnValue(mockChild);

      let finishHandler: (() => void) | undefined;
      const mockStream = {
        end: vi.fn(),
        on: vi.fn((event: string, handler: unknown) => {
          if (event === "finish") finishHandler = handler as () => void;
          return mockStream;
        }),
        write: vi.fn(),
      };
      (createWriteStream as ReturnType<typeof vi.fn>).mockReturnValue(mockStream);

      let resolved = false;
      const resultPromise = captureIterationDiff("/worktree", "/evidence", 0, "abc123").then(() => {
        resolved = true;
      });

      await vi.waitFor(() => {
        expect(closeHandler).toBeTypeOf("function");
      });
      closeHandler?.(0);
      await Promise.resolve();
      await new Promise((resolveTick) => setTimeout(resolveTick, 0));
      expect(resolved).toBe(false);

      finishHandler?.();
      await resultPromise;
      expect(resolved).toBe(true);
    });
  });

  describe("checkpointIteration", () => {
    it("disables git signing for internal checkpoint commits", async () => {
      const { execFile } = await import("node:child_process");
      const calls: string[][] = [];

      (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (_cmd: string, args: string[], _opts: unknown, cb: (err: null, stdout: string) => void) => {
          calls.push(args);
          if (args[0] === "status") {
            cb(null, " M src/app.ts\n");
            return;
          }
          if (args[0] === "rev-parse") {
            cb(null, "def456\n");
            return;
          }
          cb(null, "");
        },
      );

      await checkpointIteration("/worktree", 2);

      const commitCall = calls.find((args) => args[0] === "commit");
      expect(commitCall).toEqual(expect.arrayContaining(["--no-gpg-sign"]));
    });
  });

  describe("discardRun", () => {
    it("removes worktree and deletes branch", async () => {
      const { execFile } = await import("node:child_process");

      (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (_cmd: string, args: string[], _opts: unknown, cb: (err: null, stdout: string) => void) => {
          if (args[0] === "worktree" && args[1] === "remove") {
            cb(null, "");
          } else if (args[0] === "branch" && args[1] === "-D") {
            cb(null, "");
          }
        },
      );

      await discardRun("/repo", "/worktree", "verdikt/run-001");

      // Verify git worktree remove was called
      expect(execFile).toHaveBeenCalledWith(
        "git",
        expect.arrayContaining(["worktree", "remove"]),
        expect.any(Object),
        expect.any(Function),
      );

      // Verify git branch -D was called
      expect(execFile).toHaveBeenCalledWith(
        "git",
        expect.arrayContaining(["branch", "-D"]),
        expect.any(Object),
        expect.any(Function),
      );
    });

    it("handles worktree remove failure gracefully", async () => {
      const { execFile } = await import("node:child_process");

      (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (
          _cmd: string,
          args: string[],
          _opts: unknown,
          cb: (err: Error | null, stdout: string) => void,
        ) => {
          if (args[0] === "worktree" && args[1] === "remove") {
            cb(new Error("worktree not found"), "");
          } else if (args[0] === "worktree" && args[1] === "prune") {
            cb(null, "");
          } else if (args[0] === "branch" && args[1] === "-D") {
            cb(null, "");
          }
        },
      );

      // Should not throw
      await expect(discardRun("/repo", "/worktree", "verdikt/run-001")).resolves.not.toThrow();
    });
  });

  // writeFinalPatch is covered by real-git integration tests in
  // worktree.integration.test.ts — the previous mocked placeholder here
  // asserted nothing and was removed.
});
