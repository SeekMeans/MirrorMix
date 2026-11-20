import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { claudeLocalFiles } from "./claudeData";

const claudeCache = new Map<string, { signature: string; ids: Set<string> }>();

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
    if (entry.isDirectory()) walkFiles(full, accept, found);
    else if (accept(entry.name)) found.push(full);
  }
}

export function pinnedClaudeSessionIds(claudeDataDir: string): Set<string> {
  if (!claudeDataDir || !existsSync(claudeDataDir)) return new Set();
  const files = claudeLocalFiles(claudeDataDir);
  const signature = files
    .map((file) => {
      const stat = statSync(file);
      return `${file}\0${stat.mtimeMs}\0${stat.size}`;
    })
    .join("\n");
  const hit = claudeCache.get(claudeDataDir);
  if (hit?.signature === signature) return hit.ids;
  const ids = new Set<string>();
  for (const file of files) {
    try {
      const data = JSON.parse(readFileSync(file, "utf8")) as { isStarred?: unknown; cliSessionId?: unknown };
      if (data.isStarred === true && typeof data.cliSessionId === "string" && data.cliSessionId.trim()) {
        ids.add(data.cliSessionId.trim().toLowerCase());
      }
    } catch {
      continue;
    }
  }
  claudeCache.set(claudeDataDir, { signature, ids });
  return ids;
}

export function pinnedCodexSessionIds(sessionsDir: string): string[] {
  const file = path.join(path.dirname(path.resolve(sessionsDir)), ".codex-global-state.json");
  if (!existsSync(file)) return [];
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as { "pinned-thread-ids"?: unknown };
    const ids = data["pinned-thread-ids"];
    if (!Array.isArray(ids)) return [];
    return ids
      .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      .map((id) => id.trim().toLowerCase());
  } catch {
    return [];
  }
}
