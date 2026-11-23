import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { ParsedSession, TranscriptMessage } from "../shared/types";
import { codexResult, patchSteps } from "../transcript/codexTools";
import { transcriptStamp } from "../transcript/codexHistory";
import { codexDesktopState, type CodexThreadMetadata } from "./codexDesktop";

const PREFIX = "codex-history:";
interface Turn { thread_id: string; turn_id: string; status: string; started_at: number | null; completed_at: number | null }
interface Item { turn_id: string; item_id: string; item_json: string }
interface HistoryDb {
  prepare(sql: string): { all(...args: string[]): unknown[] };
  exec(sql: string): void;
  close(): void;
}
function open(file: string): HistoryDb {
  const require = createRequire(import.meta.url);
  const { DatabaseSync } = require(["node", "sqlite"].join(":"));
  return new DatabaseSync(file, { readOnly: true });
}
function signature(file: string): string {
  return [file, `${file}-wal`].map(transcriptStamp).join("\n");
}
function database(sessionsDir: string): string | null {
  const home = path.dirname(path.resolve(sessionsDir));
  try {
    const files = readdirSync(home).flatMap(name => {
      const match = name.match(/^thread_history_(\d+)\.sqlite$/);
      return match ? [{ name, version: Number(match[1]) }] : [];
    }).sort((a, b) => b.version - a.version);
    return files[0] ? path.join(home, files[0].name) : null;
  } catch { return null; }
}
const statusCache = new Map<string, { signature: string; turns: Map<string, Turn> }>();
const contentCache = new Map<string, { signature: string; session: ParsedSession }>();
const CONTENT_CACHE_LIMIT = 24;
export const isCodexHistoryReference = (file: string) => file.startsWith(PREFIX);

/** The catalog reads only metadata and the latest turn, never every chat body. */
export function listCodexSqliteSessions(sessionsDir: string, threads: Map<string, CodexThreadMetadata>): Array<ParsedSession & { filePath: string }> {
  const file = database(sessionsDir);
  if (!file) return [];
  const stamp = signature(file);
  let hit = statusCache.get(file);
  if (hit?.signature !== stamp) {
    let db: HistoryDb | undefined;
    try {
      db = open(file);
      const rows = db.prepare(`select thread_id, turn_id, status, started_at, completed_at from (
        select *, row_number() over (partition by thread_id order by rollout_ordinal desc) as rank from thread_turns
      ) where rank = 1`).all() as Turn[];
      hit = { signature: stamp, turns: new Map(rows.map(row => [row.thread_id.toLowerCase(), row])) };
      statusCache.set(file, hit);
    } catch { return []; }
    finally { db?.close(); }
  }
  return [...threads.values()].flatMap(thread => {
    const turn = hit!.turns.get(thread.id);
    if (thread.historyMode !== "paginated" || !turn) return [];
    return [{ ...thread, messages: [], turnComplete: turn.status !== "inProgress",
      filePath: `${PREFIX}${encodeURIComponent(file)}:${thread.id}` }];
  });
}

const str = (value: unknown): string => typeof value === "string" ? value : "";
const fields = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
function result(item: Record<string, unknown>, output: unknown) {
  const parsed = codexResult(output);
  const status = item.status === "inProgress" ? "running" : item.status === "failed" || item.status === "declined" ||
    (typeof item.exitCode === "number" && item.exitCode !== 0) ? "error" : "ok";
  return { ...parsed, status } as const;
}
function messagesOf(item: Record<string, unknown>, id: string, cwd: string): TranscriptMessage[] {
  const text = str(item.text);
  switch (item.type) {
    case "userMessage": {
      const content = Array.isArray(item.content) ? item.content : [];
      const text = content.map(part => {
        const block = fields(part);
        return block.type === "text" ? str(block.text) : /image/i.test(str(block.type)) ? "[图片]" : "";
      }).filter(Boolean).join("\n");
      return text ? [{ id, role: "user", text }] : [];
    }
    case "agentMessage": case "plan": return text ? [{ id, role: "assistant", text }] : [];
    case "reasoning": {
      const text = Array.isArray(item.summary) ? item.summary.map(str).filter(Boolean).join("\n").replace(/\*\*(.+?)\*\*/g, "$1") : "";
      return text ? [{ id, role: "thinking", text }] : [];
    }
    case "commandExecution": return [{ id, role: "step", tool: "Ran", text: str(item.command), result: result(item, item.aggregatedOutput) }];
    case "mcpToolCall": return [{ id, role: "step", tool: "Called", server: str(item.server),
      text: `${str(item.server)}.${str(item.tool)}`, result: result(item, fields(item.result).content ?? fields(item.error).message) }];
    case "fileChange": {
      const changes: Record<string, unknown> = {};
      for (const value of Array.isArray(item.changes) ? item.changes : []) {
        const change = fields(value);
        const type = str(fields(change.kind).type);
        changes[str(change.path)] = { type, content: type === "add" ? str(change.diff) : "", unified_diff: str(change.diff) };
      }
      return patchSteps({ changes, success: item.status !== "failed" }, cwd).map((step, index) => ({ id: `${id}:${index}`, role: "step", ...step }));
    }
    case "webSearch": return [{ id, role: "step", tool: "Searched", text: str(item.query), result: { status: "ok" } }];
    case "imageView": return [{ id, role: "step", tool: "Viewed Image", text: str(item.path), result: { status: "ok" } }];
    case "imageGeneration": return [{ id, role: "step", tool: "Generated Image", text: str(item.result) || str(item.revisedPrompt), result: result(item, "") }];
    case "collabAgentToolCall": return [{ id, role: "step", tool: "Called", text: str(item.tool), result: result(item, "") }];
    default: return [];
  }
}

