import { existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { visibleUserText, type CursorBubble } from "../transcript/cursor";

interface SqlStatement {
  all(...args: unknown[]): unknown[];
  run(...args: unknown[]): unknown;
}

interface SqlDatabase {
  prepare(sql: string): SqlStatement;
  exec(sql: string): void;
  close(): void;
}

/** Loaded without a static import so the test runner does not try to bundle node:sqlite. */
function openDatabase(file: string, readOnly: boolean): SqlDatabase {
  const require = createRequire(import.meta.url);
  const sqlite = require(["node", "sqlite"].join(":")) as {
    DatabaseSync: new (location: string, options?: { readOnly?: boolean }) => SqlDatabase;
  };
  return new sqlite.DatabaseSync(file, { readOnly });
}

export interface CursorSessionRecord {
  id: string;
  title: string;
  cwd: string;
  updatedAt: string;
  /** False while Cursor still has an unfinished run. */
  turnComplete: boolean;
  unseen: boolean;
  /** Real transcript file, or `cursor:<id>` when the chat has no transcript yet. */
  filePath: string;
}

interface HeaderRow {
  id: string;
  title: string;
  cwd: string;
  updatedAt: string;
  /** Cursor sets this only while `composerData.status` is `generating`. A stored number can outlive the run. */
  generating: boolean;
  /** Latest composer checkpoint. A run that stopped keeps this still. */
  activeAt: number;
  turnComplete: boolean;
  unseen: boolean;
}

/** After this long with no composer write, a run whose status is not `generating` has stopped. */
const RUN_QUIET_MS = 20_000;

/** The same rule Cursor uses for the sidebar: generating, or a composer that is still being written. */
export function cursorRunOpen(row: { generating: boolean; activeAt: number }): boolean {
  if (row.generating) return true;
  return row.activeAt > 0 && Date.now() - row.activeAt < RUN_QUIET_MS;
}

function present(row: HeaderRow): HeaderRow {
  return { ...row, turnComplete: !cursorRunOpen(row) };
}

const headerCache = new Map<string, { signature: string; at: number; rows: HeaderRow[] }>();
const modelCache = new Map<string, { signature: string; id: string; name: string }>();
const bubbleCache = new Map<string, { signature: string; bubbles: Array<CursorBubble & { key: string }> }>();
let heldDb: { file: string; signature: string; db: SqlDatabase } | null = null;
let transcriptCache: { at: number; dir: string; files: Map<string, string> } = { at: 0, dir: "", files: new Map() };

/** The main file can sit still while new bubbles land in the WAL. */
function dbSignature(file: string): string {
  const stat = statSync(file);
  const extra = ["-wal", "-shm"].map((suffix) => {
    const side = `${file}${suffix}`;
    if (!existsSync(side)) return "";
    const sideStat = statSync(side);
    return `${sideStat.mtimeMs}\0${sideStat.size}`;
  });
  return [stat.mtimeMs, stat.size, ...extra].join("\0");
}

function workspacePath(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const uri = (value as { uri?: { fsPath?: unknown } }).uri;
  const fsPath = uri && typeof uri === "object" ? uri.fsPath : undefined;
  return typeof fsPath === "string" ? fsPath : "";
}

const folderKey = (folder: string) => path.resolve(folder).toLocaleLowerCase();

/** Workspaces the person removed from Cursor's sidebar. Their chats stay on disk but Cursor no longer lists them. */
function removedWorkspaces(db: SqlDatabase): Set<string> {
  const removed = new Set<string>();
  try {
    const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").all("cursor/glass.removedProjects")[0] as { value?: string } | undefined;
    for (const entry of JSON.parse(row?.value ?? "[]") as Array<{ workspaceIdentifier?: unknown }>) {
      const folder = workspacePath(entry.workspaceIdentifier);
      if (folder) removed.add(folderKey(folder));
    }
  } catch {
    /* an older Cursor without this list: nothing is hidden */
  }
  return removed;
}

const pinCache = new Map<string, { signature: string; ids: Set<string> }>();

/** Chats pinned in Cursor's sidebar. Cursor keeps the list beside the main database, in its window-less workspace store. */
export function pinnedCursorIds(stateDb: string | undefined): Set<string> {
  if (!stateDb) return new Set();
  const file = path.join(path.dirname(path.dirname(stateDb)), "workspaceStorage", "empty-window", "state.vscdb");
  if (!existsSync(file)) return new Set();
  let signature: string;
  try {
    signature = dbSignature(file);
  } catch {
    return new Set();
  }
  const hit = pinCache.get(file);
  if (hit?.signature === signature) return hit.ids;
  const ids = new Set<string>();
  let db: SqlDatabase | null = null;
  try {
    db = openDatabase(file, true);
    const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").all("cursor/pinnedComposers")[0] as { value?: string } | undefined;
    for (const id of JSON.parse(row?.value ?? "[]") as unknown[]) {
      if (typeof id === "string" && id.trim()) ids.add(id.trim().toLowerCase());
    }
  } catch {
    return hit?.ids ?? ids;
  } finally {
    db?.close();
  }
  pinCache.set(file, { signature, ids });
  return ids;
}

function readHeaders(stateDb: string): HeaderRow[] {
  if (!stateDb || !existsSync(stateDb)) return [];
  const signature = dbSignature(stateDb);
  const hit = headerCache.get(stateDb);
  if (hit && (hit.signature === signature || Date.now() - hit.at < 1000)) return hit.rows;
  const rows: HeaderRow[] = [];
  let db: SqlDatabase | null = null;
  try {
    db = openDatabase(stateDb, true);
    const query = db.prepare(
      "SELECT composerId, isArchived, isSubagent, value FROM composerHeaders",
    );
    const activity = db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?");
    const removed = removedWorkspaces(db);
    for (const row of query.all() as Array<{ composerId: string; isArchived: number; isSubagent: number; value: string }>) {
      if (row.isArchived || row.isSubagent) continue;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.composerId)) continue;
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(row.value) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (data.isDraft === true || data.isProject === true || data.isSpec === true) continue;
      const cwd = workspacePath(data.workspaceIdentifier);
      if (!cwd || removed.has(folderKey(cwd))) continue;
      // A chat that was opened but never written in has no name and no activity; Cursor does not list it.
      const used = typeof data.lastUpdatedAt === "number" && data.lastUpdatedAt > 0;
      if (!used && !(typeof data.name === "string" && data.name.trim())) continue;
      const updated =
        typeof data.lastUpdatedAt === "number" && data.lastUpdatedAt > 0
          ? data.lastUpdatedAt
          : typeof data.createdAt === "number"
            ? data.createdAt
            : 0;
      const name = typeof data.name === "string" ? data.name.trim() : "";
      const subtitle = typeof data.subtitle === "string" ? data.subtitle.replace(/\s+/g, " ").trim() : "";
      const unfinished = typeof data.unfinishedRunAt === "number";
      let generating = unfinished;
      let activeAt = unfinished ? data.unfinishedRunAt : 0;
      if (unfinished) {
        const stored = activity.all(`composerData:${row.composerId}`)[0] as { value?: string } | undefined;
        if (stored && typeof stored.value === "string") {
          try {
            const composer = JSON.parse(stored.value) as { status?: unknown; conversationCheckpointLastUpdatedAt?: unknown; lastUpdatedAt?: unknown };
            const checkpoint = typeof composer.conversationCheckpointLastUpdatedAt === "number" ? composer.conversationCheckpointLastUpdatedAt : 0;
            const touched = typeof composer.lastUpdatedAt === "number" ? composer.lastUpdatedAt : 0;
            generating = composer.status === "generating";
            activeAt = Math.max(checkpoint, touched);
          } catch {
            generating = unfinished;
          }
        }
      }
      rows.push({
        id: row.composerId,
        title: name || Array.from(subtitle).slice(0, 42).join("") || "新会话",
        cwd,
        updatedAt: new Date(updated).toISOString(),
        generating,
        activeAt: typeof activeAt === "number" ? activeAt : 0,
        turnComplete: false,
        unseen: data.hasUnreadMessages === true,
      });
    }
  } catch {
    return hit?.rows ?? [];
  } finally {
    db?.close();
  }
  headerCache.set(stateDb, { signature, at: Date.now(), rows });
  return rows;
}

