import type { ParsedSession, TranscriptMessage } from "../shared/types";

interface Block {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
}

function oneLine(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, 160);
}

/** The one argument a person needs in order to recognise the call. Cursor stores these names on the bubble, not the transcript names. */
function toolText(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const record = input as Record<string, unknown>;
  for (const key of [
    "commandDescription",
    "description",
    "pattern",
    "globPattern",
    "query",
    "targetFile",
    "relativeWorkspacePath",
    "file_path",
    "path",
    "command",
    "prompt",
  ]) {
    const text = oneLine(record[key]);
    if (text) return text;
  }
  return "";
}

function titleFrom(text: string, fallback: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return fallback;
  return Array.from(flat).slice(0, 42).join("");
}

/** Cursor wraps the typed text in `<user_query>`. The tags, timestamps, and system lines are not part of the chat. */
export function visibleUserText(raw: string): string {
  const parts: string[] = [];
  const pattern = /<user_query>([\s\S]*?)<\/user_query>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw))) {
    const text = match[1].trim();
    if (text) parts.push(text);
  }
  if (parts.length) return parts.join("\n\n");
  if (/<[a-z_]+>/.test(raw)) return "";
  return raw.trim();
}

/** Cursor puts the send time in the user content rather than on the JSONL record. */
function cursorMessageTime(raw: string): string | null {
  const value = /<timestamp>([\s\S]*?)<\/timestamp>/.exec(raw)?.[1]?.trim();
  if (!value) return null;
  const normalized = value
    .replace(/\(UTC\)/i, "+00:00")
    .replace(/\(UTC([+-])(\d{1,2}):(\d{2})\)/i, (_all, sign: string, hour: string, minute: string) => `${sign}${hour.padStart(2, "0")}:${minute}`);
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function prettyNamespace(value: string): string {
  return value
    .replace(/^cursor-/, "")
    .replace(/-/g, " ")
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

/** The one line Cursor shows for a call, such as `Computer Use/computer_screenshot`. */
function stepDetail(name: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const record = input as Record<string, unknown>;
  if (name === "CallDynamicTool") {
    const tool = oneLine(record.toolName);
    const pretty = prettyNamespace(oneLine(record.namespace));
    if (pretty && tool) return `${pretty}/${tool}`;
    return tool;
  }
  if (name === "Shell" || name === "Bash" || name === "PowerShell") return oneLine(record.description) || oneLine(record.command);
  return toolText(input);
}

/**
 * Cursor agent transcripts: user and assistant records carry content blocks,
 * and `turn_ended` closes the round. A file that stops before that is still replying.
 */
export function parseCursorJsonl(id: string, content: string, updatedAt: string, cwd: string): ParsedSession {
  const messages: TranscriptMessage[] = [];
  let index = 0;
  let sawHuman = false;
  let ended = !content.trim();
  let roundStart = "";
  let firstUser = "";
  let roundUser = "";
  let lastAssistant = "";

  const closeRound = () => {
    if (!roundStart) return;
    messages.push({ id: `r-${index++}`, role: "turn", text: "", startedAt: roundStart, endedAt: updatedAt });
    roundStart = "";
  };

  for (const line of content.split(/\n/)) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (record.type === "turn_ended") {
      closeRound();
      roundUser = "";
      lastAssistant = "";
      ended = true;
      continue;
    }
    const message = record.message as { content?: unknown } | undefined;
    const blocks = Array.isArray(message?.content) ? (message.content as Block[]) : [];
    if (record.role === "user") {
      const raw = blocks
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text as string)
        .join("");
      const text = visibleUserText(raw);
      if (!text) continue;
      // Cursor writes the same question again when it refreshes the round. It is not a second message.
      if (roundStart && text === roundUser) continue;
      if (!firstUser) firstUser = text;
      if (ended || !roundStart) roundStart = cursorMessageTime(raw) ?? updatedAt;
      roundUser = text;
      lastAssistant = "";
      ended = false;
      sawHuman = true;
      messages.push({ id: `r-${index++}`, role: "user", text });
      continue;
    }
    if (record.role !== "assistant") continue;
    ended = false;
    for (const block of blocks) {
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        const text = block.text.trim();
        if (text === lastAssistant) continue;
        lastAssistant = text;
        messages.push({ id: `r-${index++}`, role: "assistant", text: block.text });
      } else if (block.type === "tool_use" && typeof block.name === "string") {
        lastAssistant = "";
        messages.push({
          id: `r-${index++}`,
          role: "step",
          tool: block.name,
          text: stepDetail(block.name, block.input),
          result: { status: "ok" },
        });
      }
    }
  }

  if (roundStart && ended) closeRound();
  else if (roundStart) {
    messages.push({ id: "r-running", role: "turn", text: "", startedAt: roundStart });
  }

  return {
    id,
    cwd,
    title: titleFrom(firstUser, id),
    updatedAt,
    messages,
    turnComplete: !sawHuman || ended,
  };
}