/** Read the projected, user-visible history of one thread. The Codex databases stay read-only. */
export function readCodexSqliteSession(reference: string): ParsedSession | null {
  if (!isCodexHistoryReference(reference)) return null;
  const separator = reference.lastIndexOf(":");
  const file = decodeURIComponent(reference.slice(PREFIX.length, separator));
  const id = reference.slice(separator + 1).toLowerCase();
  const desktop = codexDesktopState(path.join(path.dirname(file), "sessions"));
  const thread = desktop?.threads.get(id);
  if (thread?.historyMode !== "paginated" || desktop?.archived.has(id) || desktop?.subagents.has(id) || desktop?.cliOnly.has(id)) return null;
  const stamp = `${signature(file)}\n${JSON.stringify(thread)}`;
  const hit = contentCache.get(reference);
  if (hit) {
    contentCache.delete(reference);
    if (hit.signature === stamp) {
      contentCache.set(reference, hit);
      return hit.session;
    }
  }
  let db: HistoryDb | undefined;
  try {
    db = open(file);
    db.exec("BEGIN");
    const turns = db.prepare("select thread_id, turn_id, status, started_at, completed_at from thread_turns where thread_id = ? order by rollout_ordinal").all(id) as Turn[];
    const items = db.prepare("select turn_id, item_id, item_json from thread_items where thread_id = ? order by rollout_ordinal, created_at_ms, item_id").all(id) as Item[];
    db.exec("COMMIT");
    const byTurn = new Map<string, TranscriptMessage[]>();
    for (const row of items) {
      try {
        const messages = messagesOf(JSON.parse(row.item_json), `sql:${row.turn_id}:${row.item_id}`, thread.cwd);
        const held = byTurn.get(row.turn_id) ?? [];
        held.push(...messages);
        byTurn.set(row.turn_id, held);
      } catch { /* Ignore one malformed item, not the rest of the chat. */ }
    }
    const messages: TranscriptMessage[] = [];
    let interruptedAt: number | undefined;
    for (const [index, turn] of turns.entries()) {
      messages.push(...byTurn.get(turn.turn_id) ?? []);
      byTurn.delete(turn.turn_id);
      if (turn.status === "interrupted") interruptedAt = messages.length;
      const next = turns[index + 1];
      const endedAt = turn.completed_at ?? next?.started_at;
      if (turn.started_at != null) messages.push({ id: `sql:turn:${turn.turn_id}`, role: "turn", text: "",
        startedAt: new Date(turn.started_at * 1000).toISOString(),
        ...(endedAt != null ? { endedAt: new Date(endedAt * 1000).toISOString() } :
          next || turn.status !== "inProgress" ? { endedAt: thread.updatedAt } : {}),
      });
    }
    for (const remaining of byTurn.values()) messages.push(...remaining);
    const session: ParsedSession = { ...thread, title: desktop?.names.get(id) || thread.title, messages,
      turnComplete: turns.at(-1)?.status !== "inProgress", ...(interruptedAt !== undefined ? { interruptedAt } : {}) };
    contentCache.set(reference, { signature: stamp, session });
    if (contentCache.size > CONTENT_CACHE_LIMIT) {
      const oldest = contentCache.keys().next();
      if (!oldest.done) contentCache.delete(oldest.value);
    }
    return session;
  } catch { return null; }
  finally { db?.close(); }
}
