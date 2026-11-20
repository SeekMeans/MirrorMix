import { describe, expect, it } from "vitest";
import { claudeUsageQuota, describeFiveHour } from "../src/catalog/quotas";
import { timeUntil } from "../client/src/text";

const now = Date.parse("2026-11-17T10:00:00.000Z");

describe("time left until a limit resets", () => {
  it("reads like a short countdown", () => {
    expect(timeUntil(now + (2 * 60 + 14) * 60_000, now)).toBe("2小时14分");
    expect(timeUntil(now + 3 * 3_600_000, now)).toBe("3小时");
    expect(timeUntil(now + 38 * 60_000, now)).toBe("38分");
    expect(timeUntil(now + 20_000, now)).toBe("不到1分");
    expect(timeUntil(now + (2 * 24 + 5) * 3_600_000, now)).toBe("2天5小时");
  });

  it("carries the reset time of the 5-hour window to the page", () => {
    const resetsAt = now + 90 * 60_000;
    expect(describeFiveHour({ usedPercent: 63, exhausted: false, resetsAt }, now)).toMatchObject({ percent: 63, resetsAt });
    expect(describeFiveHour({ usedPercent: 100, exhausted: true, resetsAt }, now)).toMatchObject({ level: "full", resetsAt });
  });

  it("reads the reset time from the desktop app's meter, in English and Chinese", () => {
    expect(claudeUsageQuota("Usage: 24% of 5-hour limit, Resets at 9:30 AM")?.resetsAt).toEqual(expect.any(Number));
    expect(claudeUsageQuota("用量：5 小时限额的 9%13:10 重置")?.resetsAt).toEqual(expect.any(Number));
    expect(claudeUsageQuota("Usage: Weekly · all models: 62%")?.resetsAt).toBeNull();
  });
});
