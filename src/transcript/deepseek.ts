import { zstdDecompressSync } from "node:zlib";
import type { ParsedSession, StepResult, TranscriptMessage } from "../shared/types";
import { clip, toolHeader, withLines } from "./claudeTools";

/**
 * DeepSeek Harness keeps each session as `session.v4.jsonl.zstd`: one event per line, compressed in frames that are
 * appended as the session goes on. Node decodes only the first frame of a buffer, so the frames are found by their
 * magic number and decoded one by one. The magic number can also turn up inside compressed data; a cut there does
 * not decode on its own, so the piece is joined with the next one and tried again.
 */
const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

export function decodeFrames(buffer: Buffer): string {
  const starts: number[] = [];
  for (let index = 0; index <= buffer.length - 4; index++) {
    if (buffer[index] === MAGIC[0] && buffer[index + 1] === MAGIC[1] && buffer[index + 2] === MAGIC[2] && buffer[index + 3] === MAGIC[3]) {
      starts.push(index);
    }
  }
  if (!starts.length) return "";
  let text = "";
  let from = starts[0];
  for (let next = 1; next <= starts.length; next++) {
    const end = next < starts.length ? starts[next] : buffer.length;
    try {
      text += zstdDecompressSync(buffer.subarray(from, end)).toString("utf8");
      from = end;
    } catch {
      // Not a real frame boundary: keep the piece and try with the next cut.
    }
  }
  return text;
}

export interface DshEvent {
  type: string;
  seq?: number;
  time?: number;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

export function readDshEvents(buffer: Buffer): DshEvent[] {
  const events: DshEvent[] = [];
  for (const line of decodeFrames(buffer).split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as DshEvent;
      if (event && typeof event.type === "string") events.push(event);
    } catch {
      /* a line cut off by a frame still being written */
    }
  }
  return events;
}

type Fields = Record<string, unknown>;
const str = (value: unknown) => (typeof value === "string" ? value : "");
const iso = (ms: unknown) => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : "");

/** DeepSeek's tool names, as the names the page already draws (Claude Code's). */
const TOOL_NAMES: Record<string, string> = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  multi_edit: "MultiEdit",
  pwsh: "PowerShell",
  powershell: "PowerShell",
  bash: "Bash",
  shell: "Bash",
  grep: "Grep",
  glob: "Glob",
  web_fetch: "WebFetch",
  web_search: "WebSearch",
  todo_write: "TodoWrite",
};

function partsText(content: unknown, type = "text"): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is Fields => Boolean(part) && typeof part === "object" && (part as Fields).type === type)
    .map((part) => str(part.text))
    .join("");
}

