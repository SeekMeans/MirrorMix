import type { ParsedSession, TodoItem, TranscriptMessage } from "../shared/types";
import { planOf, todosOf, toolHeader, toolResult } from "./claudeTools";

interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  tool_use_id?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  is_error?: boolean;
}

function titleFrom(text: string, fallback: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return fallback;
  return Array.from(flat).slice(0, 42).join("");
}

const PEER_MESSAGE = /^Another Claude session sent a message:\r?\n/;

function ownWords(text: string): string {
  const peer = text.match(/^Another Claude session sent a message:\r?\n([\s\S]*?)\r?\n\r?\nThis came from another Claude session\b/);
  return (peer?.[1] ?? text).trim();
}

/**
 * Claude Code's notice that a background task finished. It wakes the AI up, but it is not something the person
 * said: a round only runs if the AI answers it.
 */
function isTaskNotification(text: string): boolean {
  return /^\s*<task-notification>/.test(text);
}

/** How long an open round may go without any record, with no tool still running, before it counts as abandoned. */
export const ABANDONED_MS = 10 * 60_000;

/** Slack past a tool's own limit: Claude Code writes the result a moment after the command stops. */
export const STALL_GRACE_MS = 60_000;
/** Claude Code's own Bash and PowerShell timeouts: 2 minutes unless the call asks for more, 10 at most. */
const SHELL_DEFAULT_MS = 120_000;
const SHELL_MAX_MS = 600_000;
/** Reading, editing, searching, fetching, MCP calls: they answer within minutes. */
const OTHER_TOOL_MS = 10 * 60_000;

/**
 * How long a call can take by its own rules before it has to answer, or null when nothing bounds it: a sub-agent
 * works as long as its task needs, and a question waits on the person.
 */
export function callLimitMs(name: string, input: unknown): number | null {
  const args = (input ?? {}) as { timeout?: unknown; run_in_background?: unknown };
  if (name === "Bash" || name === "PowerShell") {
    // A background command answers at once; it is the task list that follows it.
    if (args.run_in_background === true) return 0;
    const asked = typeof args.timeout === "number" && args.timeout > 0 ? args.timeout : SHELL_DEFAULT_MS;
    return Math.min(asked, SHELL_MAX_MS);
  }
  if (name === "Agent" || name === "Task" || name === "AskUserQuestion" || name === "ExitPlanMode" || /__(start_session|hand_off_to_session)$/.test(name)) return null;
  return OTHER_TOOL_MS;
}

/**
 * A round whose Claude Code went away mid-request (the process was stopped, MirrorMix restarted under it) never
 * gets an end in the transcript. Replies stream records as they come and a running tool keeps its call open, so a
 * round with neither for this long is over. Applied on each read, since parsed transcripts are cached by file time.
 */
export function settleAbandoned(parsed: ParsedSession, now = Date.now()): ParsedSession {
  if (parsed.turnComplete) return parsed;
  if (!parsed.idleSince) return settleStalled(parsed, now);
  const since = Date.parse(parsed.idleSince);
  if (!Number.isFinite(since) || now - since < ABANDONED_MS) return parsed;
  return {
    ...parsed,
    turnComplete: true,
    messages: parsed.messages.map((message) =>
      message.role === "turn" && !message.endedAt ? { ...message, endedAt: parsed.idleSince } : message,
    ),
  };
}

/**
 * A round whose tool calls are past their own time limit with no result and no other record: the call is stuck (or
 * its process went away). Over, its unfinished calls marked, the turn flagged so the page can say the next message
 * carries on.
 */
function settleStalled(parsed: ParsedSession, now: number): ParsedSession {
  const last = parsed.openActivityAt ? Date.parse(parsed.openActivityAt) : NaN;
  const limit = parsed.stallAfter;
  if (!limit || !Number.isFinite(last) || now - last < limit.ms + STALL_GRACE_MS) return parsed;
  return {
    ...parsed,
    turnComplete: true,
    messages: parsed.messages.map((message) => {
      if (message.role === "turn" && !message.endedAt) return { ...message, endedAt: parsed.openActivityAt, stalled: { tool: limit.tool, limitMs: limit.ms } };
      if (message.role === "step" && message.result?.status === "running") return { ...message, result: { status: "error" as const, summary: "超时没有结果" } };
      return message;
    }),
  };
}

