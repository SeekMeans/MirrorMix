import { describe, expect, it } from "vitest";
import type { Catalog } from "../client/src/api";
import { isWorkbenchQuiet } from "../client/src/workbench";

const session = (id: string, working = false) => ({ id, title: id, updatedAt: "2026-11-19T08:00:00Z", working, unseen: false, pinned: false, status: "idle" }) as Catalog["claude"][number]["sessions"][number];
const catalog = (claude: ReturnType<typeof session>[], codex: ReturnType<typeof session>[] = []) =>
  ({ claude: [{ path: "E:/a", missing: false, sessions: claude }], codex: [{ path: "E:/b", missing: false, sessions: codex }], cursor: [], deepseek: [] }) as unknown as Catalog;

describe("today's figures on the workbench", () => {
  it("show only when nothing is replying and no finished reply is unread", () => {
    expect(isWorkbenchQuiet(catalog([session("a"), session("b")]), ["claude", "codex"], [], new Set())).toBe(true);
    expect(isWorkbenchQuiet(catalog([session("a", true)]), ["claude"], [], new Set())).toBe(false);
    expect(isWorkbenchQuiet(catalog([session("a")]), ["claude"], [], new Set(["claude:a"]))).toBe(false);
  });

  it("ignores tools that are hidden or not open, and waits for the list", () => {
    const busyCodex = catalog([session("a")], [session("c", true)]);
    expect(isWorkbenchQuiet(busyCodex, ["claude"], [], new Set())).toBe(true);
    expect(isWorkbenchQuiet(busyCodex, ["claude", "codex"], ["codex"], new Set())).toBe(true);
    expect(isWorkbenchQuiet(busyCodex, ["claude", "codex"], [], new Set())).toBe(false);
    expect(isWorkbenchQuiet(null, ["claude"], [], new Set())).toBe(false);
  });
});