function parseArgs(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function errorText(reason: unknown): string {
  const fields = (reason && typeof reason === "object" ? reason : {}) as Fields;
  const error = (fields.error ?? fields.failure) as Fields | undefined;
  return str(error?.message) || str(fields.message);
}

const TITLE_LIMIT = 60;

/** One DeepSeek Harness session, laid out like the other tools' transcripts. */
export function parseDeepseekEvents(events: DshEvent[], updatedAt: string): ParsedSession | null {
  const header = events.find((event) => event.type === "session");
  const id = str(header?.id);
  if (!id) return null;
  const cwd = str(header?.cwd);
  const messages: TranscriptMessage[] = [];
  const steps = new Map<string, TranscriptMessage>();
  const seenUsers = new Set<string>();
  let title = "";
  let agentPreset = str(header?.agentPreset);
  let firstUser = "";
  let model = "";
  let roundStart = "";
  let roundOpen = false;
  let lastAt = "";
  let outputTokens = 0;
  let index = 0;

  const closeRound = (endedAt: string) => {
    if (!roundStart) return;
    messages.push({ id: `d-${index++}`, role: "turn", text: "", startedAt: roundStart, endedAt, ...(outputTokens ? { tokens: outputTokens } : {}) });
    for (const step of steps.values()) {
      if (step.result?.status === "running") step.result = { ...step.result, status: "ok" };
    }
    steps.clear();
    roundStart = "";
    roundOpen = false;
    outputTokens = 0;
  };

  for (const event of events) {
    const data = (event.data ?? {}) as Fields;
    const at = iso(event.time);
    if (at) lastAt = at;
    switch (event.type) {
      case "agent-preset/selected":
        agentPreset = str(data.agentPreset) || agentPreset;
        break;
      case "session/title":
        title = str(data.title) || title;
        break;
      case "request/context":
        model = str(data.model) || model;
        break;
      case "user/message": {
        const source = (data.source ?? {}) as Fields;
        if (source.kind !== "user") break;
        const key = str(data.id);
        const text = partsText(data.content).trim();
        if (!text || (key && seenUsers.has(key))) break;
        if (key) seenUsers.add(key);
        if (!firstUser) firstUser = text;
        // A message sent while a round runs joins that round, as in the app.
        if (!roundStart) roundStart = at || updatedAt;
        messages.push({ id: `d-${index++}`, role: "user", text });
        break;
      }
      case "turn/start":
        roundOpen = true;
        if (!roundStart) roundStart = at || updatedAt;
        break;
      case "assistant/message": {
        const message = (data.message ?? {}) as Fields;
        const usage = (data.usage ?? {}) as Fields;
        if (typeof usage.outputTokens === "number") outputTokens += usage.outputTokens;
        if (!Array.isArray(message.content)) break;
        for (const part of message.content as Fields[]) {
          if (!part || typeof part !== "object") continue;
          if (part.type === "reasoning" && str(part.text).trim()) {
            messages.push({ id: `d-${index++}`, role: "thinking", text: str(part.text) });
          } else if (part.type === "text" && str(part.text).trim()) {
            messages.push({ id: `d-${index++}`, role: "assistant", text: str(part.text) });
          } else if (part.type === "tool-call" && str(part.name)) {
            const name = str(part.name);
            const header = toolHeader(TOOL_NAMES[name] ?? name, parseArgs(part.arguments), cwd);
            const step: TranscriptMessage = {
              id: `d-${index++}`,
              role: "step",
              tool: header.tool,
              text: header.text,
              ...(header.server ? { server: header.server } : {}),
              result: { status: "running" },
            };
            messages.push(step);
            const callId = str(part.id);
            if (callId) steps.set(callId, step);
          }
        }
        break;
      }
      case "tool/result": {
        const message = (data.message ?? {}) as Fields;
        const step = steps.get(str(message.toolCallId));
        if (!step) break;
        const result: StepResult = { status: message.isError === true ? "error" : "ok" };
        step.result = withLines(result, partsText(message.content));
        break;
      }
      case "turn/end": {
        const failure = errorText(data.reason);
        const kind = str((data.reason as Fields | undefined)?.kind);
        if (failure) messages.push({ id: `d-${index++}`, role: "assistant", text: `⚠ ${clip(failure, 600)}` });
        else if (kind && kind !== "completed") messages.push({ id: `d-${index++}`, role: "assistant", text: kind === "interrupted" || kind === "aborted" ? "（已中断）" : `（${kind}）` });
        closeRound(at || updatedAt);
        break;
      }
      default:
        break;
    }
  }

  const open = roundOpen || Boolean(roundStart);
  if (open && roundStart) messages.push({ id: "d-running", role: "turn", text: "", startedAt: roundStart });
  const running = [...steps.values()].some((step) => step.result?.status === "running");
  return {
    id,
    cwd,
    title: clip((title || firstUser || id).replace(/\s+/g, " ").trim(), TITLE_LIMIT),
    updatedAt: lastAt || updatedAt,
    messages,
    turnComplete: !open,
    ...(open && !running ? { idleSince: lastAt || updatedAt } : {}),
    ...(open ? { openActivityAt: lastAt || updatedAt } : {}),
    ...(model ? { model } : {}),
    ...(agentPreset ? { agentPreset } : {}),
  };
}
