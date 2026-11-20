import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(path.join(process.cwd(), "client", "src", file), "utf8");

describe("desktop workbench copy", () => {
  it("calls the desktop home entry 工作台 and leaves out the running-task explainer", () => {
    const sidebar = read("Sidebar.tsx");
    const app = read("App.tsx");
    expect(sidebar).toContain('<span className="bar-label">工作台</span>');
    expect(sidebar).toContain('aria-label={`工作台，${busyCount} 个运行中或有新回复的会话`}');
    expect(app).not.toContain("运行中的任务");
    expect(app).not.toContain("左侧按 AI 工具列出了正在回复的会话");
  });

  it("does not append Codex reasoning effort to the model shown beside the input", () => {
    expect(read("ModelChip.tsx")).toContain("const label = name;");
  });
});
