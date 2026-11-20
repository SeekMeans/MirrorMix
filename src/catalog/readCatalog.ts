import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { ParsedSession, SessionSummary, ToolId, TranscriptMessage, WorkspaceGroup } from "../shared/types";
import { parseClaudeJsonl, settleAbandoned } from "../transcript/claude";
import { parseCodexJsonl } from "../transcript/codex";
import { resolveClaudeDataDir } from "./claudeData";
import { readCodexHistory, transcriptStamp } from "../transcript/codexHistory";
import { parseDeepseekEvents, readDshEvents } from "../transcript/deepseek";
import { liveTurnBubbles, mergeLiveTurn, parseCursorBubbles, parseCursorJsonl } from "../transcript/cursor";
import { unseenClaudeSessionIds, unseenCodexSessionIds } from "./attention";
import { archivedClaudeSessionIds, archivedCodexSessionIds, foldedClaudeSessionIds, isArchivedSessionsDir } from "./archive";
import { codexDesktopState, codexPathKey, codexThreadName, plainPath, type CodexDesktopState } from "./codexDesktop";
import { cursorMeta, listCursorSessions, pinnedCursorIds, readCursorBubbles } from "./cursor";
import { pinnedClaudeSessionIds, pinnedCodexSessionIds } from "./pins";
import { hiddenSessionIds } from "./deleteSession";
import { readQuotas, type QuotaSnapshot } from "./quotas";

export interface CatalogRoots {
  claudeProjectsDir: string;
  codexSessionsDir: string;
  claudeDataDir?: string;
  /** Cursor's state.vscdb. Absent in tests that only build Claude and Codex fixtures. */
  cursorStateDb?: string;
  cursorProjectsDir?: string;
  /** DeepSeek Harness's sessions folder (`~/.dsh/sessions`). */
  deepseekSessionsDir?: string;
  /** MirrorMix's own list of Cursor chats deleted from the page. */
  hiddenSessionsFile?: string;
}

export interface Catalog {
  claude: WorkspaceGroup[];
  codex: WorkspaceGroup[];
  cursor: WorkspaceGroup[];
  deepseek: WorkspaceGroup[];
  quotas: QuotaSnapshot;
}

export interface StoredSession extends ParsedSession {
  filePath: string;
}

const cache = new Map<string, { mtimeMs: number; size: number; parsed: ParsedSession | null; live?: boolean; historyStamp?: string }>();
const codexHistoryFiles = new Map<string, string[]>();

function walkJsonl(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.toLowerCase() === "archived_sessions") continue;
      found.push(...walkJsonl(full));
    }
    else if (entry.name.endsWith(".jsonl")) found.push(full);
  }
  return found;
}

export function listClaudeSessionFiles(projectsDir: string): string[] {
  if (!existsSync(projectsDir)) return [];
  const files: string[] = [];
  for (const project of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const dir = path.join(projectsDir, project.name);
    for (const name of readdirSync(dir)) {
      if (name.endsWith(".jsonl")) files.push(path.join(dir, name));
    }
  }
  return files;
}

