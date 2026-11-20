import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { claudeDesktopFiveHour, type ToolQuota } from "./quotas";

export interface DesktopUsage {
  meter: string;
  fiveHour: number | null;
  fiveHourReset: string;
  fiveHourAt: number;
  /** Last reader failure, for local diagnostics. */
  error?: string;
}

export function readDesktopUsageCache(file?: string): DesktopUsage {
  const empty: DesktopUsage = { meter: "", fiveHour: null, fiveHourReset: "", fiveHourAt: 0 };
  if (!file) return empty;
  try {
    const saved = JSON.parse(readFileSync(file, "utf8")) as DesktopUsage;
    if (typeof saved.meter !== "string" || typeof saved.fiveHourReset !== "string" ||
        (saved.fiveHour !== null && (typeof saved.fiveHour !== "number" || !Number.isFinite(saved.fiveHour) ||
        saved.fiveHour < 0 || saved.fiveHour > 100)) ||
        typeof saved.fiveHourAt !== "number" || !Number.isFinite(saved.fiveHourAt)) return empty;
    return saved;
  } catch { return empty; }
}

export function saveDesktopUsageCache(file: string | undefined, usage: DesktopUsage): void {
  if (!file) return;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(usage), "utf8");
  } catch { /* A read-only cache must not stop the desktop reader. */ }
}

export function desktopUsageQuota(usage: DesktopUsage, now = Date.now()): ToolQuota | null {
  const age = now - usage.fiveHourAt;
  if (age < 0 || age >= 5 * 3_600_000) return null;
  // Resolve a weekday/clock against when it was read, never against a later poll.
  // Otherwise an expired reset can silently become tomorrow's or next week's reset.
  const quota = claudeDesktopFiveHour(usage.fiveHour, usage.fiveHourReset, usage.fiveHourAt);
  if (!quota || (quota.resetsAt != null && quota.resetsAt <= now)) return null;
  // An idle window has no reset deadline; refresh this reading more often.
  if (quota.resetsAt == null && age >= 5 * 60_000) return null;
  // The panel is only opened while the screen is locked, so say how old the number is once it is not fresh.
  if (age >= 5 * 60_000) {
    const at = new Date(usage.fiveHourAt);
    const clock = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
    return { ...quota, title: `${quota.title}（${clock} 锁屏时读取，之后的用量要等下次锁屏才更新）` };
  }
  return quota;
}