/**
 * A round left open by a Claude Code that is no longer there. When MirrorMix starts a session's Claude Code again
 * (after a restart of its own, say), whatever the old process was doing went with it: the new one does not carry on
 * an earlier round, not even a tool call that never got its result. So a round whose last record is older than the
 * process now running the session is over, and its unfinished tool calls were interrupted.
 */
export function settleBeforeProcess(parsed: ParsedSession, processStartedAt: number): ParsedSession {
  if (parsed.turnComplete || !parsed.openActivityAt) return parsed;
  const last = Date.parse(parsed.openActivityAt);
  // A little slack: the process starting and the transcript's clock are not the same instant.
  if (!Number.isFinite(last) || last > processStartedAt - 1_000) return parsed;
  return {
    ...parsed,
    turnComplete: true,
    messages: parsed.messages.map((message) => {
      if (message.role === "turn" && !message.endedAt) return { ...message, endedAt: parsed.openActivityAt };
      if (message.role === "step" && message.result?.status === "running") return { ...message, result: { status: "error" as const, summary: "Interrupted" } };
      return message;
    }),
  };
}

/** A slash command run in the client itself (`/model`, `/clear`): its output, with no AI reply to wait for. */
function isLocalCommandOutput(text: string): boolean {
  return /^<local-command-(stdout|stderr)>/.test(text.trim());
}

