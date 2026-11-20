import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { claudeDesktopFiveHour, claudeUsageQuota, cursorQuota, parseResetText, describeFiveHour, modelLabel, readClaudeQuota, readCodexQuota } from "../src/catalog/quotas";

const now = Date.parse("2026-11-12T03:00:00.000Z");

describe("five-hour quota", () => {
  it("shows how much of the Codex window is gone, and drops a window that already reset", () => {
    expect(describeFiveHour({ usedPercent: 1.2, exhausted: false, resetsAt: now + 60_000 }, now)).toMatchObject({
      label: "5小时 1%",
      level: "ok",
    });
    expect(describeFiveHour({ usedPercent: 93, exhausted: false, resetsAt: now + 60_000 }, now).title).toContain("已用 93%");
    expect(describeFiveHour({ usedPercent: 93, exhausted: false, resetsAt: now + 60_000 }, now).level).toBe("high");
    expect(describeFiveHour({ usedPercent: 100, exhausted: true, resetsAt: now + 60_000 }, now)).toMatchObject({
      label: "5小时 已满",
      level: "full",
    });
    expect(describeFiveHour({ usedPercent: 100, exhausted: true, resetsAt: now - 60_000 }, now)).toEqual({
      label: "5小时",
      title: "5小时限额",
      level: "ok",
      percent: null,
    });
  });

  it("reads the 5-hour window from the newest Codex session, not the weekly one", () => {
    const root = mkdtempSync(path.join(tmpdir(), "aimiss-quota-"));
    const day = path.join(root, "2026", "11", "12");
    mkdirSync(day, { recursive: true });
    const line = (used: number) =>
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "token_count",
          rate_limits: {
            primary: { used_percent: used, window_minutes: 300, resets_at: Math.floor(now / 1000) + 3600 },
            secondary: { used_percent: 93, window_minutes: 10080, resets_at: Math.floor(now / 1000) + 86400 },
          },
        },
      });
    writeFileSync(path.join(day, "older.jsonl"), `${line(80)}\n`);
    writeFileSync(path.join(day, "newer.jsonl"), `${line(80)}\n${line(12)}\n`);
    utimesSync(path.join(day, "older.jsonl"), new Date(now - 86_400_000), new Date(now - 86_400_000));
    utimesSync(path.join(day, "newer.jsonl"), new Date(now), new Date(now));

    expect(readCodexQuota(root, now)).toMatchObject({ label: "5小时 12%", level: "ok", percent: 12 });
    // Once that window has ended with nothing newer, nothing has been used since the reset.
    expect(readCodexQuota(root, now + 10 * 3_600_000)).toMatchObject({ label: "5小时 0%", percent: 0 });
  });

  it("shows Claude's 5-hour limit as used up only while the reset is still ahead", () => {
    const root = mkdtempSync(path.join(tmpdir(), "aimiss-claude-quota-"));
    const project = path.join(root, "E--work");
    mkdirSync(project, { recursive: true });
    const rejected = (resetsAt: number) =>
      JSON.stringify({
        type: "assistant",
        timestamp: new Date(now).toISOString(),
        apiErrorParams: {
          rate_limit_info: { status: "rejected", resetsAt, rateLimitType: "five_hour" },
        },
      });
    writeFileSync(path.join(project, "full.jsonl"), `${rejected(Math.floor(now / 1000) + 3600)}\n`);
    expect(readClaudeQuota(root, now)).toMatchObject({ label: "5小时 已满", level: "full" });

    const later = mkdtempSync(path.join(tmpdir(), "aimiss-claude-quota-"));
    const folder = path.join(later, "E--work");
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, "old.jsonl"), `${rejected(Math.floor(now / 1000) - 60)}\n`);
    expect(readClaudeQuota(later, now)).toEqual({ label: "5小时", title: "5小时限额", level: "ok", percent: null });
  });
});

describe("cursor model", () => {
  it("names the model Cursor has selected", () => {
    expect(modelLabel("grok-4.7")).toBe("Grok 4.7");
    expect(cursorQuota("grok-4.7")).toEqual({ label: "Grok 4.7", title: "当前模型 Grok 4.7", level: "ok", percent: null });
    expect(cursorQuota("")).toBeNull();
  });
});