/** One composer bubble. Older chats live here when there is no agent transcript file. */
export interface CursorBubble {
  type: number;
  text: string;
  createdAt: string;
  toolName: string;
  toolInput: unknown;
  failed: boolean;
  /** The call is still in progress in Cursor. */
  running?: boolean;
}

/**
 * Bubbles are the composer thread: type 1 is the person, type 2 is the reply or a tool call.
 * The header decides whether the round is still running.
 */
export function parseCursorBubbles(
  id: string,
  bubbles: CursorBubble[],
  updatedAt: string,
  cwd: string,
  turnComplete: boolean,
): ParsedSession {
  const messages: TranscriptMessage[] = [];
  let index = 0;
  let firstUser = "";
  let roundUser = "";
  let lastAssistant = "";
  const ordered = [...bubbles].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  let roundStartedAt = "";
  let latestAt = "";
  const closeRound = (endedAt: string | undefined) => {
    if (!roundStartedAt) return;
    messages.push({ id: `r-${index++}`, role: "turn", text: "", startedAt: roundStartedAt, ...(endedAt ? { endedAt } : {}) });
    roundStartedAt = "";
  };
  for (const bubble of ordered) {
    const at = bubble.createdAt || updatedAt;
    const text = bubble.type === 1 ? visibleUserText(bubble.text) : bubble.text.trim();
    if (bubble.type === 1 && text) {
      if (!(roundUser && text === roundUser)) {
        closeRound(latestAt || at);
        if (!firstUser) firstUser = text;
        roundUser = text;
        lastAssistant = "";
        roundStartedAt = at;
        messages.push({ id: `r-${index++}`, role: "user", text });
      }
    } else if (bubble.type === 2 && text) {
      if (text !== lastAssistant) {
        lastAssistant = text;
        messages.push({ id: `r-${index++}`, role: "assistant", text });
      }
    }
    if (bubble.toolName) {
      lastAssistant = "";
      let input = bubble.toolInput;
      if (typeof input === "string") {
        try {
          const parsed = JSON.parse(input) as unknown;
          if (parsed && typeof parsed === "object") input = parsed;
        } catch {
          input = bubble.toolInput;
        }
      }
      const detail = toolText(input) || oneLine(input);
      messages.push({
        id: `r-${index++}`,
        role: "step",
        tool: bubble.toolName,
        text: detail,
        result: { status: bubble.running ? "running" : bubble.failed ? "error" : "ok" },
      });
    }
    latestAt = at;
  }
  closeRound(turnComplete ? updatedAt : undefined);
  return {
    id,
    cwd,
    title: titleFrom(firstUser, id),
    updatedAt,
    messages,
    turnComplete: messages.length === 0 || turnComplete,
  };
}

interface CursorSource {
  id: string;
  role: TranscriptMessage["role"];
  text: string;
  tool?: string;
  result?: { status: "running" | "ok" | "error" };
  startedAt?: string;
  endedAt?: string;
}

export interface CursorStepView {
  id: string;
  tool: string;
  detail: string;
  label: string;
  status: "running" | "ok" | "error";
}

/** One slice of a round, in the order Cursor wrote it. Text stays between the tool groups it belongs to. */
export type CursorPart = { kind: "text"; text: string } | { kind: "tools"; steps: CursorStepView[] };

/** One round the way Cursor draws it: the person's bubble, the answer, and the tool row folded into one line. */
export interface CursorTurnView {
  id: string;
  user: string;
  pending: boolean;
  live: boolean;
  /** Prose shown under the round. A finished round keeps its last reply; a live round keeps everything written so far. */
  answer: string;
  /** Earlier narration, folded into the completed round. */
  notes: string[];
  /** Text and tool groups in the order they were written. */
  parts: CursorPart[];
  steps: CursorStepView[];
  edits: number;
  /** Basename when the round edited exactly one file. */
  editFile: string;
  files: number;
  searches: number;
  commands: number;
  tools: number;
  browsers: number;
  agents: number;
  /** `Planning next moves`, or the call that is still going, such as `Reading App.tsx`. */
  running: string;
  /** When this round started. A live round uses it to count seconds. */
  startedAt: string | null;
  workedMs: number | null;
}

