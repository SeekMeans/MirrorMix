import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSettingsStore } from "../src/settings/toolSettings";

describe("app-owned session pins", () => {
  it("saves pins and tools independently and drops malformed keys", () => {
    const store = createSettingsStore(path.join(mkdtempSync(path.join(tmpdir(), "pins-")), "s.json"), () => []);
    expect(store.read().pinned).toEqual([]);
    store.write({ tools: ["codex"] });
    expect(store.write({ pinned: ["claude:a", "claude:a", "bogus:x", 3] }).pinned).toEqual(["claude:a"]);
    expect(store.read()).toEqual({ tools: ["codex"], pinned: ["claude:a"] });
    expect(() => store.write({ pinned: "no" })).toThrow();
    expect(() => store.write({})).toThrow();
  });
});
