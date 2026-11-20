import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { claudeLocalFiles } from "./claudeData";

const claudeCache = new Map<string, { signature: string; ids: Set<string> }>();
const codexCache = new Map<string, { signature: string; ids: Set<string> }>();

function walkFiles(dir: string, accept: (name: string) => boolean, found: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === "." || entry.name === "..") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.toLowerCase() === "archived_sessions") continue;
      walkFiles(full, accept, found);
    } else if (accept(entry.name)) found.push(full);
  }
}

function stamp(file: string): string {
  const stat = statSync(file);
  return `${file}\0${stat.mtimeMs}\0${stat.size}`;
}

/** Sessions whose latest activity is newer than the last time Claude Code focused them. */
export function unseenClaudeSessionIds(claudeDataDir: string): Set<string> {
  if (!claudeDataDir || !existsSync(claudeDataDir)) return new Set();
  const files = claudeLocalFiles(claudeDataDir);
  const signature = files.map(stamp).join("\n");
  const hit = claudeCache.get(claudeDataDir);
  if (hit?.signature === signature) return hit.ids;
  const ids = new Set<string>();
  for (const file of files) {
    try {
      const data = JSON.parse(readFileSync(file, "utf8")) as {
        isArchived?: unknown;
        cliSessionId?: unknown;
        lastFocusedAt?: unknown;
        lastActivityAt?: unknown;
      };
      if (data.isArchived === true) continue;
      if (typeof data.cliSessionId !== "string" || !data.cliSessionId.trim()) continue;
      const focused = typeof data.lastFocusedAt === "number" ? data.lastFocusedAt : 0;
      const activity = typeof data.lastActivityAt === "number" ? data.lastActivityAt : 0;
      if (activity > focused) ids.add(data.cliSessionId.trim().toLowerCase());
    } catch {
      continue;
    }
  }
  claudeCache.set(claudeDataDir, { signature, ids });
  return ids;
}

function collectIds(value: unknown, into: Set<string>): void {
  if (typeof value === "string" && value.trim()) into.add(value.trim().toLowerCase());
  else if (Array.isArray(value)) for (const item of value) collectIds(item, into);
}

/** Threads Codex still lists as unread. */
export function unseenCodexSessionIds(sessionsDir: string): Set<string> {
  const file = path.join(path.dirname(path.resolve(sessionsDir)), ".codex-global-state.json");
  if (!existsSync(file)) return new Set();
  const signature = stamp(file);
  const hit = codexCache.get(file);
  if (hit?.signature === signature) return hit.ids;
  const ids = new Set<string>();
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as {
      "electron-persisted-atom-state"?: { "unread-thread-ids-by-host-v1"?: unknown };
    };
    const unread = data["electron-persisted-atom-state"]?.["unread-thread-ids-by-host-v1"];
    if (unread && typeof unread === "object") {
      for (const value of Object.values(unread)) collectIds(value, ids);
    }
  } catch {
    /* a half-written state file just means no dots this pass */
  }
  codexCache.set(file, { signature, ids });
  return ids;
}