function canonicalTool(tool: string): string {
  if (tool === "read_file_v2") return "Read";
  if (tool === "ripgrep_raw_search") return "Grep";
  if (tool === "glob_file_search") return "Glob";
  if (tool === "run_terminal_command_v2") return "Shell";
  if (tool === "edit_file_v2") return "Edit";
  if (tool === "delete_file") return "Delete";
  if (tool === "task_v2") return "Task";
  return tool;
}

function bucket(tool: string): "file" | "search" | "command" | "tool" | "browser" | "edit" | "agent" | "skip" {
  if (tool === "await" || tool === "mcp--" || tool === "mcp-") return "skip";
  if (tool === "get_mcp_tools" || tool === "GetDynamicTools") return "search";
  if (tool.startsWith("mcp-") || tool === "CallDynamicTool") return tool.toLowerCase().includes("browser") ? "browser" : "tool";
  const name = canonicalTool(tool);
  if (name === "Read") return "file";
  if (name === "Grep" || name === "Glob") return "search";
  if (name === "Shell" || name === "Bash" || name === "PowerShell") return "command";
  if (name === "Edit" || name === "Write" || name === "StrReplace" || name === "Delete") return "edit";
  if (name === "Task") return "agent";
  return "skip";
}

function stepLabel(tool: string, detail: string): string {
  if (tool === "CallDynamicTool") return detail || tool;
  if (tool.startsWith("mcp-")) {
    const rest = tool.slice(4);
    const cut = rest.lastIndexOf("-");
    if (cut > 0) return `${rest.slice(0, cut)}/${rest.slice(cut + 1)}`;
  }
  const name = canonicalTool(tool);
  const base = detail.split(/[/\\]/).pop() || detail;
  if (name === "Read" || name === "Write" || name === "StrReplace" || name === "Edit") return base ? `${name} ${base}` : name;
  if (!detail) return name;
  return `${name} ${detail}`;
}

function sameCall(saved: TranscriptMessage, fresh: TranscriptMessage): TranscriptMessage {
  if (fresh.text.trim() || !saved.text.trim()) return fresh;
  return { ...fresh, text: saved.text };
}

/**
 * Overlay what Cursor is writing onto the latest round, without moving any earlier round.
 * The saved transcript and the live store each hold part of the round: calls are matched by position,
 * and sentences from either side are kept in the place they were written, between the calls around them.
 */
function mergeRound(saved: TranscriptMessage[], fresh: TranscriptMessage[]): TranscriptMessage[] {
  const user = fresh.find((message) => message.role === "user") ?? saved.find((message) => message.role === "user");
  const turn = fresh.find((message) => message.role === "turn") ?? saved.find((message) => message.role === "turn");

  /** Splits a round into its calls and, for each gap before a call (and the tail), what was said there. */
  const layout = (round: TranscriptMessage[]) => {
    const steps: TranscriptMessage[] = [];
    const gaps: TranscriptMessage[][] = [[]];
    for (const message of round) {
      if (message.role === "user" || message.role === "turn") continue;
      if (message.role === "step") {
        steps.push(message);
        gaps.push([]);
      } else gaps[gaps.length - 1].push(message);
    }
    return { steps, gaps };
  };
  const before = layout(saved);
  const live = layout(fresh);

  const body: TranscriptMessage[] = [];
  // The same sentence can arrive from both sides, and the live one may still be half written.
  const say = (message: TranscriptMessage) => {
    if (message.role !== "assistant") {
      body.push(message);
      return;
    }
    const text = message.text.trim();
    if (!text) return;
    const at = body.findIndex((item) => item.role === "assistant" && (item.text.trim().startsWith(text) || text.startsWith(item.text.trim())));
    if (at < 0) body.push(message);
    else if (text.length > body[at].text.trim().length) body[at] = { ...body[at], text: message.text };
  };

  const calls = Math.max(before.steps.length, live.steps.length);
  for (let index = 0; index <= calls; index += 1) {
    for (const message of before.gaps[index] ?? []) say(message);
    for (const message of live.gaps[index] ?? []) say(message);
    if (index === calls) break;
    const savedStep = before.steps[index];
    const liveStep = live.steps[index];
    if (savedStep && liveStep) body.push(sameCall(savedStep, liveStep));
    else body.push((liveStep ?? savedStep) as TranscriptMessage);
  }
  return [...(user ? [user] : []), ...body, ...(turn ? [turn] : [])];
}