/** One file per session: `<sessions>/<encoded folder>/session-<id>/session.v4.jsonl.zstd`. */
export function listDeepseekSessionFiles(sessionsDir: string | undefined): string[] {
  if (!sessionsDir || !existsSync(sessionsDir)) return [];
  const files: string[] = [];
  for (const project of readdirSync(sessionsDir, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const dir = path.join(sessionsDir, project.name);
    for (const session of readdirSync(dir, { withFileTypes: true })) {
      if (!session.isDirectory()) continue;
      const file = path.join(dir, session.name, "session.v4.jsonl.zstd");
      if (existsSync(file)) files.push(file);
    }
  }
  return files;
}

/** Where a DeepSeek Harness session's file is, by its id (its folder carries the id as its name). */
export function deepseekSessionFile(sessionsDir: string | undefined, id: string): string | null {
  if (!sessionsDir || !existsSync(sessionsDir)) return null;
  for (const project of readdirSync(sessionsDir, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const file = path.join(sessionsDir, project.name, id, "session.v4.jsonl.zstd");
    if (existsSync(file)) return file;
  }
  return null;
}

export function listCodexSessionFiles(sessionsDir: string): string[] {
  if (isArchivedSessionsDir(sessionsDir)) return [];
  const files = walkJsonl(sessionsDir);
  for (const file of files) codexHistoryFiles.set(file, files);
  return files;
}

function applyCursorMeta(parsed: ParsedSession, stateDb: string | undefined): ParsedSession {
  const meta = cursorMeta(stateDb, parsed.id);
  if (!meta) return parsed;
  return { ...parsed, cwd: meta.cwd || parsed.cwd, title: meta.title || parsed.title, turnComplete: meta.turnComplete, updatedAt: meta.updatedAt };
}

function cursorFromBubbles(id: string, stateDb: string | undefined): ParsedSession | null {
  const meta = cursorMeta(stateDb, id);
  if (!meta) return null;
  const bubbles = readCursorBubbles(stateDb, id);
  if (!bubbles.length) {
    return { id: meta.id, cwd: meta.cwd, title: meta.title, updatedAt: meta.updatedAt, messages: [], turnComplete: meta.turnComplete };
  }
  const parsed = applyCursorMeta(parseCursorBubbles(meta.id, bubbles, meta.updatedAt, meta.cwd, meta.turnComplete), stateDb);
  return parsed.turnComplete ? closeCursor(parsed) : parsed;
}

function closeCursor(parsed: ParsedSession): ParsedSession {
  const endedAt = parsed.updatedAt;
  const messages = parsed.messages.map((message) => {
    if (message.role === "turn" && !message.endedAt) return { ...message, endedAt };
    if (message.role === "step" && message.result?.status === "running") return { ...message, result: { ...message.result, status: "ok" as const } };
    return message;
  });
  return { ...parsed, messages, turnComplete: true };
}

function withLiveTurn(parsed: ParsedSession, stateDb: string | undefined): ParsedSession {
  const idle = parsed.turnComplete;
  const openTail = parsed.messages.some((message) => message.role === "turn" && !message.endedAt);
  const live = !idle || openTail ? liveTurnBubbles(readCursorBubbles(stateDb, parsed.id)) : [];
  let next = parsed;
  if (live.length && (!idle || openTail)) {
    const fresh = parseCursorBubbles(parsed.id, live, parsed.updatedAt, parsed.cwd, idle);
    if (fresh.messages.length) {
      let end = 0;
      parsed.messages.forEach((message, index) => {
        if (message.role === "turn" && message.endedAt) end = index + 1;
      });
      next = { ...parsed, messages: [...parsed.messages.slice(0, end), ...mergeLiveTurn(parsed.messages.slice(end), fresh.messages)], turnComplete: idle };
    }
  }
  return next.turnComplete ? closeCursor(next) : next;
}

function finishCursor(parsed: ParsedSession, stateDb?: string): ParsedSession {
  return withLiveTurn(applyCursorMeta(parsed, stateDb), stateDb);
}

function readParsed(tool: ToolId, filePath: string, stateDb?: string): ParsedSession | null {
  if (tool === "cursor" && filePath.startsWith("cursor:")) return cursorFromBubbles(filePath.slice("cursor:".length), stateDb);
  const stat = statSync(filePath);
  const hit = cache.get(filePath);
  const historyFiles = codexHistoryFiles.get(filePath) ?? [filePath];
  const historyStamp = (id: string) => historyFiles
    .filter((file) => file === filePath || path.basename(file).includes(id)).map(transcriptStamp).join("\n");
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size &&
    (tool !== "codex" || !hit.parsed || hit.historyStamp === historyStamp(hit.parsed.id))) {
    if ((tool === "claude" || tool === "deepseek") && hit.parsed) return settleAbandoned(hit.parsed);
    return tool === "cursor" && hit.parsed ? finishCursor(hit.parsed, stateDb) : hit.parsed;
  }
  let parsed: ParsedSession | null = null;
  let live = false;
  try {
    const content = tool === "codex" ? readCodexHistory(filePath, historyFiles) : tool === "deepseek" ? "" : readFileSync(filePath, "utf8");
    if (tool === "claude") parsed = parseClaudeJsonl(path.basename(filePath), content, stat.mtime.toISOString());
    else if (tool === "codex") parsed = parseCodexJsonl(content, stat.mtime.toISOString());
    else if (tool === "deepseek") parsed = parseDeepseekEvents(readDshEvents(readFileSync(filePath)), stat.mtime.toISOString());
    else {
      const id = path.basename(filePath, ".jsonl");
      const meta = cursorMeta(stateDb, id);
      parsed = parseCursorJsonl(id, content, stat.mtime.toISOString(), meta?.cwd ?? "");
      live = parsed.messages.length > 0;
      if (!live) {
        const fromBubbles = cursorFromBubbles(id, stateDb);
        if (fromBubbles?.messages.length) parsed = fromBubbles;
      }
    }
  } catch {
    parsed = null;
  }
  cache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, parsed, live,
    historyStamp: tool === "codex" && parsed ? historyStamp(parsed.id) : undefined });
  if ((tool === "claude" || tool === "deepseek") && parsed) return settleAbandoned(parsed);
  return tool === "cursor" && parsed ? finishCursor(parsed, stateDb) : parsed;
}