function transcriptFiles(projectsDir: string): Map<string, string> {
  const now = Date.now();
  if (transcriptCache.dir === projectsDir && now - transcriptCache.at < 5000) return transcriptCache.files;
  const files = new Map<string, string>();
  if (projectsDir && existsSync(projectsDir)) {
    let projects: string[] = [];
    try {
      projects = readdirSync(projectsDir);
    } catch {
      projects = [];
    }
    for (const project of projects) {
      const transcripts = path.join(projectsDir, project, "agent-transcripts");
      if (!existsSync(transcripts)) continue;
      let sessions: string[] = [];
      try {
        sessions = readdirSync(transcripts);
      } catch {
        continue;
      }
      for (const id of sessions) {
        const file = path.join(transcripts, id, `${id}.jsonl`);
        if (existsSync(file)) files.set(id.toLowerCase(), file);
      }
    }
  }
  transcriptCache = { at: now, dir: projectsDir, files };
  return files;
}

function toolInput(params: unknown, rawArgs: unknown): unknown {
  const text = typeof params === "string" && params.trim() ? params : typeof rawArgs === "string" ? rawArgs : "";
  if (params && typeof params === "object") return params;
  if (!text) return "";
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    return text;
  }
  return text;
}

/** A connection kept open across writes keeps seeing the old snapshot, so a new WAL means a new connection. */
function database(file: string, signature: string): SqlDatabase {
  if (heldDb?.file === file && heldDb.signature === signature) return heldDb.db;
  heldDb?.db.close();
  const db = openDatabase(file, true);
  heldDb = { file, signature, db };
  return db;
}

