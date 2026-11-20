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
    if (entry.isDirectory()) {
      if (entry.name.toLowerCase() === "archived_sessions") continue;
      walkFiles(full, accept, found);
    } else if (accept(entry.name)) {
      found.push(full);
    }
  }
}

export function archivedClaudeSessionIds(claudeDataDir: string): Set<string> {
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
      const data = JSON.parse(readFileSync(file, "utf8")) as { isArchived?: unknown; cliSessionId?: unknown };
      if (data.isArchived === true && typeof data.cliSessionId === "string" && data.cliSessionId.trim()) {
        ids.add(data.cliSessionId.trim().toLowerCase());
      }
    } catch {
      continue;
    }
  }
  claudeCache.set(claudeDataDir, { signature, ids });
  return ids;
}

export interface ClaudeLineage {
  current: string;
  priors: string[];
  archived: boolean;
  /** The desktop row itself (`local_…`): its claude.exe carries this as CLAUDE_CODE_HOST_SESSION_ID. */
  host: string;
  /** The name the desktop app shows for the row. */
  title: string;
}

const lineageCache = new Map<string, { signature: string; rows: ClaudeLineage[] }>();

function sessionIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is string => typeof id === "string" && id.trim().length > 0).map((id) => id.trim().toLowerCase());
}

/** One desktop row can span several transcripts. `priors` are the earlier files of that same row. */
export function claudeSessionLineage(claudeDataDir: string): ClaudeLineage[] {
  if (!claudeDataDir || !existsSync(claudeDataDir)) return [];
  const files = claudeLocalFiles(claudeDataDir);
  const signature = files
    .map((file) => {
      const stat = statSync(file);
      return `${file}\0${stat.mtimeMs}\0${stat.size}`;
    })
    .join("\n");
  const hit = lineageCache.get(claudeDataDir);
  if (hit?.signature === signature) return hit.rows;
  const rows: ClaudeLineage[] = [];
  for (const file of files) {
    try {
      const data = JSON.parse(readFileSync(file, "utf8")) as {
        isArchived?: unknown;
        cliSessionId?: unknown;
        priorCliSessionIds?: unknown;
        title?: unknown;
      };
      if (typeof data.cliSessionId !== "string" || !data.cliSessionId.trim()) continue;
      rows.push({
        current: data.cliSessionId.trim().toLowerCase(),
        priors: sessionIds(data.priorCliSessionIds),
        archived: data.isArchived === true,
        host: path.basename(file, ".json"),
        title: typeof data.title === "string" ? data.title.trim() : "",
      });
    } catch {
      continue;
    }
  }
  lineageCache.set(claudeDataDir, { signature, rows });
  return rows;
}

/**
 * The desktop row a transcript belongs to. When the desktop app resumes a transcript it forks it,
 * so the id on its claude.exe command line can be an older one; the row lists them all.
 */
export function claudeHostSession(claudeDataDir: string, sessionId: string): string | null {
  const id = sessionId.toLowerCase();
  const rows = claudeSessionLineage(claudeDataDir).filter((row) => !row.archived);
  return (rows.find((row) => row.current === id) ?? rows.find((row) => row.priors.includes(id)))?.host ?? null;
}

/**
 * Transcripts that belong to a desktop session which has already moved on, or been archived.
 * A prior id that is itself the current transcript of another visible session stays listed.
 */
export function foldedClaudeSessionIds(claudeDataDir: string, present: ReadonlySet<string>): Set<string> {
  const rows = claudeSessionLineage(claudeDataDir);
  const visibleCurrents = new Set(rows.filter((row) => !row.archived).map((row) => row.current));
  const hidden = new Set<string>();
  for (const row of rows) {
    const successorShown = !row.archived && present.has(row.current);
    if (!successorShown && !row.archived) continue;
    for (const prior of row.priors) {
      if (!visibleCurrents.has(prior)) hidden.add(prior);
    }
  }
  return hidden;
}

/** The desktop app's own row for a transcript, when it lists one: where to find it in its window. */
export function claudeDesktopSession(claudeDataDir: string, sessionId: string): { host: string; title: string } | null {
  const id = sessionId.toLowerCase();
  const rows = claudeSessionLineage(claudeDataDir).filter((row) => !row.archived);
  const row = rows.find((entry) => entry.current === id) ?? rows.find((entry) => entry.priors.includes(id));
  return row ? { host: row.host, title: row.title } : null;
}

const FILE_ID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

function idsInDir(dir: string, ids: Set<string>): void {
  if (!existsSync(dir)) return;
  const files: string[] = [];
  walkFiles(dir, (name) => name.endsWith(".jsonl"), files);
  for (const file of files) {
    const match = path.basename(file).match(FILE_ID);
    if (match) ids.add(match[1].toLowerCase());
  }
}

export function archivedCodexSessionIds(sessionsDir: string): Set<string> {
  const resolved = path.resolve(sessionsDir);
  const ids = new Set<string>();
  idsInDir(path.join(path.dirname(resolved), "archived_sessions"), ids);
  idsInDir(path.join(resolved, "archived_sessions"), ids);
  return ids;
}

export function isArchivedSessionsDir(dir: string): boolean {
  return path.basename(dir).toLowerCase() === "archived_sessions";
}
