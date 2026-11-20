import type { ParsedSession, TranscriptMessage } from "../shared/types";
import { codexCall, codexResult, patchSteps } from "./codexTools";

function titleFrom(text: string, fallback: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return fallback;
  return Array.from(flat).slice(0, 42).join("");
}

interface Usage {
  output_tokens?: number;
}

/** Reasoning summaries come as `**Heading**`; the terminal shows the words without the marks. */
function reasoningText(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, "$1").trim();
}

/** Desktop rollouts store chat text as message items, alongside tool call items. */
function chatItem(payload: Record<string, unknown>): { role: "user" | "assistant"; text: string } | null {
  const role = payload.role;
  if (role !== "user" && role !== "assistant") return null;
  if (role === "assistant" && payload.phase !== undefined && payload.phase !== "commentary" && payload.phase !== "final_answer") return null;
  if (!Array.isArray(payload.content)) return null;
  const content = payload.content;
  const metadata = payload.internal_chat_message_metadata_passthrough as { content_item_kinds?: unknown } | undefined;
  const kinds = metadata?.content_item_kinds;
  const text = content.flatMap((block: unknown, index: number) => {
    if (!block || typeof block !== "object") return [];
    const part = block as { type?: string; text?: unknown };
    // Environment, AGENTS.md and page context can also have role=user; they are not chat messages.
    if (role === "user" && Array.isArray(kinds) && kinds.length === content.length &&
      (typeof kinds[index] !== "string" || !kinds[index].startsWith("user."))) return [];
    if (part.type === "input_image") return ["[图片]"];
    if ((part.type === "input_text" || part.type === "output_text") && typeof part.text === "string") return [part.text];
    return [];
  }).join("\n").trim();
  return text ? { role, text } : null;
}

