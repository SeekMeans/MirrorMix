import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConnectionMode } from "../src/settings/connectionMode";

describe("machine-local connection mode", () => {
  it("keeps the original transports when a colleague only pulls the repository", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "connection-mode-")), "missing.json");
    expect(resolveConnectionMode(file, {})).toBe("legacy");
  });

  it("opts into desktop mode locally and lets an explicit environment value override it", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "connection-mode-")), "mode.json");
    writeFileSync(file, '\uFEFF{"mode":"desktop"}');
    expect(resolveConnectionMode(file, {})).toBe("desktop");
    expect(resolveConnectionMode(file, { AIMISS_CONNECTION_MODE: "legacy" })).toBe("legacy");
    expect(resolveConnectionMode("missing", { AIMISS_CONNECTION_MODE: "desktop" })).toBe("desktop");
  });

  it("does not silently enable CLI fallback when a desktop configuration is broken", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "connection-mode-")), "mode.json");
    writeFileSync(file, '{"mode":"typo"}');
    expect(() => resolveConnectionMode(file, {})).toThrow("通信模式必须是");
    writeFileSync(file, '{broken');
    expect(() => resolveConnectionMode(file, {})).toThrow("无法读取本机通信配置");
  });
});
