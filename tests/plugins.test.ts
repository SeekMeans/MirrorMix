import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSettingsStore } from "../src/settings/toolSettings";

describe("我的插件", () => {
  it("starts with both plugins, which used to be part of settings", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "aimiss-plugins-"));
    const store = createSettingsStore(path.join(dir, "settings.json"), () => []);
    expect(store.plugins()).toEqual(["commands", "schedules"]);
  });

  it("keeps what was added or removed, and drops anything the market does not offer", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "aimiss-plugins-"));
    const store = createSettingsStore(path.join(dir, "settings.json"), () => []);
    expect(store.setPlugins({ installed: ["schedules", "made-up", "schedules"] })).toEqual(["schedules"]);
    expect(JSON.parse(readFileSync(path.join(dir, "plugins.json"), "utf8"))).toEqual({ installed: ["schedules"] });
    // Read again, as after a restart.
    expect(createSettingsStore(path.join(dir, "settings.json"), () => []).plugins()).toEqual(["schedules"]);
    expect(store.setPlugins({ installed: [] })).toEqual([]);
    expect(store.plugins()).toEqual([]);
    expect(() => store.setPlugins({ installed: "commands" })).toThrow("bad_request");
  });
});