/**
 * A live round's bubbles have the tool calls, often with no prose.
 * The transcript has the sentences already written, and lags behind the calls.
 * Only the latest question is updated. Earlier questions stay in their own place.
 */
export function mergeLiveTurn(saved: TranscriptMessage[], fresh: TranscriptMessage[]): TranscriptMessage[] {
  if (!fresh.length) return saved;
  const freshUser = fresh.find((message) => message.role === "user");
  let lastUser = -1;
  for (let index = saved.length - 1; index >= 0; index -= 1) {
    if (saved[index].role === "user") {
      lastUser = index;
      break;
    }
  }
  const savedUser = lastUser >= 0 ? saved[lastUser] : undefined;
  if (freshUser && savedUser && freshUser.text !== savedUser.text) {
    // The bubble list can still be standing on an older question. That question is already
    // in the transcript, so appending it again paints it at the bottom of the live reply.
    const seenEarlier = saved.slice(0, lastUser).some((message) => message.role === "user" && message.text === freshUser.text);
    if (seenEarlier) return saved;
    const closed = saved.map((message) =>
      message.role === "turn" && !message.endedAt ? { ...message, endedAt: message.startedAt } : message,
    );
    return [...closed, ...fresh];
  }
  const head = lastUser > 0 ? saved.slice(0, lastUser) : [];
  const round = lastUser >= 0 ? saved.slice(lastUser) : saved;
  return [...head, ...mergeRound(round, fresh)];
}

