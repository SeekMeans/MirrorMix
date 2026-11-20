import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { markdownPage, markdownTitle } from "../src/server/markdownPage";
import { htmlFileAt } from "../src/server/preview";
import { cleanPickedFile } from "../src/settings/previewPicks";

describe("Markdown in the browser preview", () => {
  it("renders a Markdown file as a page to read, without running raw HTML in it", () => {
    const html = markdownPage("# 设计说明\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n<script>alert(1)</script>\n\n![图](img/a.png)", "README.md");
    expect(html).toContain("<title>设计说明</title>");
    expect(html).toContain("<h1>设计说明</h1>");
    expect(html).toContain("<table>");
    expect(html).toContain('src="img/a.png"');
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("titles it by its first heading, or by its name", () => {
    expect(markdownTitle("intro\n\n## not this\n# 计划\n")).toBe("计划");
    expect(markdownPage("no heading here", "notes.md")).toContain("<title>notes.md</title>");
  });

  it("can be kept in a project's browser list", () => {
    expect(cleanPickedFile("docs/plan.md")).toBe("docs/plan.md");
    expect(cleanPickedFile("README.markdown")).toBe("README.markdown");
    expect(cleanPickedFile("src/app.ts")).toBeNull();
    const root = mkdtempSync(path.join(os.tmpdir(), "mm-md-"));
    writeFileSync(path.join(root, "plan.md"), "# 发布计划\n\n内容");
    expect(htmlFileAt(root, "plan.md")).toMatchObject({ path: "plan.md", title: "发布计划" });
  });
});
