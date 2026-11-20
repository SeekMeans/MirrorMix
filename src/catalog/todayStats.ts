import path from "node:path";
import type { ParsedSession, ToolId } from "../shared/types";

const TOOLS: ToolId[] = ["claude", "codex", "cursor", "deepseek"];

export interface ToolDay {
  /** Messages sent: each starts a round (a "turn" in the transcript). */
  messages: number;
  /** Conversations with at least one message today. */
  conversations: number;
  /** Of those, the ones whose very first message was today. */
  started: number;
  /** Time the AI spent replying to today's messages (ms). */
  busyMs: number;
  /** Output tokens of today's replies, where the tool records them. */
  tokens: number;
}

export interface DayConversation {
  tool: ToolId;
  id: string;
  title: string;
  /** The project folder's name. */
  place: string;
  messages: number;
  /** When the latest of today's messages was sent (ms). */
  lastAt: number;
}

/** Today's conversations: all tools together, each tool, and the busiest conversations. */
export interface TodayStats {
  total: number;
  conversations: number;
  started: number;
  busyMs: number;
  tokens: number;
  byTool: Record<ToolId, ToolDay>;
  /** Most messages first, then the most recent; at most `TOP`. */
  top: DayConversation[];
  /** Start of the day counted, local time on this computer (ms). */
  since: number;
}

const TOP = 6;
/** A round still open has no end yet; it counts up to now, but never more than this, so a hung one does not swamp the day. */
const OPEN_ROUND_CAP_MS = 30 * 60_000;

/** Midnight at the start of today on this computer. */
export function startOfToday(now = Date.now()): number {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

const empty = (): ToolDay => ({ messages: 0, conversations: 0, started: 0, busyMs: 0, tokens: 0 });

/**
 * Every message sent to an AI tool starts a round, and the round records when it began and ended. Counting today's
 * rounds counts today's messages, whichever tool or window they were typed in.
 */
export function countToday(index: Partial<Record<ToolId, ParsedSession[]>>, now = Date.now()): TodayStats {
  const since = startOfToday(now);
  const until = since + 24 * 3_600_000;
  const byTool = Object.fromEntries(TOOLS.map((tool) => [tool, empty()])) as Record<ToolId, ToolDay>;
  const conversations: DayConversation[] = [];
  for (const tool of TOOLS) {
    const day = byTool[tool];
    const seen = new Set<string>();
    for (const session of index[tool] ?? []) {
      // A session not touched today has nothing from today; the same session can be listed twice.
      if (seen.has(session.id) || Date.parse(session.updatedAt) < since) continue;
      seen.add(session.id);
      let messages = 0;
      let before = false;
      let lastAt = 0;
      for (const message of session.messages) {
        if (message.role !== "turn" || !message.startedAt) continue;
        const at = Date.parse(message.startedAt);
        if (!Number.isFinite(at)) continue;
        if (at < since) {
          before = true;
          continue;
        }
        if (at >= until) continue;
        messages += 1;
        lastAt = Math.max(lastAt, at);
        const end = message.endedAt ? Date.parse(message.endedAt) : Math.min(now, at + OPEN_ROUND_CAP_MS);
        if (Number.isFinite(end) && end > at) day.busyMs += end - at;
        day.tokens += message.tokens ?? 0;
      }
      if (!messages) continue;
      day.messages += messages;
      day.conversations += 1;
      if (!before) day.started += 1;
      conversations.push({
        tool,
        id: session.id,
        title: session.title || "未命名对话",
        place: session.cwd ? path.basename(session.cwd.replace(/[\\/]+$/, "")) || session.cwd : "",
        messages,
        lastAt,
      });
    }
  }
  const sum = (key: keyof ToolDay) => TOOLS.reduce((total, tool) => total + byTool[tool][key], 0);
  conversations.sort((a, b) => b.messages - a.messages || b.lastAt - a.lastAt);
  return {
    total: sum("messages"),
    conversations: sum("conversations"),
    started: sum("started"),
    busyMs: sum("busyMs"),
    tokens: sum("tokens"),
    byTool,
    top: conversations.slice(0, TOP),
    since,
  };
}