/** Reads one transcript without walking every session directory. */
export function readSession(tool: ToolId, filePath: string, stateDb?: string): StoredSession | null {
  try {
    const parsed = readParsed(tool, filePath, stateDb);
    if (!parsed?.cwd) return null;
    const name = tool === "codex" ? codexThreadName(parsed.id) : undefined;
    return { ...parsed, ...(name ? { title: name } : {}), filePath };
  } catch {
    return null;
  }
}

function claudeDataDir(roots: CatalogRoots): string | null {
  if (roots.claudeDataDir !== undefined) return roots.claudeDataDir || null;
  return resolveClaudeDataDir() || null;
}

export function indexSessions(roots: CatalogRoots): { claude: StoredSession[]; codex: StoredSession[]; cursor: StoredSession[]; deepseek: StoredSession[] } {
  const dataDir = claudeDataDir(roots) ?? "";
  const hiddenClaude = archivedClaudeSessionIds(dataDir);
  const hiddenCodex = archivedCodexSessionIds(roots.codexSessionsDir);
  const desktop = codexDesktopState(roots.codexSessionsDir);
  const claude = listClaudeSessionFiles(roots.claudeProjectsDir).flatMap((filePath) => {
    const parsed = readParsed("claude", filePath);
    if (!parsed || hiddenClaude.has(parsed.id.toLowerCase())) return [];
    return [{ ...parsed, filePath }];
  });
  const folded = foldedClaudeSessionIds(dataDir, new Set(claude.map((session) => session.id.toLowerCase())));
  const visibleClaude = claude.filter((session) => !folded.has(session.id.toLowerCase()));
  const codexById = new Map<string, StoredSession>();
  for (const filePath of listCodexSessionFiles(roots.codexSessionsDir)) {
    const parsed = readParsed("codex", filePath);
    if (!parsed || hiddenCodex.has(parsed.id.toLowerCase())) continue;
    const id = parsed.id.toLowerCase();
    // Threads a parent spawned, and ones archived inside the app, are not sessions of their own there.
    if (desktop?.subagents.has(id) || desktop?.archived.has(id)) continue;
    const name = desktop?.names.get(id);
    const current = codexById.get(id);
    const active = desktop?.rolloutPaths.get(id);
    const isActive = (file: string) => active !== undefined && codexPathKey(file) === codexPathKey(active);
    // The database selects the resumed file; without it, use the most recently written transcript.
    if (current && (isActive(current.filePath) || (!isActive(filePath) && current.updatedAt >= parsed.updatedAt))) continue;
    codexById.set(id, { ...parsed, cwd: plainPath(parsed.cwd), ...(name ? { title: name } : {}), filePath });
  }
  const codex = [...codexById.values()];
  const hiddenCursor = hiddenSessionIds(roots.hiddenSessionsFile);
  const cursor = listCursorSessions(roots.cursorStateDb, roots.cursorProjectsDir)
    .filter((session) => !hiddenCursor.has(session.id.toLowerCase()))
    .map((session) => ({
    id: session.id,
    cwd: session.cwd,
    title: session.title,
    updatedAt: session.updatedAt,
    messages: [],
    turnComplete: session.turnComplete,
    filePath: session.filePath,
  }));
  // A session the app opened but nobody wrote in yet holds only its header; the app shows it as empty, so it is left out.
  const deepseek = listDeepseekSessionFiles(roots.deepseekSessionsDir).flatMap((filePath) => {
    const parsed = readParsed("deepseek", filePath);
    if (!parsed || !parsed.messages.some((message) => message.role === "user")) return [];
    return [{ ...parsed, filePath }];
  });
  return { claude: visibleClaude, codex, cursor, deepseek };
}

function summaryOf(tool: ToolId, session: StoredSession, pinned: Set<string>, unseen: Set<string>): SessionSummary {
  const working = !session.turnComplete;
  return {
    tool,
    id: session.id,
    title: session.title,
    updatedAt: session.updatedAt,
    status: "idle" as const,
    pinned: pinned.has(session.id.toLowerCase()),
    working,
    unseen: working ? false : unseen.has(session.id.toLowerCase()),
  };
}

/**
 * Lays Codex sessions out the way its desktop app does: one group per project, in the app's order,
 * each holding its assigned threads (or matching working folders); then threads without a project.
 * Sessions whose folder is not a project there are left out, as the app leaves them out.
 */
