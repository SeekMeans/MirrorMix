import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

/** Desktop installers use different storage roots; an explicit override always wins. */
export function resolveClaudeDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AIMISS_CLAUDE_DATA !== undefined) return env.AIMISS_CLAUDE_DATA;
  const candidates = [
    ...(env.APPDATA ? [path.join(env.APPDATA, "Claude", "claude-code-sessions")] : []),
    ...(env.LOCALAPPDATA ? [path.join(env.LOCALAPPDATA, "Claude-Data")] : []),
  ];
  return candidates.find((dir) => existsSync(dir) && claudeLocalFiles(dir).length > 0) ?? candidates.find(existsSync) ?? "";
}

/** How long one walk of the Claude data folder is reused. The folder is large; its session records change rarely. */
const WALK_TTL_MS = 5_000;

const walks = new Map<string, { at: number; files: string[] }>();

function walk(dir: string, found: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.toLowerCase() === "archived_sessions") continue;
      walk(full, found);
    } else if (entry.name.startsWith("local_") && entry.name.endsWith(".json")) found.push(full);
  }
}

/**
 * The desktop app's session records (`local_….json`) under its data folder, sorted.
 * Everything that reads them shares this one walk instead of each crossing the whole folder again.
 */
export function claudeLocalFiles(claudeDataDir: string, now = Date.now()): string[] {
  const hit = walks.get(claudeDataDir);
  if (hit && now - hit.at < WALK_TTL_MS) return hit.files;
  const files: string[] = [];
  walk(claudeDataDir, files);
  files.sort();
  walks.set(claudeDataDir, { at: now, files });
  return files;
}

/** Test hook: a fixture written a moment ago must be seen at once. */
export function clearClaudeWalks(): void {
  walks.clear();
}
