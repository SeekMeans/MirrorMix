import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { slashCommands } from "../src/catalog/slashCommands";

describe("the slash menu's commands", () => {
  it("lists a Claude project's commands and skills, the user's, then the built-in ones", () => {
    const root = mkdtempSync(path.join(tmpdir(), "aimiss-slash-"));
    const home = path.join(root, "home");
    const cwd = path.join(root, "work");
    mkdirSync(path.join(cwd, ".claude", "commands", "deploy"), { recursive: true });
    writeFileSync(path.join(cwd, ".claude", "commands", "deploy", "ship.md"), "---\ndescription: 发布到测试环境\n---\n步骤……");
    writeFileSync(path.join(cwd, ".claude", "commands", "review.md"), "# 按团队规范审查\n内容");
    mkdirSync(path.join(home, ".claude", "skills", "de-ai-writing"), { recursive: true });
    writeFileSync(path.join(home, ".claude", "skills", "de-ai-writing", "SKILL.md"), "---\nname: de-ai-writing\ndescription: 去除 AI 味\n---\n");

    const commands = slashCommands("claude", cwd, home);
    expect(commands.slice(0, 3)).toEqual([
      { name: "ship", description: "发布到测试环境", source: "project" },
      { name: "review", description: "按团队规范审查", source: "project" },
      { name: "de-ai-writing", description: "去除 AI 味", source: "skill" },
    ]);
    // The project's own /review wins over the built-in one of the same name.
    expect(commands.filter((command) => command.name === "review")).toHaveLength(1);
    expect(commands.some((command) => command.name === "compact" && command.source === "builtin")).toBe(true);
  });

  it("names Codex's saved prompts the way Codex calls them", () => {
    const root = mkdtempSync(path.join(tmpdir(), "aimiss-slash-codex-"));
    mkdirSync(path.join(root, ".codex", "prompts"), { recursive: true });
    writeFileSync(path.join(root, ".codex", "prompts", "fix-tests.md"), "修好失败的测试");
    const commands = slashCommands("codex", root, root);
    expect(commands[0]).toEqual({ name: "prompts:fix-tests", description: "修好失败的测试", source: "user" });
    expect(commands.some((command) => command.name === "new")).toBe(true);
  });

  it("works without any command folders", () => {
    expect(slashCommands("cursor", "", "")).toEqual([]);
    expect(slashCommands("claude", "", "").length).toBeGreaterThan(0);
  });

  it("lists the skills and commands of Claude Code plugins that are switched on, as plugin:name", () => {
    const home = mkdtempSync(path.join(tmpdir(), "aimiss-slash-plugins-"));
    const on = path.join(home, ".claude", "plugins", "cache", "market", "frontend-design", "1.1.1");
    const off = path.join(home, ".claude", "plugins", "cache", "market", "other", "1.0.0");
    for (const dir of [on, off]) {
      mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
      mkdirSync(path.join(dir, "skills", "main"), { recursive: true });
      mkdirSync(path.join(dir, "commands"), { recursive: true });
    }
    writeFileSync(path.join(on, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "frontend-design" }));
    writeFileSync(path.join(on, "skills", "main", "SKILL.md"), "---\nname: frontend-design\ndescription: Distinctive UI\n---\n");
    writeFileSync(path.join(on, "commands", "polish.md"), "---\ndescription: Polish the page\n---\n");
    writeFileSync(path.join(off, "skills", "main", "SKILL.md"), "---\nname: hidden\n---\n");
    writeFileSync(
      path.join(home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "frontend-design@market": [{ installPath: on }], "other@market": [{ installPath: off }] } }),
    );
    writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "frontend-design@market": true, "other@market": false } }));
    const names = slashCommands("claude", "", home).map((command) => command.name);
    expect(names).toContain("frontend-design:frontend-design");
    expect(names).toContain("frontend-design:polish");
    expect(names.some((name) => name.startsWith("other:"))).toBe(false);
    expect(slashCommands("claude", "", home).find((command) => command.name === "frontend-design:frontend-design")?.description).toBe("Distinctive UI");
  });

  it("adds the desktop app's own skills, newest copy, only for a session in the app", () => {
    const home = mkdtempSync(path.join(tmpdir(), "aimiss-slash-home-"));
    const data = mkdtempSync(path.join(tmpdir(), "aimiss-slash-desktop-"));
    const bundle = (org: string, skill: string) => {
      const dir = path.join(data, "account", "local-agent-mode-sessions", "skills-plugin", org, "bundle");
      mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
      mkdirSync(path.join(dir, "skills", skill), { recursive: true });
      writeFileSync(path.join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "anthropic-skills" }));
      writeFileSync(path.join(dir, "skills", skill, "SKILL.md"), `---\nname: ${skill}\n---\n`);
      return dir;
    };
    bundle("old-org", "old-only");
    const fresh = bundle("new-org", "docx");
    // The newer copy is the one the app uses.
    const later = new Date(Date.now() + 60_000);
    require("node:fs").utimesSync(fresh, later, later);
    expect(slashCommands("claude", "", home, { desktop: false, claudeDataDir: data }).some((command) => command.name.startsWith("anthropic-skills:"))).toBe(false);
    const names = slashCommands("claude", "", home, { desktop: true, claudeDataDir: data }).map((command) => command.name);
    expect(names).toContain("anthropic-skills:docx");
    expect(names).not.toContain("anthropic-skills:old-only");
  });
});