function groupCodex(sessions: StoredSession[], pinned: Set<string>, unseen: Set<string>, desktop: CodexDesktopState): WorkspaceGroup[] {
  const when = (session: StoredSession) => desktop.recency.get(session.id.toLowerCase()) ?? session.updatedAt;
  const newestFirst = (list: StoredSession[]) => [...list].sort((a, b) => (when(a) < when(b) ? 1 : -1));
  const summaries = (list: StoredSession[]) => newestFirst(list).map((session) => summaryOf("codex", session, pinned, unseen));

  const byProject = new Map<string, StoredSession[]>(desktop.projects.map((root) => [codexPathKey(root), []]));
  const loose: StoredSession[] = [];
  for (const session of sessions) {
    if (desktop.projectless.has(session.id.toLowerCase())) loose.push(session);
    else {
      const assigned = desktop.threadRoots.get(session.id.toLowerCase());
      byProject.get(codexPathKey(assigned ?? session.cwd))?.push(session);
    }
  }

  const groups: WorkspaceGroup[] = desktop.projects.map((root) => ({
    path: plainPath(root),
    missing: !existsSync(plainPath(root)),
    sessions: summaries(byProject.get(codexPathKey(root)) ?? []),
  }));
  if (loose.length) {
    const root = desktop.projectlessRoot ? plainPath(desktop.projectlessRoot) : path.dirname(newestFirst(loose)[0].cwd);
    groups.push({ path: root, label: "任务", missing: !existsSync(root), sessions: summaries(loose) });
  }
  return groups.map(group => desktop.pinnedProjects.has(codexPathKey(group.path)) || group.sessions.some(session => session.pinned)
    ? { ...group, pinned: true } : group);
}

function group(tool: ToolId, sessions: StoredSession[], pinned: Set<string>, unseen: Set<string>): WorkspaceGroup[] {
  const groups = new Map<string, { path: string; sessions: StoredSession[] }>();
  for (const session of sessions) {
    const key = path.resolve(session.cwd).toLocaleLowerCase();
    const current = groups.get(key);
    if (!current) groups.set(key, { path: session.cwd, sessions: [session] });
    else {
      current.sessions.push(session);
      if (!existsSync(current.path) && existsSync(session.cwd)) current.path = session.cwd;
    }
  }
  return [...groups.values()]
    .map((entry) => {
      const ordered = [...entry.sessions].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
      const summaries: SessionSummary[] = ordered.map((session) => {
        const working = !session.turnComplete;
        return {
          tool,
          id: session.id,
          title: session.title,
          updatedAt: session.updatedAt,
          status: "idle" as const,
          pinned: pinned.has(session.id.toLowerCase()),
          working,
          unseen: working ? false : unseen.has(session.id.toLowerCase()),
        };
      });
      return {
        path: entry.path,
        missing: !existsSync(entry.path),
        sessions: summaries,
        latest: ordered[0]?.updatedAt ?? "",
      };
    })
    .sort((a, b) => (a.latest < b.latest ? 1 : -1))
    .map(({ latest: _latest, ...groupValue }) => groupValue.sessions.some(session => session.pinned)
      ? { ...groupValue, pinned: true } : groupValue);
}

function codexGroups(roots: CatalogRoots, sessions: StoredSession[]): WorkspaceGroup[] {
  const pinned = new Set(pinnedCodexSessionIds(roots.codexSessionsDir));
  const unseen = unseenCodexSessionIds(roots.codexSessionsDir);
  const desktop = codexDesktopState(roots.codexSessionsDir);
  return desktop?.projects.length ? groupCodex(sessions, pinned, unseen, desktop) : group("codex", sessions, pinned, unseen);
}

export function readCatalog(roots: CatalogRoots): Catalog {
  const indexed = indexSessions(roots);
  const dataDir = claudeDataDir(roots) ?? "";
  const cursorUnseen = new Set(
    listCursorSessions(roots.cursorStateDb, roots.cursorProjectsDir)
      .filter((session) => session.unseen)
      .map((session) => session.id.toLowerCase()),
  );
  return {
    claude: group("claude", indexed.claude, pinnedClaudeSessionIds(dataDir), unseenClaudeSessionIds(dataDir)),
    codex: codexGroups(roots, indexed.codex),
    cursor: group("cursor", indexed.cursor, pinnedCursorIds(roots.cursorStateDb), cursorUnseen),
    deepseek: group("deepseek", indexed.deepseek, new Set(), new Set()),
    quotas: readQuotas(roots),
  };
}
