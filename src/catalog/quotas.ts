import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { cursorActiveModel } from "./cursor";

/** Short line under a tool tab. Claude and Codex share a 5-hour window; Cursor's line is the model in use. */
export interface ToolQuota {
  label: string;
  title: string;
  level: "ok" | "high" | "full";
  /** How much of the 5-hour window is used, 0–100, when the tool says. Drawn as a thin bar under the tab. */
  percent: number | null;
  /** Unix milliseconds when the window resets, when known: the page counts down to it. */
  resetsAt?: number | null;
  /** When only the day is known (Cursor's month: "11月19日重置"), shown in place of a countdown. */
  resetLabel?: string;
}

export interface QuotaSnapshot {
  claude: ToolQuota;
  codex: ToolQuota;
  cursor: ToolQuota | null;
}

interface FiveHourSample {
  usedPercent: number | null;
  exhausted: boolean;
  /** Unix milliseconds when this window ends. */
  resetsAt: number | null;
}

const FIVE_HOUR: ToolQuota = { label: "5小时", title: "5小时限额", level: "ok", percent: null };

const MODEL_WORDS: Record<string, string> = {
  gpt: "GPT",
  grok: "Grok",
  claude: "Claude",
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
  composer: "Composer",
  cursor: "Cursor",
  gemini: "Gemini",
  codex: "Codex",
};

/** `grok-4.7` becomes `Grok 4.7`. */
export function modelLabel(name: string): string {
  return name
    .trim()
    .split("-")
    .filter(Boolean)
    .map((part) => {
      const known = MODEL_WORDS[part.toLowerCase()];
      if (known) return known;
      return /^[a-z]/.test(part) ? part[0].toUpperCase() + part.slice(1) : part;
    })
    .join(" ");
}

function clock(ms: number): string {
  const date = new Date(ms);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/** A sample whose reset time has passed belongs to the previous window. */
export function describeFiveHour(sample: FiveHourSample | null, now = Date.now()): ToolQuota {
  if (!sample) return FIVE_HOUR;
  const reset = sample.resetsAt != null && sample.resetsAt > now ? sample.resetsAt : null;
  const stale = sample.resetsAt != null && sample.resetsAt <= now;
  const percent = stale || sample.usedPercent == null ? null : Math.round(sample.usedPercent);
  const full = !stale && (sample.exhausted || (percent != null && percent >= 100));
  const when = reset ? `${clock(reset)} 恢复` : "";
  if (full) {
    return { label: "5小时 已满", title: when ? `5小时限额已用尽，${when}` : "5小时限额已用尽", level: "full", percent: 100, resetsAt: reset };
  }
  if (percent == null) return FIVE_HOUR;
  return {
    label: `5小时 ${percent}%`,
    title: when ? `5小时限额已用 ${percent}%，${when}` : `5小时限额已用 ${percent}%`,
    level: percent >= 80 ? "high" : "ok",
    percent: Math.max(0, Math.min(100, percent)),
    resetsAt: reset,
  };
}

export function cursorQuota(modelName: string): ToolQuota | null {
  const label = modelLabel(modelName);
  if (!label) return null;
  return { label, title: `当前模型 ${label}`, level: "ok", percent: null };
}

function tailLines(file: string, bytes: number): string[] {
  const size = statSync(file).size;
  const length = Math.min(size, bytes);
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split("\n").filter(Boolean);
    if (size > bytes) lines.shift();
    return lines;
  } finally {
    closeSync(fd);
  }
}

function childDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const names: string[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) names.push(entry.name);
    }
  } catch {
    return [];
  }
  names.sort((a, b) => {
    const left = /^\d+$/.test(a) ? Number(a) : NaN;
    const right = /^\d+$/.test(b) ? Number(b) : NaN;
    if (!Number.isNaN(left) && !Number.isNaN(right) && left !== right) return right - left;
    return a < b ? 1 : -1;
  });
  return names.map((name) => path.join(dir, name));
}

function recentCodexFiles(sessionsDir: string): string[] {
  const days: string[] = [];
  for (const year of childDirs(sessionsDir).slice(0, 2)) {
    for (const month of childDirs(year).slice(0, 2)) {
      days.push(...childDirs(month).slice(0, 2));
    }
  }
  const files = [...jsonlIn(sessionsDir), ...days.flatMap(jsonlIn)];
  return newest(files, 4);
}

function jsonlIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

function newest(files: string[], count: number): string[] {
  const ranked: Array<{ file: string; mtime: number }> = [];
  for (const file of files) {
    try {
      ranked.push({ file, mtime: statSync(file).mtimeMs });
    } catch {
      /* removed between the listing and the stat */
    }
  }
  ranked.sort((a, b) => b.mtime - a.mtime);
  return ranked.slice(0, count).map((item) => item.file);
}

const claudeFiles = new Map<string, { at: number; files: string[] }>();

