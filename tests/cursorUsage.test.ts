import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  cursorUsageQuota,
  parseCursorUsage,
  readCursorUsageOnce,
  removeUsageChats,
  type UsageTerminal,
} from "../src/process/cursorUsage";

// What the Cursor CLI drew for /usage on a real Pro account (email masked).
const PANEL = readFileSync(path.join(__dirname, "fixtures", "cursor-usage-panel.txt"), "utf8");

describe("Cursor's monthly usage", () => {
  it("reads the plan, the month's share, its parts and the reset day from the /usage panel", () => {
    expect(parseCursorUsage(PANEL)).toEqual({ plan: "Pro", percent: 92, auto: 100, api: 11, reset: "11月19日", onDemand: "Disabled" });
  });

  it("reads an English panel and one without a reset day", () => {
    expect(parseCursorUsage("Usage • Pro+   Resets Dec 5\nIncluded  37% used ███░░\n  Auto 12% used\n  API 41% used\nOn-Demand  $0 / $50")).toMatchObject({
      plan: "Pro+",
      percent: 37,
      reset: "Dec 5",
      onDemand: "$0 / $50",
    });
    expect(parseCursorUsage("Usage • Pro   Current period\nIncluded 5% used")).toMatchObject({ percent: 5, reset: "" });
    expect(parseCursorUsage("Loading usage data...")).toBeNull();
  });

  it("shows like Claude's limit: the month's share, plan and reset day on hover", () => {
    expect(cursorUsageQuota({ plan: "Pro", percent: 92, auto: 100, api: 11, reset: "11月19日", onDemand: "Disabled", at: 0 })).toEqual({
      label: "本月 92%",
      title: "Cursor 本月额度（Pro）已用 92%（Auto 100%，API 11%），11月19日 重置",
      level: "high",
      percent: 92,
      resetLabel: "11月19日重置",
    });
    expect(cursorUsageQuota({ plan: "", percent: 100, auto: null, api: null, reset: "", onDemand: "", at: 0 })).toMatchObject({ label: "本月 已满", level: "full" });
    expect(cursorUsageQuota(null)).toBeNull();
  });

  it("removes only the empty chats the usage folder leaves behind", () => {
    const root = mkdtempSync(path.join(tmpdir(), "aimiss-cursor-chats-"));
    const usageDir = path.join(root, "cursor-usage");
    const chat = (bucket: string, id: string, meta: object) => {
      mkdirSync(path.join(root, "chats", bucket, id), { recursive: true });
      writeFileSync(path.join(root, "chats", bucket, id, "meta.json"), JSON.stringify(meta));
    };
    chat("b1", "empty", { cwd: usageDir, hasConversation: false });
    chat("b2", "talked", { cwd: usageDir, hasConversation: true });
    chat("b3", "elsewhere", { cwd: path.join(root, "project"), hasConversation: false });
    expect(removeUsageChats(path.join(root, "chats"), usageDir)).toBe(1);
    expect(existsSync(path.join(root, "chats", "b1"))).toBe(false);
    expect(existsSync(path.join(root, "chats", "b2", "talked"))).toBe(true);
    expect(existsSync(path.join(root, "chats", "b3", "elsewhere"))).toBe(true);
  });

  it("asks for /usage once the chat is up, and reads the panel", async () => {
    const typed: string[] = [];
    let output: (data: string) => void = () => {};
    const terminal: UsageTerminal = {
      write: (data) => {
        typed.push(data);
        if (data === "\r") setTimeout(() => output(PANEL), 5);
      },
      kill() {},
      onData: (callback) => void (output = callback),
      onExit() {},
    };
    const dir = mkdtempSync(path.join(tmpdir(), "aimiss-cursor-usage-"));
    setTimeout(() => output("  → Plan, search, build anything\n"), 5);
    const result = await readCursorUsageOnce({ node: "node.exe", js: "index.js" }, () => terminal, dir, {
      settleMs: 20,
      minStartMs: 30,
      startMs: 500,
      totalMs: 5000,
      retryMs: 200,
      now: () => Date.now(),
    });
    expect(result).toEqual({ usage: expect.objectContaining({ plan: "Pro", percent: 92 }) });
    expect(typed.slice(0, 2)).toEqual(["/usage", "\r"]);
  });

  it("never presses a key on the login screen, which would start a browser login", async () => {
    const typed: string[] = [];
    let killed = false;
    let output: (data: string) => void = () => {};
    const terminal: UsageTerminal = {
      write: (data) => void typed.push(data),
      kill: () => void (killed = true),
      onData: (callback) => void (output = callback),
      onExit() {},
    };
    const dir = mkdtempSync(path.join(tmpdir(), "aimiss-cursor-usage-"));
    setTimeout(() => output("Cursor Agent\nPress any key to log in...\n"), 5);
    const result = await readCursorUsageOnce({ node: "node.exe", js: "index.js" }, () => terminal, dir, {
      settleMs: 20,
      minStartMs: 30,
      startMs: 500,
      totalMs: 2000,
      retryMs: 200,
      now: () => Date.now(),
    });
    expect(result).toEqual({ error: "login" });
    expect(typed).toEqual([]);
    expect(killed).toBe(true);
  });
});
