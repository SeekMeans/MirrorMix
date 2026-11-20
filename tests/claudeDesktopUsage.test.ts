import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { desktopUsageQuota, readDesktopUsageCache, saveDesktopUsageCache, type DesktopUsage } from "../src/catalog/claudeDesktopUsage";

const at = new Date(2026, 10, 18, 10, 0).getTime();
const reading: DesktopUsage = { meter: "", fiveHour: 37, fiveHourReset: "13:00 重置", fiveHourAt: at };

describe("Claude desktop quota readings", () => {
  it("shows an idle 0% window without inventing a reset countdown", () => {
    expect(desktopUsageQuota({ ...reading, fiveHour: 0, fiveHourReset: "" }, at)).toMatchObject({
      label: "5小时 0%", percent: 0, resetsAt: null,
    });
    expect(desktopUsageQuota({ ...reading, fiveHour: 0, fiveHourReset: "" }, at + 5 * 60_000)).toBeNull();
  });

  it("keeps a fixed reset deadline and drops expired readings instead of moving them to tomorrow", () => {
    const resetsAt = at + 3 * 3_600_000;
    expect(desktopUsageQuota(reading, at + 60_000)?.resetsAt).toBe(resetsAt);
    expect(desktopUsageQuota(reading, resetsAt)).toBeNull();
    expect(desktopUsageQuota(reading, at + 24 * 3_600_000)).toBeNull();
  });

  it("restores a valid reading across restarts and ignores corrupt cache data", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "mirrormix-usage-")), "usage.json");
    saveDesktopUsageCache(file, reading);
    expect(desktopUsageQuota(readDesktopUsageCache(file), at + 60_000)?.percent).toBe(37);
    writeFileSync(file, "{broken");
    expect(desktopUsageQuota(readDesktopUsageCache(file), at)).toBeNull();
    writeFileSync(file, JSON.stringify({ ...reading, fiveHour: 120 }));
    expect(desktopUsageQuota(readDesktopUsageCache(file), at)).toBeNull();
  });
});