function recentClaudeFiles(projectsDir: string): string[] {
  const hit = claudeFiles.get(projectsDir);
  if (hit && Date.now() - hit.at < 15_000) return hit.files;
  const files: string[] = [];
  if (existsSync(projectsDir)) {
    for (const project of readdirSync(projectsDir, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      files.push(...jsonlIn(path.join(projectsDir, project.name)));
    }
  }
  const picked = newest(files, 5);
  claudeFiles.set(projectsDir, { at: Date.now(), files: picked });
  return picked;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function findFiveHour(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 5) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFiveHour(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const record = asRecord(value);
  if (!record) return null;
  if (record.rateLimitType === "five_hour") return record;
  for (const child of Object.values(record)) {
    if (!child || typeof child !== "object") continue;
    const found = findFiveHour(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function claudeSample(file: string): { at: number; sample: FiveHourSample } | null {
  let lines: string[];
  try {
    lines = tailLines(file, 512 * 1024);
  } catch {
    return null;
  }
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line?.includes("five_hour")) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const info = findFiveHour(record);
    if (!info) continue;
    const resets = typeof info.resetsAt === "number" ? info.resetsAt * 1000 : null;
    const used = typeof info.utilization === "number" ? info.utilization : null;
    const percent = used == null ? null : used <= 1 ? used * 100 : used;
    const stamped = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
    return {
      at: Number.isNaN(stamped) ? 0 : stamped,
      sample: {
        usedPercent: percent,
        exhausted: info.status === "rejected" || (percent != null && percent >= 100),
        resetsAt: resets,
      },
    };
  }
  return null;
}

function codexSample(file: string): FiveHourSample | null {
  let lines: string[];
  try {
    lines = tailLines(file, 256 * 1024);
  } catch {
    return null;
  }
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line?.includes("rate_limits")) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const payload = asRecord(record.payload) ?? record;
    const limits = asRecord(payload.rate_limits);
    const primary = asRecord(limits?.primary);
    if (!primary || primary.window_minutes !== 300) continue;
    const used = typeof primary.used_percent === "number" ? primary.used_percent : null;
    const resets = typeof primary.resets_at === "number" ? primary.resets_at * 1000 : null;
    return { usedPercent: used, exhausted: used != null && used >= 100, resetsAt: resets };
  }
  return null;
}

export function readClaudeQuota(projectsDir: string, now = Date.now()): ToolQuota {
  let latest: { at: number; sample: FiveHourSample } | null = null;
  for (const file of recentClaudeFiles(projectsDir)) {
    const found = claudeSample(file);
    if (found && (!latest || found.at >= latest.at)) latest = found;
  }
  return describeFiveHour(latest?.sample ?? null, now);
}

export function readCodexQuota(sessionsDir: string, now = Date.now()): ToolQuota {
  for (const file of recentCodexFiles(sessionsDir)) {
    const sample = codexSample(file);
    if (!sample) continue;
    // Codex writes the window after every reply. A window that has already ended with nothing newer means
    // nothing has been used since it reset.
    if (sample.resetsAt != null && sample.resetsAt <= now) {
      return { label: "5小时 0%", title: "5小时限额已重置，还没有用", level: "ok", percent: 0 };
    }
    return describeFiveHour(sample, now);
  }
  return describeFiveHour(null, now);
}

/**
 * The Claude desktop app shows its own meter as a button, for example
 * "Usage: Weekly · all models: 62%, Resets Tue 1:30 AM". Its window is the only place the share is written down.
 */
export function claudeUsageQuota(name: string): ToolQuota | null {
  // Two wordings: "Usage: Weekly · all models: 62%, Resets Tue 1:30 AM" and "Usage: 24% of 5-hour limit, Resets at 9:30 AM".
  const named = name.trim().match(/^Usage:\s*(.+?):\s*(\d+(?:\.\d+)?)%(?:\s*,\s*Resets\s+(.+))?$/i);
  const of = name.trim().match(/^Usage:\s*(\d+(?:\.\d+)?)%\s+of\s+(.+?)(?:\s+limit)?(?:\s*,\s*Resets\s+(?:at\s+)?(.+))?$/i);
  // The app in Chinese: "用量：5 小时限额的 9%13:10 重置" (no separator between the share and the reset time).
  const zh = name.trim().match(/^用量[:：]\s*(.+?)\s*的?\s*(\d+(?:\.\d+)?)%\s*[,，]?\s*(.*?)\s*(?:重置)?$/);
  const match = named ?? (of ? [of[0], of[2], of[1], of[3]] : null) ?? (zh ? [zh[0], zh[1], zh[2], zh[3] || undefined] : null);
  if (!match) return null;
  const kind = match[1].trim();
  const percent = Math.max(0, Math.min(100, Math.round(Number(match[2]))));
  const window = /5[- ]?hour|session|current|5\s*小时/i.test(kind) ? "5小时" : /week|每周|周/i.test(kind) ? "本周" : kind;
  const scope = /all models|所有模型/i.test(kind) ? "（所有模型）" : "";
  const reset = match[3] ? `，${match[3].trim()} 重置` : "";
  const full = percent >= 100;
  // English gives "Tue 1:30 AM" after "Resets"; Chinese gives "13:10" before "重置".
  const resetText = match[3]?.trim() ?? "";
  const resetsAt = resetText ? parseResetText(`Resets ${resetText}`) ?? parseResetText(`${resetText} 重置`) : null;
  return {
    label: full ? `${window} 已满` : `${window} ${percent}%`,
    title: `Claude ${window}限额${scope}已用 ${percent}%${reset}`,
    level: full ? "full" : percent >= 80 ? "high" : "ok",
    percent,
    resetsAt,
  };
}

/**
 * The 5-hour window as Claude Code's status line last reported it (scripts/claude-statusline.mjs writes it).
 * Null when there is no such file or its window has already reset: what came after is not known.
 */
export function readStatusLineQuota(file: string, now = Date.now()): ToolQuota | null {
  let saved: { fiveHour?: { usedPercent?: unknown; resetsAt?: unknown } | null };
  try {
    saved = JSON.parse(readFileSync(file, "utf8")) as typeof saved;
  } catch {
    return null;
  }
  const window = saved?.fiveHour;
  if (!window || typeof window.usedPercent !== "number") return null;
  const resetsAt = typeof window.resetsAt === "number" ? window.resetsAt : null;
  if (resetsAt == null || resetsAt <= now) return null;
  const quota = describeFiveHour({ usedPercent: window.usedPercent, exhausted: window.usedPercent >= 100, resetsAt }, now);
  return { ...quota, title: `Claude ${quota.title}` };
}

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** "Resets Tue 1:20 AM" as the next moment it names, in local time. Null when it cannot be read. */
export function parseResetText(text: string, now = Date.now()): number | null {
  // English: "Resets Tue 1:20 AM", "Resets at 3:40 PM", or a countdown "Resets in 2 hr 10 min".
  const after = text.match(/resets\s+in\s+(?:(\d+)\s*(?:h|hr|hrs|hours?)\b)?\s*(?:(\d+)\s*(?:m|min|mins|minutes?)\b)?/i);
  if (after && (after[1] || after[2])) {
    return now + (Number(after[1] ?? 0) * 60 + Number(after[2] ?? 0)) * 60_000;
  }
  const en = text.match(/resets\s+(?:at\s+)?(?:(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?\s+(?:at\s+)?)?(\d{1,2}):(\d{2})\s*(am|pm)?/i);
  // Chinese: "13:10 重置", "周二 1:30 重置", "下午1:30 重置".
  const zh = en ? null : text.match(/(?:(?:周|星期)([日天一二三四五六])\s*)?(上午|下午)?\s*(\d{1,2}):(\d{2})\s*重置/);
  if (!en && !zh) return null;
  const weekday = en ? (en[1] ? WEEKDAYS.indexOf(en[1].toLowerCase()) : null) : zh![1] ? "日一二三四五六".indexOf(zh![1] === "天" ? "日" : zh![1]) : null;
  const rawHours = Number(en ? en[2] : zh![3]);
  const half = en ? en[4]?.toLowerCase() : zh![2] === "下午" ? "pm" : zh![2] === "上午" ? "am" : undefined;
  let hours = rawHours;
  if (half) hours = (rawHours % 12) + (half === "pm" ? 12 : 0);
  const minutes = Number(en ? en[3] : zh![4]);
  const base = new Date(now);
  const day = weekday;
  for (let ahead = 0; ahead < 8; ahead += 1) {
    const at = new Date(base.getFullYear(), base.getMonth(), base.getDate() + ahead, hours, minutes, 0, 0);
    if (day != null && at.getDay() !== day) continue;
    if (at.getTime() > now) return at.getTime();
  }
  return null;
}

/** The 5-hour window read from the Claude desktop app's usage panel. Null once that window has reset. */
export function claudeDesktopFiveHour(percent: number | null, resetText: string, now = Date.now()): ToolQuota | null {
  if (percent == null || !Number.isFinite(percent)) return null;
  const resetsAt = parseResetText(resetText, now);
  // Before the first message, Claude reports 0% and says the window has not started.
  // A known percentage is still useful even when there is no reset deadline.
  const quota = describeFiveHour({ usedPercent: percent, exhausted: percent >= 100, resetsAt }, now);
  return { ...quota, title: `Claude ${quota.title}` };
}

export function readQuotas(roots: { claudeProjectsDir: string; codexSessionsDir: string; cursorStateDb?: string }, now = Date.now()): QuotaSnapshot {
  return {
    claude: readClaudeQuota(roots.claudeProjectsDir, now),
    codex: readCodexQuota(roots.codexSessionsDir, now),
    cursor: cursorQuota(cursorActiveModel(roots.cursorStateDb)),
  };
}