/** `/model sonnet` answers "Set model to claude-sonnet-5" (sometimes with terminal colour codes around the name). */
function switchedModel(text: string): string {
  // eslint-disable-next-line no-control-regex
  const plain = text.replace(/\u001b\[[0-9;]*m/g, "");
  const found = plain.match(/Set model to\s+([^\s<(]+)/);
  return found?.[1]?.trim() ?? "";
}

/** What Claude Code writes in place of a reply when the person stops a round ("...by user" or "...for tool use"). */
function isInterruptMarker(text: string): boolean {
  return /^\[Request interrupted by user[^\]]*\]$/.test(text.trim());
}

function blocksOf(content: unknown): ContentBlock[] {
  if (!Array.isArray(content)) return [];
  return content.filter((block): block is ContentBlock => typeof block === "object" && block !== null);
}

function userText(content: unknown): { text: string; toolOnly: boolean; hasToolResult: boolean } {
  if (typeof content === "string") {
    const text = ownWords(content);
    return { text, toolOnly: false, hasToolResult: false };
  }
  if (!Array.isArray(content)) return { text: "", toolOnly: false, hasToolResult: false };
  const blocks = blocksOf(content);
  const text = ownWords(
    blocks
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join(""),
  );
  const hasToolResult = blocks.some((block) => block.type === "tool_result");
  const toolOnly = blocks.length > 0 && blocks.every((block) => block.type === "tool_result");
  return { text, toolOnly, hasToolResult };
}

/** One round of work, from a person's message to the AI's last record before the next one. */
interface Round {
  startedAt: string;
  endedAt: string;
  /** Claude writes one record per content block and repeats the message usage on each, so count by message id. */
  outputById: Map<string, number>;
}

function roundTokens(round: Round): number {
  let total = 0;
  for (const count of round.outputById.values()) total += count;
  return total;
}

/** A tool call waiting for its result. */
interface OpenCall {
  at: number;
  name: string;
  input: unknown;
  todos?: TodoItem[];
}

export function parseClaudeJsonl(fileName: string, content: string, updatedAt: string): ParsedSession | null {
  let cwd = "";
  let customTitle = "";
  const messages: TranscriptMessage[] = [];
  let last: "human" | "assistant_text" | "tool_only" | "interrupted" | "local_command" | "none" = "none";
  let interruptedAt: number | undefined;
  /** The latest record of the conversation itself (not bookkeeping such as costs or titles). */
  let lastActivity = "";
  let sawHuman = false;
  let index = 0;
  let stream = "";
  let round: Round | null = null;
  const calls = new Map<string, OpenCall>();
  let plan: TodoItem[] | undefined;
  let model = "";

  const closeRound = () => {
    if (round) {
      messages.push({
        id: `c-${index++}`,
        role: "turn",
        text: "",
        startedAt: round.startedAt,
        endedAt: round.endedAt,
        tokens: roundTokens(round),
      });
    }
    // Calls that never got a result (the round was interrupted) stop spinning.
    for (const call of calls.values()) {
      const step = messages[call.at];
      if (step?.result?.status === "running") step.result = { status: "error", summary: "Interrupted" };
    }
    calls.clear();
    round = null;
  };

  for (const line of content.split(/\n/)) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!cwd && typeof record.cwd === "string") cwd = record.cwd;
    if (record.type === "custom-title" && typeof record.customTitle === "string" && record.customTitle.trim()) {
      customTitle = record.customTitle.trim();
    }
    const timestamp = typeof record.timestamp === "string" ? record.timestamp : "";
    // Sub-agent records belong to their own transcript; only the call that started them shows here.
    const sidechain = record.isSidechain === true;
    // When the context fills up, Claude Code writes its own long summary as a user message. Nobody typed it.
    if (record.isCompactSummary === true) continue;
    const message = record.message as { id?: string; role?: string; content?: unknown; usage?: { output_tokens?: number } } | undefined;
    if (record.type === "user" && message?.role === "user" && !sidechain) {
      const extracted = userText(message.content);
      for (const block of blocksOf(message.content)) {
        if (block.type !== "tool_result" || !block.tool_use_id) continue;
        const call = calls.get(block.tool_use_id);
        if (!call) continue;
        calls.delete(block.tool_use_id);
        let result = toolResult(call.name, call.input, block as Record<string, unknown>, record.toolUseResult, cwd);
        // The terminal shows the list itself under a todo update, not the tool's acknowledgement.
        if (call.todos && result.status === "ok") result = { status: "ok", todos: call.todos };
        messages[call.at] = { ...messages[call.at], result };
      }
      // Claude Code's own notes ("the command below was run directly…") are not something the person said.
      // A message sent from MirrorMix arrives through Claude's inbox and is stored as a meta record too, but it is the
      // person's own words and starts a round; only skip the meta records nobody typed.
      const rawText = typeof message.content === "string"
        ? message.content
        : blocksOf(message.content).map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : "")).join("");
      if (record.isMeta === true && !extracted.hasToolResult && !PEER_MESSAGE.test(rawText)) continue;
      if (!extracted.hasToolResult && isTaskNotification(rawText)) continue;
      if (timestamp) lastActivity = timestamp;
      if (extracted.text && isLocalCommandOutput(extracted.text)) {
        model = switchedModel(extracted.text) || model;
        // The command finished in the client; nothing is running and no reply is coming.
        if (round && timestamp) round.endedAt = timestamp;
        closeRound();
        last = "local_command";
        continue;
      }
      if (extracted.text && isInterruptMarker(extracted.text)) {
        // Stopping a round is not something the person said. It ends the round, and the session can take input again.
        if (round && timestamp) round.endedAt = timestamp;
        closeRound();
        last = "interrupted";
        interruptedAt = messages.length;
      } else if (extracted.text) {
        // A message typed while the AI is mid-round rides along with tool results; it does not start a new round.
        if (!extracted.hasToolResult) {
          closeRound();
          if (timestamp) round = { startedAt: timestamp, endedAt: timestamp, outputById: new Map() };
        }
        messages.push({ id: `c-${index++}`, role: "user", text: extracted.text });
        last = "human";
        sawHuman = true;
      } else if (extracted.toolOnly) {
        last = "tool_only";
      }
      if (round && timestamp) round.endedAt = timestamp;
    }
    if (record.type === "stream_event") {
      const event = (record.event ?? record) as { type?: string; delta?: { type?: string; text?: string } };
      const delta = event.delta ?? (record.delta as { type?: string; text?: string } | undefined);
      if (event.type === "content_block_delta" && delta?.type === "text_delta" && typeof delta.text === "string") {
        stream += delta.text;
      }
    }
    if (record.type === "assistant" && !sidechain) {
      stream = "";
      if (timestamp) lastActivity = timestamp;
      // Error notices Claude Code writes itself carry "<synthetic>" in place of a model.
      const used = (message as { model?: unknown } | undefined)?.model;
      if (typeof used === "string" && used && !used.startsWith("<")) model = used;
      const blocks = blocksOf(message?.content);
      let hasText = false;
      let hasTool = false;
      let text = "";
      const flushText = () => {
        if (!text.trim()) return;
        messages.push({ id: `c-${index++}`, role: "assistant", text });
        hasText = true;
        text = "";
      };
      for (const block of blocks) {
        if (block.type === "text" && typeof block.text === "string") {
          text += block.text;
        } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
          flushText();
          messages.push({ id: `c-${index++}`, role: "thinking", text: block.thinking });
        } else if (block.type === "tool_use" && typeof block.name === "string") {
          flushText();
          hasTool = true;
          const header = toolHeader(block.name, block.input, cwd);
          const call: OpenCall = { at: messages.length, name: block.name, input: block.input };
          if (block.name === "TodoWrite") call.todos = todosOf(block.input);
          if (/^mcp__.+__update_plan$/.test(block.name)) {
            plan = planOf(block.input, plan);
            call.todos = plan;
          }
          messages.push({
            id: `c-${index++}`,
            role: "step",
            tool: header.tool,
            ...(header.server ? { server: header.server } : {}),
            text: header.text,
            result: { status: "running" },
          });
          if (block.id) calls.set(block.id, call);
        }
      }
      flushText();
      if (hasText) last = "assistant_text";
      else if (hasTool) last = "tool_only";
      if (round) {
        if (timestamp) round.endedAt = timestamp;
        const output = message?.usage?.output_tokens;
        if (typeof output === "number" && message?.id) {
          round.outputById.set(message.id, Math.max(round.outputById.get(message.id) ?? 0, output));
        }
      }
    }
  }

  if (stream.trim()) {
    messages.push({ id: "c-stream", role: "assistant", text: stream });
    if (sawHuman) last = "tool_only";
  }

  if (!cwd) return null;
  const firstUser = messages.find((message) => message.role === "user")?.text ?? "";
  const id = fileName.replace(/\.jsonl$/i, "");
  const turnComplete = !sawHuman || last === "assistant_text" || last === "interrupted" || last === "local_command";
  // Waiting on nothing: every tool call has its result, yet no reply has come.
  const idleSince = !turnComplete && calls.size === 0 && lastActivity ? lastActivity : undefined;
  const openActivityAt = !turnComplete && lastActivity ? lastActivity : undefined;
  let stallAfter: { ms: number; tool: string } | undefined;
  if (!turnComplete && calls.size) {
    for (const call of calls.values()) {
      const ms = callLimitMs(call.name, call.input);
      if (ms === null) {
        stallAfter = undefined;
        break;
      }
      if (!stallAfter || ms >= stallAfter.ms) stallAfter = { ms, tool: messages[call.at]?.tool ?? call.name };
    }
  }
  const open = round as Round | null;
  if (open && turnComplete) closeRound();
  else if (open) {
    messages.push({ id: "c-running", role: "turn", text: "", startedAt: open.startedAt, tokens: roundTokens(open) });
  }
  return {
    id,
    cwd,
    title: customTitle || titleFrom(firstUser, id),
    updatedAt,
    messages,
    turnComplete,
    ...(interruptedAt === undefined ? {} : { interruptedAt }),
    ...(idleSince ? { idleSince } : {}),
    ...(openActivityAt ? { openActivityAt } : {}),
    ...(stallAfter ? { stallAfter } : {}),
    ...(model ? { model } : {}),
  };
}