function bubbleFrom(key: string, prefix: string, value: string): CursorBubble | null {
  if (!key.startsWith(prefix)) return null;
  let blob: Record<string, unknown>;
  try {
    blob = JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
  const type = blob.type;
  if (type !== 1 && type !== 2) return null;
  // Cursor stores a reply in pieces under the question's id (`…/s:3`). The pieces with words in them are
  // the sentences it has written so far; the rest are its private reasoning, which its own panel folds away.
  if (key.includes("/s:") && !(type === 2 && typeof blob.text === "string" && blob.text.trim())) return null;
  const tool = blob.toolFormerData;
  const record = tool && typeof tool === "object" ? (tool as Record<string, unknown>) : {};
  const toolName = typeof record.name === "string" ? record.name.trim() : "";
  const status = typeof record.status === "string" ? record.status : "";
  return {
    type,
    text: typeof blob.text === "string" ? blob.text : "",
    createdAt: typeof blob.createdAt === "string" ? blob.createdAt : "",
    toolName,
    toolInput: toolName ? toolInput(record.params, record.rawArgs) : "",
    failed: status === "error" || status === "cancelled",
    running: status === "loading" || status === "running",
  };
}

function bubbleValues(db: SqlDatabase, keys: string[]): Array<{ key: string; value: string }> {
  const query = db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?");
  const rows: Array<{ key: string; value: string }> = [];
  for (const key of keys) {
    const row = query.all(key)[0] as { value?: string } | undefined;
    if (typeof row?.value === "string") rows.push({ key, value: row.value });
  }
  return rows;
}

/**
 * Composer bubbles for one chat.
 * Bubble ids are random, so a later one can sort before an earlier one.
 * A later read therefore looks up new ids instead of continuing from the last key,
 * and reloads the open round so a call can leave `loading`.
 */
export function readCursorBubbles(stateDb: string | undefined, id: string): CursorBubble[] {
  if (!stateDb || !existsSync(stateDb)) return [];
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return [];
  const signature = dbSignature(stateDb);
  const cacheKey = `${stateDb}\0${id.toLowerCase()}`;
  const hit = bubbleCache.get(cacheKey);
  if (hit?.signature === signature) return hit.bubbles;
  const prefix = `bubbleId:${id}:`;
  const byKey = new Map((hit?.bubbles ?? []).map((bubble) => [bubble.key, bubble]));
  try {
    const db = database(stateDb, signature);
    if (byKey.size === 0) {
      const query = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key >= ? AND key < ?");
      for (const row of query.all(prefix, `${prefix}\uffff`) as Array<{ key: string; value: string }>) {
        const bubble = bubbleFrom(row.key, prefix, row.value);
        if (bubble) byKey.set(row.key, { ...bubble, key: row.key });
      }
    } else {
      const listed = db.prepare("SELECT key FROM cursorDiskKV WHERE key >= ? AND key < ?").all(prefix, `${prefix}\uffff`) as Array<{ key: string }>;
      const present = new Set<string>();
      const missing: string[] = [];
      const pieces: string[] = [];
      for (const row of listed) {
        present.add(row.key);
        if (row.key.includes("/s:")) {
          pieces.push(row.key);
          continue;
        }
        if (!byKey.has(row.key)) missing.push(row.key);
      }
      for (const key of byKey.keys()) if (!present.has(key)) byKey.delete(key);
      const arrived = new Set(missing);
      for (const row of bubbleValues(db, missing)) {
        const bubble = bubbleFrom(row.key, prefix, row.value);
        if (bubble) byKey.set(row.key, { ...bubble, key: row.key });
      }
      let liveAt = "";
      let liveKey = "";
      for (const bubble of byKey.values()) {
        if (bubble.type === 1 && bubble.createdAt > liveAt && visibleUserText(bubble.text)) {
          liveAt = bubble.createdAt;
          liveKey = bubble.key;
        }
      }
      // The pieces of the reply being written hang under the latest question and keep changing,
      // so they are read again each time. Pieces of earlier replies were read once and stay as they are.
      if (liveKey) {
        const livePieces = pieces.filter((key) => key.startsWith(`${liveKey}/s:`));
        for (const row of bubbleValues(db, livePieces)) {
          const bubble = bubbleFrom(row.key, prefix, row.value);
          if (bubble) byKey.set(row.key, { ...bubble, key: row.key });
          else byKey.delete(row.key);
          arrived.add(row.key);
        }
      }
      const refresh: string[] = [];
      for (const bubble of byKey.values()) {
        if (liveAt && bubble.createdAt >= liveAt && !arrived.has(bubble.key)) refresh.push(bubble.key);
      }
      for (const row of bubbleValues(db, refresh)) {
        const bubble = bubbleFrom(row.key, prefix, row.value);
        if (bubble) byKey.set(row.key, { ...bubble, key: row.key });
        else byKey.delete(row.key);
      }
    }
  } catch {
    heldDb?.db.close();
    heldDb = null;
    return hit?.bubbles ?? [];
  }
  const bubbles = [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  bubbleCache.set(cacheKey, { signature, bubbles });
  return bubbles;
}

export function cursorMeta(stateDb: string | undefined, id: string): HeaderRow | null {
  if (!stateDb) return null;
  const row = readHeaders(stateDb).find((item) => item.id.toLowerCase() === id.toLowerCase());
  return row ? present(row) : null;
}

/** Chats Cursor shows in its own sidebar, one per composer, grouped later by workspace. */
export function listCursorSessions(stateDb: string | undefined, projectsDir: string | undefined): CursorSessionRecord[] {
  if (!stateDb) return [];
  const files = transcriptFiles(projectsDir ?? "");
  return readHeaders(stateDb).map((row) => ({
    ...present(row),
    filePath: files.get(row.id.toLowerCase()) ?? `cursor:${row.id}`,
  }));
}

/** The text of each item still waiting in Cursor's own queue. Items that have started are no longer here. */
export function queueQueries(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const texts: string[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const query = (item as { query?: unknown }).query;
    if (typeof query === "string" && query.trim()) texts.push(query);
  }
  return texts;
}

/** `null` when the composer cannot be read. An empty list means Cursor is not holding anything. */
export function readCursorQueue(stateDb: string | undefined, composerId: string): string[] | null {
  if (!stateDb || !composerId || !existsSync(stateDb)) return null;
  try {
    const db = database(stateDb, dbSignature(stateDb));
    const row = db
      .prepare("SELECT json_extract(value, '$.queueItems') AS items FROM cursorDiskKV WHERE key = ?")
      .all(`composerData:${composerId}`)[0] as { items?: unknown } | undefined;
    if (!row) return null;
    const items = row.items;
    if (typeof items === "string") return queueQueries(JSON.parse(items) as unknown);
    if (Array.isArray(items)) return queueQueries(items);
    return [];
  } catch {
    return null;
  }
}

/** Model selected on the chat Cursor touched most recently. Empty when the database has none. */
export function cursorActiveModel(stateDb: string | undefined): string {
  if (!stateDb || !existsSync(stateDb)) return "";
  const rows = readHeaders(stateDb);
  let latest: HeaderRow | undefined;
  for (const row of rows) {
    if (!latest || row.updatedAt > latest.updatedAt) latest = row;
  }
  if (!latest) return "";
  return cursorChatModel(stateDb, latest.id);
}

/** Model selected on one Cursor chat. Empty when the database does not say. */
export function cursorChatModel(stateDb: string | undefined, id: string): string {
  if (!stateDb || !id || !existsSync(stateDb)) return "";
  let signature: string;
  try {
    signature = dbSignature(stateDb);
  } catch {
    return "";
  }
  const key = `${stateDb}\n${id}`;
  const hit = modelCache.get(key);
  if (hit && hit.signature === signature) return hit.name;
  try {
    const db = database(stateDb, signature);
    const row = db
      .prepare("SELECT json_extract(value, '$.modelConfig.modelName') AS name FROM cursorDiskKV WHERE key = ?")
      .all(`composerData:${id}`)[0] as { name?: unknown } | undefined;
    const name = typeof row?.name === "string" ? row.name : "";
    modelCache.set(key, { signature, id, name });
    return name;
  } catch {
    return hit?.name ?? "";
  }
}

/** Test hook: the header cache would otherwise hide a fixture written a moment ago with the same mtime. */
/** Drops the open snapshot so the file can be written. Cached bubbles stay. */
export function closeCursorDatabase(): void {
  heldDb?.db.close();
  heldDb = null;
}

export function clearCursorCache(): void {
  headerCache.clear();
  modelCache.clear();
  pinCache.clear();
  bubbleCache.clear();
  closeCursorDatabase();
  transcriptCache = { at: 0, dir: "", files: new Map() };
}
