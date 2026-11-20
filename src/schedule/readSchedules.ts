import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { CatalogRoots } from "../catalog/readCatalog";
import type { ScheduleJob } from "../shared/types";

const DAY: Record<string, string> = {
  MO: "一",
  TU: "二",
  WE: "三",
  TH: "四",
  FR: "五",
  SA: "六",
  SU: "日",
};

export function describeRrule(rrule: string): string {
  const body = rrule.trim().replace(/^RRULE:/i, "");
  const parts = new Map<string, string>();
  for (const piece of body.split(";")) {
    const [key, value] = piece.split("=");
    if (key && value) parts.set(key.toUpperCase(), value);
  }
  const hour = (parts.get("BYHOUR") ?? "0").padStart(2, "0");
  const minute = (parts.get("BYMINUTE") ?? "0").padStart(2, "0");
  const clock = `${hour}:${minute}`;
  const days = (parts.get("BYDAY") ?? "").split(",").filter(Boolean);
  const weekdays = days.join(",");
  let when = "";
  if (parts.get("FREQ") === "HOURLY") return "每小时";
  if (parts.get("FREQ") === "DAILY" || days.length >= 7) when = "每天";
  else if (weekdays === "MO,TU,WE,TH,FR") when = "每周一至五";
  else if (days.length > 0) when = `每周${days.map((day) => DAY[day] ?? day).join("、")}`;
  else if (parts.get("FREQ") === "WEEKLY") when = "每周";
  else when = parts.get("FREQ") ?? rrule;
  return `${when} ${clock}`;
}

function walkFiles(dir: string, accept: (name: string) => boolean, found: string[], depth = 0): void {
  if (depth > 6 || !existsSync(dir)) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (/cache|gpu|shader|dawn|blob|sentry|crashpad|network/i.test(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, accept, found, depth + 1);
    else if (accept(entry.name)) found.push(full);
  }
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function timeOf(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
  }
  return textOf(value);
}

function parseToml(content: string): Record<string, string | string[]> {
  const values: Record<string, string | string[]> = {};
  for (const raw of content.split(/\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line);
    if (!match) continue;
    const rawValue = match[2].trim();
    if (rawValue.startsWith("[")) values[match[1]] = [...rawValue.matchAll(/"([^"]*)"/g)].map((item) => item[1]);
    else if (rawValue.startsWith("{")) values[match[1]] = /type\s*=\s*"([^"]*)"/.exec(rawValue)?.[1] ?? rawValue;
    else if (rawValue.startsWith('"') && rawValue.endsWith('"')) values[match[1]] = rawValue.slice(1, -1);
    else values[match[1]] = rawValue;
  }
  return values;
}

function readCodex(sessionsDir: string): ScheduleJob[] {
  const dir = path.join(path.dirname(path.resolve(sessionsDir)), "automations");
  if (!existsSync(dir)) return [];
  const jobs: ScheduleJob[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(dir, entry.name, "automation.toml");
    if (!existsSync(file)) continue;
    try {
      const values = parseToml(readFileSync(file, "utf8"));
      const id = textOf(values.id) || entry.name;
      const rrule = textOf(values.rrule);
      const cwds = Array.isArray(values.cwds) ? values.cwds.filter(Boolean) : [];
      const thread = textOf(values.target_thread_id);
      const target = textOf(values.target);
      jobs.push({
        tool: "codex",
        id,
        name: textOf(values.name) || id,
        kind: textOf(values.kind) || "cron",
        status: textOf(values.status) || "ACTIVE",
        cadence: rrule ? describeRrule(rrule) : "",
        prompt: textOf(values.prompt),
        location: cwds.join("、") || thread || target,
        updatedAt: timeOf(Number(values.updated_at)) || timeOf(Number(values.created_at)),
      });
    } catch {
      continue;
    }
  }
  return jobs;
}

function readClaude(claudeDataDir: string | null): ScheduleJob[] {
  if (!claudeDataDir) return [];
  const files: string[] = [];
  walkFiles(claudeDataDir, (name) => name === "scheduled-tasks.json", files);
  files.sort();
  const jobs: ScheduleJob[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    let data: { scheduledTasks?: unknown };
    try {
      data = JSON.parse(readFileSync(file, "utf8")) as { scheduledTasks?: unknown };
    } catch {
      continue;
    }
    if (!Array.isArray(data.scheduledTasks)) continue;
    for (const item of data.scheduledTasks) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const id = textOf(record.id) || textOf(record.name) || textOf(record.title);
      if (!id || seen.has(id.toLowerCase())) continue;
      seen.add(id.toLowerCase());
      const rrule = textOf(record.rrule);
      const cron = textOf(record.cron) || textOf(record.cronExpression) || textOf(record.schedule);
      const enabled = record.enabled;
      jobs.push({
        tool: "claude",
        id,
        name: textOf(record.name) || textOf(record.title) || id,
        kind: textOf(record.kind) || "schedule",
        status: textOf(record.status) || (enabled === false ? "PAUSED" : "ACTIVE"),
        cadence: rrule ? describeRrule(rrule) : cron,
        prompt: textOf(record.prompt) || textOf(record.message) || textOf(record.description),
        location: textOf(record.cwd) || textOf(record.path) || textOf(record.sessionId),
        updatedAt: timeOf(record.updatedAt) || timeOf(record.createdAt) || statTime(file),
      });
    }
  }
  return jobs;
}

function statTime(file: string): string {
  try {
    return statSync(file).mtime.toISOString();
  } catch {
    return "";
  }
}

export function readSchedules(roots: CatalogRoots): ScheduleJob[] {
  const jobs = [...readClaude(roots.claudeDataDir ?? null), ...readCodex(roots.codexSessionsDir)];
  return jobs.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}