/** Bubbles from the latest typed message onward. That is the round Cursor is still writing. */
export function liveTurnBubbles(bubbles: CursorBubble[]): CursorBubble[] {
  const ordered = [...bubbles].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  let start = -1;
  ordered.forEach((bubble, index) => {
    if (bubble.type === 1 && visibleUserText(bubble.text)) start = index;
  });
  if (start < 0) return [];
  return ordered.slice(start);
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The line Cursor puts on a round: `Editing 1 file, explored 4 files, 2 searches, ran 1 command`.
 * Edits lead. Once there is an edit, the reads that follow are "explored".
 */
export function exploringLine(
  counts: { edits: number; editFile: string; files: number; searches: number; commands: number; tools: number; browsers: number; agents: number },
  live: boolean,
): string {
  const rest: string[] = [];
  if (counts.files) rest.push(plural(counts.files, "file", "files"));
  if (counts.searches) rest.push(plural(counts.searches, "search", "searches"));
  if (counts.tools) rest.push(plural(counts.tools, "tool", "tools"));
  if (counts.browsers) rest.push(plural(counts.browsers, "browser action", "browser actions"));
  if (counts.commands) rest.push(`ran ${plural(counts.commands, "command", "commands")}`);
  if (counts.agents) rest.push(plural(counts.agents, "agent", "agents"));
  if (counts.edits && rest.length) rest[0] = `explored ${rest[0]}`;
  const edited = counts.edits ? counts.editFile || plural(counts.edits, "file", "files") : "";
  const details = [edited, ...rest].filter(Boolean).join(", ");
  if (!details) return "";
  if (counts.edits) return `${live ? "Editing" : "Edited"} ${details}`;
  if (!counts.files && !counts.searches && !counts.tools && !counts.browsers && !counts.agents && counts.commands) {
    return `${live ? "Running" : "Ran"} ${plural(counts.commands, "command", "commands")}`;
  }
  return `${live ? "Exploring" : "Explored"} ${details}`;
}

/** The summary line for one tool group, not for every call in the round. */
export function toolGroupLine(steps: CursorStepView[], live: boolean): string {
  const counts = { edits: 0, editFile: "", files: 0, searches: 0, commands: 0, tools: 0, browsers: 0, agents: 0 };
  const paths = new Set<string>();
  for (const step of steps) {
    const kind = bucket(step.tool);
    if (kind === "file") counts.files += 1;
    else if (kind === "search") counts.searches += 1;
    else if (kind === "command") counts.commands += 1;
    else if (kind === "tool") counts.tools += 1;
    else if (kind === "browser") counts.browsers += 1;
    else if (kind === "agent") counts.agents += 1;
    else if (kind === "edit") {
      if (step.detail) paths.add(step.detail);
      else paths.add(String(paths.size + 1));
    }
  }
  counts.edits = paths.size;
  counts.editFile = paths.size === 1 ? [...paths][0].split(/[/\\]/).pop() || "" : "";
  return exploringLine(counts, live);
}

/** What Cursor writes under the summary while a call is still out. */
function activityLabel(step: CursorStepView): string {
  const name = canonicalTool(step.tool);
  const base = step.detail.split(/[/\\]/).pop() || step.detail;
  if (name === "Read") return base ? `Reading ${base}` : "Reading";
  if (name === "Grep") return base ? `Grepping ${base}` : "Grepping";
  if (name === "Glob") return "Searching files";
  if (name === "Edit" || name === "Write" || name === "StrReplace" || name === "Delete") return base ? `Editing ${base}` : "Editing";
  if (name === "Shell" || name === "Bash" || name === "PowerShell") return base ? `Running ${base}` : "Running";
  return step.label ? `Running ${step.label}` : "Running";
}

/** Groups a Cursor transcript into rounds. Claude and Codex never go through this. */
export function cursorTurns(messages: CursorSource[]): CursorTurnView[] {
  const turns: CursorTurnView[] = [];
  let current: CursorTurnView | null = null;

  const open = (user: string, id: string, pending: boolean): CursorTurnView => {
    if (current) turns.push(current);
    current = {
      id,
      user,
      pending,
      live: false,
      answer: "",
      notes: [],
      parts: [],
      steps: [],
      edits: 0,
      editFile: "",
      files: 0,
      searches: 0,
      commands: 0,
      tools: 0,
      browsers: 0,
      agents: 0,
      running: "",
      startedAt: null,
      workedMs: null,
    };
    return current;
  };

  const texts: string[][] = [];
  const editPaths: Array<Set<string>> = [];
  const ensure = (): CursorTurnView => {
    if (current) return current;
    const created = open("", `turn-${turns.length}`, false);
    texts.push([]);
    editPaths.push(new Set());
    return created;
  };

  for (const message of messages) {
    if (message.role === "user") {
      open(message.text, message.id, message.id === "pending-user" || message.id.startsWith("queued-"));
      texts.push([]);
      editPaths.push(new Set());
      continue;
    }
    const turn = ensure();
    if (message.role === "assistant" && message.text.trim()) {
      const text = message.text.trim();
      texts[texts.length - 1].push(text);
      turn.parts.push({ kind: "text", text });
    } else if (message.role === "step") {
      const tool = message.tool ?? "";
      const detail = message.text;
      const kind = bucket(tool);
      if (kind === "skip") continue;
      if (kind === "file") turn.files += 1;
      else if (kind === "search") turn.searches += 1;
      else if (kind === "command") turn.commands += 1;
      else if (kind === "tool") turn.tools += 1;
      else if (kind === "browser") turn.browsers += 1;
      else if (kind === "agent") turn.agents += 1;
      else if (kind === "edit") {
        const paths = editPaths[editPaths.length - 1];
        if (detail) paths.add(detail);
        else paths.add(String(paths.size + 1));
      }
      if (tool === "get_mcp_tools" || tool === "GetDynamicTools") continue;
      const step: CursorStepView = {
        id: message.id,
        tool,
        detail,
        label: stepLabel(tool, detail),
        status: message.result?.status ?? "ok",
      };
      const part = turn.parts.at(-1);
      if (part?.kind === "tools") part.steps.push(step);
      else turn.parts.push({ kind: "tools", steps: [step] });
      turn.steps.push(step);
    } else if (message.role === "turn") {
      turn.live = !message.endedAt;
      if (message.startedAt) turn.startedAt = message.startedAt;
      if (message.startedAt && message.endedAt) {
        const span = Date.parse(message.endedAt) - Date.parse(message.startedAt);
        turn.workedMs = span > 0 ? span : null;
      }
    }
  }
  if (current) turns.push(current);

  turns.forEach((turn, index) => {
    const written = texts[index] ?? [];
    const paths = editPaths[index];
    if (paths) {
      turn.edits = paths.size;
      turn.editFile = paths.size === 1 ? [...paths][0].split(/[/\\]/).pop() || "" : "";
    }
    if (turn.live) {
      turn.answer = written.join("\n\n");
      const loading = [...turn.steps].reverse().find((step) => step.status === "running");
      turn.running = loading ? activityLabel(loading) : "Planning next moves";
      return;
    }
    turn.answer = written.at(-1) ?? "";
    turn.notes = written.slice(0, -1);
  });
  return turns;
}
