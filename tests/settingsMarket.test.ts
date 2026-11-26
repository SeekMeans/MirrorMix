import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { ALL_TOOLS, type ToolId } from "../client/src/api";
import { setLanguage } from "../client/src/i18n";

let SettingsDialog: typeof import("../client/src/Settings").SettingsDialog;

beforeAll(async () => {
  Object.assign(globalThis, { self: globalThis });
  ({ SettingsDialog } = await import("../client/src/Settings"));
});

const settings = (variant: "dialog" | "page") => renderToStaticMarkup(
  createElement(SettingsDialog, {
    variant,
    prefs: {
      tools: [],
      pinned: [],
      status: Object.fromEntries(ALL_TOOLS.map((tool) => [tool, { running: false }])) as Record<ToolId, { running: boolean }>,
      host: "",
    },
    checking: false,
    checkedAt: null,
    error: "",
    installed: [],
    pluginBusy: false,
    onPlugin: () => undefined,
    onToggle: () => undefined,
    onLanguageChange: () => undefined,
    onCheck: () => undefined,
    onClose: () => undefined,
  }),
);

describe("settings", () => {
  it("does not offer the plugin market on a phone", () => {
    expect(settings("page")).not.toContain("插件市场");
    expect(settings("page")).not.toContain("通过你的服务器");
    expect(settings("page")).not.toContain("选择要显示的 AI 工具");
  });

  it("offers both interface languages directly on a phone", () => {
    const page = settings("page");
    expect(page).toContain("中文");
    expect(page).toContain("English");
  });

  it("puts the language under 外观 on a phone, switched in the row the same way", () => {
    const page = settings("page");
    const appearance = page.indexOf('<span class="pref-title">外观</span>');
    const language = page.indexOf('<span class="pref-title">语言</span>');
    expect(appearance).toBeGreaterThan(-1);
    expect(language).toBeGreaterThan(appearance);
    expect(page.slice(language)).toMatch(/<span class="pref-segment" role="radiogroup" aria-label="语言"><button[^>]*aria-checked="true" class="is-on"[^>]*>中文<\/button>/);
  });

  it("shows the page in English once English is chosen", async () => {
    await setLanguage("en");
    try {
      const page = settings("page");
      expect(page).toContain("Appearance");
      expect(page).toMatch(/aria-checked="true" class="is-on"[^>]*>English</);
      expect(page).not.toContain("外观");
      expect(settings("dialog")).toContain("General settings");
    } finally {
      await setLanguage("zh-CN");
    }
  });

  it("does not offer the plugin market on a desktop", () => {
    expect(settings("dialog")).not.toContain("插件市场");
    expect(settings("dialog")).not.toContain("通过你的服务器");
    expect(settings("dialog")).not.toContain("打开的工具会显示");
  });

  it("shows AI tools and remote access as peer settings sections", () => {
    const page = settings("dialog");
    expect(page).toContain("通用设置</button>");
    expect(page).toContain("AI 工具</button>");
    expect(page).toContain("外网访问</button>");
    expect(page).toContain(">恢复默认<");
    expect(page).not.toContain("连通性检测");
  });

  it("puts AI tools and remote access under the language row on a phone", async () => {
    await setLanguage("zh-CN");
    const page = settings("page");
    const language = page.indexOf('<span class="pref-title">语言</span>');
    const tools = page.indexOf('<span class="pref-title">AI 工具</span>');
    const remote = page.indexOf('<span class="pref-title">外网访问</span>');
    expect(language).toBeGreaterThan(-1);
    expect(tools).toBeGreaterThan(language);
    expect(remote).toBeGreaterThan(tools);
    expect(page.indexOf('<span class="pref-title">恢复默认</span>')).toBeGreaterThan(remote);
    expect(settings("dialog")).toContain(">恢复默认<");
  });
});
