import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ToolId } from "../shared/types";
import { claudeSessionLineage } from "./archive";
import type { CatalogRoots } from "./readCatalog";

const SESSION_ID = /^[0-9a-z][0-9a-z_-]{5,127}$/i;

/** Ids of Cursor chats deleted from the page. Cursor keeps them in its own database, so they are only left out. */
export function hiddenSessionIds(file: string | undefined): Set<string> {
  if (!file) return new Set();
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as { cursor?: unknown };
    return new Set(Array.isArray(value.cursor) ? value.cursor.filter((id): id is string => typeof id === "string").map((id) => id.toLowerCase()) : []);
  } catch {
    return new Set();
  }
}

function hide(file: string, id: string): void {
  const ids = hiddenSessionIds(file);
  ids.add(id.toLowerCase());
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ cursor: [...ids] }, null, 2));
  renameSync(temp, file);
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * The transcripts of one Claude session: its own file, and the earlier files the desktop app folded into the same row
 * (left behind, they would show up again as sessions of their own). Each comes with the folder of the same name
 * that holds its subagent and tool-result files.
 */
function claudeTargets(roots: CatalogRoots, id: string): string[] {
  const key = id.toLowerCase();
  const rows = claudeSessionLineage(roots.claudeDataDir ?? "");
  const currents = new Set(rows.filter((row) => !row.archived).map((row) => row.current));
  const own = rows.find((row) => row.current === key);
  // An earlier file that is itself the current transcript of another row belongs to that row.
  const ids = new Set([key, ...(own?.priors ?? []).filter((prior) => !currents.has(prior))]);
  const found: string[] = [];
  if (!existsSync(roots.claudeProjectsDir)) return found;
  for (const project of readdirSync(roots.claudeProjectsDir, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const dir = path.join(roots.claudeProjectsDir, project.name);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const lower = entry.name.toLowerCase();
      if (entry.isFile() && lower.endsWith(".jsonl") && ids.has(lower.slice(0, -".jsonl".length))) found.push(path.join(dir, entry.name));
      else if (entry.isDirectory() && ids.has(lower)) found.push(path.join(dir, entry.name));
    }
  }
  return found;
}

/** Every rollout file Codex wrote for the thread: a resumed thread has more than one. Archived copies are left alone. */
function codexTargets(roots: CatalogRoots, id: string): string[] {
  const key = id.toLowerCase();
  const found: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.toLowerCase() !== "archived_sessions") walk(full);
      } else if (entry.name.toLowerCase().endsWith(".jsonl") && entry.name.toLowerCase().includes(key)) {
        found.push(full);
      }
    }
  };
  walk(roots.codexSessionsDir);
  return found;
}

export interface DeleteResult {
  /** Files and folders removed from disk. */
  removed: string[];
  /** Left out of the list only, because the tool keeps it in its own database (Cursor). */
  hidden: boolean;
}

/** Removes a session for good: its transcript files are deleted from disk; a Cursor chat is hidden from the list. */
export function deleteSession(tool: ToolId, id: string, roots: CatalogRoots): DeleteResult {
  if (!SESSION_ID.test(id)) throw new Error("bad_id");
  if (tool === "cursor") {
    if (!roots.hiddenSessionsFile) throw new Error("no_store");
    hide(roots.hiddenSessionsFile, id);
    return { removed: [], hidden: true };
  }
  const root = tool === "claude" ? roots.claudeProjectsDir : roots.codexSessionsDir;
  const targets = (tool === "claude" ? claudeTargets(roots, id) : codexTargets(roots, id)).filter((target) => inside(root, target));
  const removed: string[] = [];
  for (const target of targets) {
    const folder = statSync(target).isDirectory();
    rmSync(target, { recursive: folder, force: true });
    removed.push(target);
  }
  return { removed, hidden: false };
}
