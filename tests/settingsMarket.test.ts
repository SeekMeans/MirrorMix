import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { ALL_TOOLS, type ToolId } from "../client/src/api";

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

  it("does not offer the plugin market on a desktop", () => {
    expect(settings("dialog")).not.toContain("插件市场");
    expect(settings("dialog")).not.toContain("通过你的服务器");
    expect(settings("dialog")).not.toContain("打开的工具会显示");
  });
});