export function parseCodexJsonl(content: string, updatedAt: string): ParsedSession | null {
  let id = "";
  let cwd = "";
  const messages: TranscriptMessage[] = [];
  let lastStart = -1;
  let lastEnd = -1;
  let index = 0;
  // Output tokens so far in the session; a round's tokens are the growth between its start and its end.
  let totalOutput = 0;
  let round: { startedAt: string; outputBefore: number } | null = null;
  // Calls waiting for their output, by call id → position in `messages`.
  const calls = new Map<string, number>();
  let interruptedAt: number | undefined;
  let model = "";
  let effort = "";

  const push = (message: Omit<TranscriptMessage, "id">) => messages.push({ id: `x-${messages.length}`, ...message });
  // Some versions write both event_msg and response_item for the same words. Match copies one by one
  // within a turn so intentional repeated messages are still shown.
  const unmatchedChat = { event: new Map<string, number>(), item: new Map<string, number>() };
  const pushChat = (source: "event" | "item", message: { role: "user" | "assistant"; text: string }) => {
    const key = JSON.stringify([message.role, message.text.trim()]);
    const opposite = unmatchedChat[source === "event" ? "item" : "event"];
    const copies = opposite.get(key) ?? 0;
    if (copies) opposite.set(key, copies - 1);
    else {
      push(message);
      unmatchedChat[source].set(key, (unmatchedChat[source].get(key) ?? 0) + 1);
    }
  };

  /** Calls still without output when a task ends: done if it finished, cut short if it was aborted. */
  const settleCalls = (aborted: boolean) => {
    for (const at of calls.values()) {
      const step = messages[at];
      if (step?.result?.status === "running") {
        step.result = aborted ? { status: "error", summary: "Interrupted" } : { status: "ok" };
      }
    }
    calls.clear();
  };

  const completeTurn = (timestamp: string, aborted = false) => {
    lastEnd = index;
    if (aborted) interruptedAt = messages.length;
    settleCalls(aborted);
    if (round?.startedAt && timestamp) {
      push({ role: "turn", text: "", startedAt: round.startedAt, endedAt: timestamp,
        tokens: Math.max(0, totalOutput - round.outputBefore) });
    }
    round = null;
  };

  for (const line of content.split(/\n/)) {
    if (!line.trim()) continue;
    let record: { type?: string; timestamp?: string; payload?: Record<string, unknown> };
    try {
      record = JSON.parse(line) as { type?: string; timestamp?: string; payload?: Record<string, unknown> };
    } catch {
      continue;
    }
    const payload = record.payload;
    if (!payload) continue;
    const timestamp = typeof record.timestamp === "string" ? record.timestamp : "";
    if (record.type === "session_meta") {
      if (!id && typeof payload.id === "string") id = payload.id;
      if (!cwd && typeof payload.cwd === "string") cwd = payload.cwd;
    }
    // Every turn records the model and effort it ran with; the latest one is what the next turn uses.
    if (record.type === "turn_context") {
      if (typeof payload.model === "string" && payload.model) model = payload.model;
      if (typeof payload.effort === "string") effort = payload.effort;
    }
    if (record.type === "response_item") {
      if (payload.type === "message") {
        const chat = chatItem(payload);
        if (chat) pushChat("item", chat);
        // Paginated desktop/standalone history may persist the final item without a task_complete event.
        if (payload.role === "assistant" && payload.phase === "final_answer" && payload.status === "completed") completeTurn(timestamp);
      }
      const callId = typeof payload.call_id === "string" ? payload.call_id : "";
      if ((payload.type === "function_call" || payload.type === "custom_tool_call") && typeof payload.name === "string") {
        const call = codexCall(payload, cwd);
        if (call.hidden) continue;
        push({
          role: "step",
          tool: call.tool,
          text: call.text,
          result: call.todos ? { status: "ok", todos: call.todos } : { status: "running" },
        });
        if (callId && !call.todos) calls.set(callId, messages.length - 1);
      } else if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
        const at = calls.get(callId);
        if (at !== undefined) {
          calls.delete(callId);
          messages[at] = { ...messages[at], result: codexResult(payload.output) };
        }
      }
      continue;
    }
    if (record.type !== "event_msg" || typeof payload.type !== "string") continue;
    const cursor = index;
    if (payload.type === "token_count") {
      const info = payload.info as { total_token_usage?: Usage; last_token_usage?: Usage } | null | undefined;
      const total = info?.total_token_usage?.output_tokens;
      // The running total resets after a compaction; keep counting from where it restarts.
      if (typeof total === "number") {
        if (total < totalOutput && round) round.outputBefore -= totalOutput - total;
        totalOutput = total;
      }
    }
    if (payload.type === "user_message" && typeof payload.message === "string" && payload.message.trim()) {
      pushChat("event", { role: "user", text: payload.message });
    }
    if (payload.type === "agent_message" && typeof payload.message === "string" && payload.message.trim()) {
      // Commentary between tool calls reads as ordinary agent text in the terminal, same as the final answer.
      if (payload.phase === undefined || payload.phase === "final_answer" || payload.phase === "commentary") pushChat("event", { role: "assistant", text: payload.message });
    }
    if (payload.type === "agent_reasoning" && typeof payload.text === "string" && payload.text.trim()) {
      push({ role: "thinking", text: reasoningText(payload.text) });
    }
    if (payload.type === "patch_apply_end") {
      for (const step of patchSteps(payload, cwd)) push({ role: "step", tool: step.tool, text: step.text, result: step.result });
    }
    if (payload.type === "web_search_end") {
      const query = typeof payload.query === "string" ? payload.query : "";
      push({ role: "step", tool: "Searched", text: query, result: { status: "ok" } });
    }
    if (payload.type === "task_started") {
      unmatchedChat.event.clear();
      unmatchedChat.item.clear();
      lastStart = cursor;
      round = { startedAt: timestamp, outputBefore: totalOutput };
    }
    if (payload.type === "task_complete" || payload.type === "turn_aborted") {
      completeTurn(timestamp, payload.type === "turn_aborted");
    }
    index += 1;
  }

  if (!id || !cwd) return null;
  const firstUser = messages.find((message) => message.role === "user")?.text ?? "";
  const turnComplete = lastStart < 0 || lastEnd > lastStart;
  const open = round as { startedAt: string; outputBefore: number } | null;
  if (!turnComplete && open?.startedAt) {
    messages.push({
      id: "x-running",
      role: "turn",
      text: "",
      startedAt: open.startedAt,
      tokens: Math.max(0, totalOutput - open.outputBefore),
    });
  }
  return {
    id,
    cwd,
    title: titleFrom(firstUser, id),
    updatedAt,
    messages,
    turnComplete,
    ...(interruptedAt === undefined ? {} : { interruptedAt }),
    ...(model ? { model } : {}),
    ...(model && effort ? { effort } : {}),
  };
}
