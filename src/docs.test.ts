import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function walkFiles(dir: string, extensions: string[], skipDirs: Set<string>): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (skipDirs.has(entry)) continue;
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      files.push(...walkFiles(fullPath, extensions, skipDirs));
    } else if (extensions.some((ext) => entry.endsWith(ext))) {
      files.push(fullPath);
    }
  }
  return files;
}

const mojibakePattern = /[鎺閹禒嬫粍顒]/;

describe("user-facing documentation", () => {
  it("keeps README focused on the first successful demo path", () => {
    const readme = readFileSync("README.md", "utf-8");

    expect(readme).toContain("第一次打开推荐流程");
    expect(readme).toContain("填入示例");
    expect(readme).toContain("默认不会改原项目");
    expect(readme).toContain("任务工作台");
    expect(readme).toContain("查看修改");
    expect(readme).toContain("双 agent 视图");
    expect(readme).toContain("pnpm app");
    expect(readme).not.toMatch(mojibakePattern);
  });

  it("keeps the usage guide readable and practical for new users", () => {
    const guide = readFileSync("USAGE_GUIDE.md", "utf-8");

    expect(guide).toContain("快速跑通示例");
    expect(guide).toContain("应用或丢弃");
    expect(guide).toContain("任务节点");
    expect(guide).toContain("继续运行");
    expect(guide).toContain("重新运行");
    expect(guide).toContain("一键脚本");
    expect(guide).toContain("常见问题");
    expect(guide).not.toMatch(mojibakePattern);
  });

  it("keeps user-facing source strings free of encoding damage", () => {
    // A past encoding accident turned whole Chinese UI strings into runs of
    // "?" (see buildResumableAdvice). Guard source and UI files against both
    // the Unicode replacement character and long ? runs inside string text.
    const skipDirs = new Set(["node_modules", "dist", ".git", ".verdikt", "coverage"]);
    const sources = [
      ...walkFiles("src", [".ts"], skipDirs).filter((file) => !file.endsWith(".test.ts")),
      ...walkFiles(join("apps", "ui"), [".html"], skipDirs),
    ];
    expect(sources.length).toBeGreaterThan(50);

    const offenders: string[] = [];
    for (const file of sources) {
      const content = readFileSync(file, "utf-8");
      if (content.includes("�") || /["'`][^"'`\n]*\?{4,}[^"'`\n]*["'`]/.test(content)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