describe("claudeUsageQuota", () => {
  it("reads the wording that puts the percent first", () => {
    expect(claudeUsageQuota("Usage: 24% of 5-hour limit, Resets at 9:30 AM")).toEqual({
      label: "5小时 24%",
      title: "Claude 5小时限额已用 24%，9:30 AM 重置",
      level: "ok",
      percent: 24,
      resetsAt: expect.any(Number),
    });
  });

  it("reads the meter the Claude desktop app shows", () => {
    expect(claudeUsageQuota("Usage: Weekly · all models: 62%, Resets Tue 1:30 AM")).toEqual({
      label: "本周 62%",
      title: "Claude 本周限额（所有模型）已用 62%，Tue 1:30 AM 重置",
      level: "ok",
      percent: 62,
      resetsAt: expect.any(Number),
    });
    expect(claudeUsageQuota("Usage: 5-hour: 91%, Resets 3:00 PM")).toMatchObject({ label: "5小时 91%", level: "high", percent: 91 });
    expect(claudeUsageQuota("Usage: 5-hour: 100%")).toMatchObject({ label: "5小时 已满", level: "full" });
    expect(claudeUsageQuota("")).toBeNull();
  });

  it("reads the meter when the app is in Chinese", () => {
    expect(claudeUsageQuota("用量：5 小时限额的 9%13:10 重置")).toEqual({
      label: "5小时 9%",
      title: "Claude 5小时限额已用 9%，13:10 重置",
      level: "ok",
      percent: 9,
      resetsAt: expect.any(Number),
    });
    expect(claudeUsageQuota("用量：5 小时限额的 100%")).toMatchObject({ label: "5小时 已满", level: "full" });
  });
});

describe("the Claude desktop app's 5-hour window", () => {
  // Monday 16 Nov 2026, 22:00 local time.
  const monday = new Date(2026, 10, 16, 22, 0, 0).getTime();

  it("reads the panel's reset time as the next moment it names", () => {
    expect(new Date(parseResetText("Resets Tue 1:20 AM", monday) ?? 0)).toEqual(new Date(2026, 10, 17, 1, 20, 0));
    expect(new Date(parseResetText("Resets 11:05 PM", monday) ?? 0)).toEqual(new Date(2026, 10, 16, 23, 5, 0));
    expect(new Date(parseResetText("Resets 9:00 PM", monday) ?? 0)).toEqual(new Date(2026, 10, 17, 21, 0, 0));
    expect(parseResetText("soon", monday)).toBeNull();
    // The English panel's wordings.
    expect(new Date(parseResetText("Resets at 11:40 PM", monday) ?? 0)).toEqual(new Date(2026, 10, 16, 23, 40, 0));
    expect(new Date(parseResetText("Resets at 3:40 PM", monday) ?? 0)).toEqual(new Date(2026, 10, 17, 15, 40, 0));
    expect(new Date(parseResetText("Resets Tue at 1:20 AM", monday) ?? 0)).toEqual(new Date(2026, 10, 17, 1, 20, 0));
    expect(parseResetText("Resets in 2 hr 10 min", monday)).toBe(monday + 130 * 60_000);
    expect(parseResetText("Resets in 45 min", monday)).toBe(monday + 45 * 60_000);
    expect(new Date(parseResetText("13:10 重置", monday) ?? 0)).toEqual(new Date(2026, 10, 17, 13, 10, 0));
    expect(new Date(parseResetText("周二 1:30 重置", monday) ?? 0)).toEqual(new Date(2026, 10, 17, 1, 30, 0));
    expect(new Date(parseResetText("下午11:05 重置", monday) ?? 0)).toEqual(new Date(2026, 10, 16, 23, 5, 0));
  });

  it("turns the bar into a 5-hour quota", () => {
    expect(claudeDesktopFiveHour(34, "Resets Tue 1:20 AM", monday)).toEqual({
      label: "5小时 34%",
      title: "Claude 5小时限额已用 34%，01:20 恢复",
      level: "ok",
      percent: 34,
      resetsAt: new Date(2026, 10, 17, 1, 20, 0).getTime(),
    });
    expect(claudeDesktopFiveHour(null, "Resets Tue 1:20 AM", monday)).toBeNull();
    // What the English panel showed: "5-hour limit" at 29, "Resets at 3:40 PM".
    expect(claudeDesktopFiveHour(29, "Resets at 11:40 PM", monday)).toMatchObject({
      label: "5小时 29%",
      percent: 29,
      resetsAt: new Date(2026, 10, 16, 23, 40, 0).getTime(),
    });
  });
});
