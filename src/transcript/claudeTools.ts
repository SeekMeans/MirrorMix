import type { DiffLine, StepResult, TodoItem } from "../shared/types";

/** Output lines kept per tool call; the browser shows the first few and opens the rest on request. */
const KEEP_LINES = 40;
const LINE_LIMIT = 400;
const DIFF_LIMIT = 200;
const ARGS_LIMIT = 240;

type Fields = Record<string, unknown>;

const str = (value: unknown) => (typeof value === "string" ? value : "");
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

export function clip(text: string, limit: number): string {
  const chars = Array.from(text);
  return chars.length > limit ? `${chars.slice(0, limit).join("")}…` : text;
}

/** Paths inside the session's folder are shown relative to it, as the terminal does. */
export function relPath(file: string, cwd: string): string {
  if (!file || !cwd) return file;
  const base = cwd.replace(/[\\/]+$/, "");
  const lower = file.toLowerCase();
  const prefix = base.toLowerCase();
  if (lower.startsWith(`${prefix}\\`) || lower.startsWith(`${prefix}/`)) return file.slice(base.length + 1);
  return file;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function quoteArgs(input: Fields, keys?: string[]): string {
  const parts: string[] = [];
  for (const key of keys ?? Object.keys(input)) {
    const value = input[key];
    if (value === undefined || value === null || value === "") continue;
    const shown = typeof value === "string" ? `"${value.replace(/\s+/g, " ")}"` : JSON.stringify(value);
    parts.push(`${key}: ${shown}`);
  }
  return clip(parts.join(", "), ARGS_LIMIT);
}

export interface ToolHeader {
  tool: string;
  server?: string;
  text: string;
}

/** The `Tool(args)` line, named and filled the way Claude Code prints it. */
export function toolHeader(name: string, input: unknown, cwd: string): ToolHeader {
  const fields = (input && typeof input === "object" ? input : {}) as Fields;
  const path = (key: string) => relPath(str(fields[key]), cwd);
  const firstLine = (text: string) => clip(text.split(/\r?\n/).find((line) => line.trim()) ?? "", ARGS_LIMIT);
  switch (name) {
    case "Bash":
    case "PowerShell":
      return { tool: name, text: firstLine(str(fields.command)) };
    case "Read":
      return { tool: "Read", text: path("file_path") };
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return { tool: "Update", text: path(name === "NotebookEdit" ? "notebook_path" : "file_path") };
    case "Write":
      return { tool: "Write", text: path("file_path") };
    case "Grep":
    case "Glob":
      return { tool: "Search", text: quoteArgs({ pattern: fields.pattern, path: fields.path ? path("path") : undefined }) };
    case "WebSearch":
      return { tool: "Web Search", text: `"${str(fields.query)}"` };
    case "WebFetch":
      return { tool: "Fetch", text: str(fields.url) };
    case "Task":
    case "Agent":
      return { tool: str(fields.subagent_type) || "Task", text: str(fields.description) };
    case "TodoWrite":
      return { tool: "Update Todos", text: "" };
    case "Skill":
      return { tool: "Skill", text: str(fields.skill) };
    default:
      break;
  }
  const mcp = name.match(/^mcp__(.+?)__(.+)$/);
  if (mcp) {
    if (mcp[2] === "update_plan") return { tool: "Update Todos", text: "" };
    return { tool: `${mcp[1]} - ${mcp[2]} (MCP)`, server: mcp[1], text: quoteArgs(fields) };
  }
  return { tool: name, text: quoteArgs(fields) };
}

/** Colour and cursor codes from command output; the page draws its own colours. */
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;

export function splitLines(text: string): string[] {
  return text.replace(ANSI, "").replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
}

export function withLines(result: StepResult, text: string): StepResult {
  const all = text.trim() ? splitLines(text) : [];
  if (!all.length) return result;
  return {
    ...result,
    lines: all.slice(0, KEEP_LINES).map((line) => clip(line, LINE_LIMIT)),
    more: Math.max(0, all.length - KEEP_LINES),
  };
}

/** Text of a tool_result block: a string, or the text parts of a block list (images are named, not inlined). */
export function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const block = part as Fields;
      if (block.type === "text") return str(block.text);
      if (block.type === "image") return "[Image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

interface Hunk {
  oldStart?: number;
  newStart?: number;
  lines?: unknown[];
}

export function diffOf(patch: unknown): { diff: DiffLine[]; added: number; removed: number } {
  const diff: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  if (!Array.isArray(patch)) return { diff, added, removed };
  patch.forEach((raw, index) => {
    const hunk = (raw ?? {}) as Hunk;
    let oldNo = num(hunk.oldStart) ?? 1;
    let newNo = num(hunk.newStart) ?? 1;
    if (index > 0) diff.push({ kind: "…", text: "" });
    for (const line of hunk.lines ?? []) {
      if (typeof line !== "string") continue;
      const mark = line[0];
      const text = clip(line.slice(1), LINE_LIMIT);
      if (mark === "+") {
        diff.push({ kind: "+", no: newNo++, text });
        added += 1;
      } else if (mark === "-") {
        diff.push({ kind: "-", no: oldNo++, text });
        removed += 1;
      } else if (mark !== "\\") {
        diff.push({ kind: " ", no: newNo++, text });
        oldNo += 1;
      }
    }
  });
  if (diff.length > DIFF_LIMIT) {
    const left = diff.length - DIFF_LIMIT;
    diff.length = DIFF_LIMIT;
    diff.push({ kind: "…", text: `+${left} lines` });
  }
  return { diff, added, removed };
}

function todoStatus(value: unknown): TodoItem["status"] {
  return value === "completed" || value === "in_progress" ? value : "pending";
}

/** TodoWrite gives the whole list each time. */
export function todosOf(input: unknown): TodoItem[] | undefined {
  const list = (input as Fields | undefined)?.todos;
  if (!Array.isArray(list)) return undefined;
  return list.map((item) => ({ text: str((item as Fields).content), status: todoStatus((item as Fields).status) }));
}

/**
 * The desktop app's plan tool sends either the whole list or a move along it
 * (advance / done / start); `previous` is the list as it stood before this call.
 */
export function planOf(input: unknown, previous: TodoItem[] | undefined): TodoItem[] | undefined {
  const fields = (input ?? {}) as Fields;
  if (Array.isArray(fields.items)) {
    return fields.items.map((item) => ({ text: str((item as Fields).content), status: todoStatus((item as Fields).status) }));
  }
  if (!previous) return undefined;
  const next = previous.map((item) => ({ ...item }));
  if (fields.advance === true) {
    const current = next.findIndex((item) => item.status === "in_progress");
    if (current >= 0) next[current].status = "completed";
    const following = next.findIndex((item, at) => at > current && item.status === "pending");
    if (following >= 0) next[following].status = "in_progress";
  }
  if (Array.isArray(fields.done)) {
    for (const at of fields.done) if (typeof at === "number" && next[at - 1]) next[at - 1].status = "completed";
  }
  if (typeof fields.start === "number" && next[fields.start - 1]) {
    for (const item of next) if (item.status === "in_progress") item.status = "completed";
    next[fields.start - 1].status = "in_progress";
  }
  return next;
}

/** Turns a tool_result (and the structured copy Claude Code keeps beside it) into what the terminal prints. */
export function toolResult(name: string, input: unknown, block: Fields, structured: unknown, cwd: string): StepResult {
  const text = resultText(block.content);
  const data = (structured && typeof structured === "object" && !Array.isArray(structured) ? structured : {}) as Fields;
  const fields = (input && typeof input === "object" ? input : {}) as Fields;
  if (block.is_error === true) {
    const message = text.replace(/<\/?tool_use_error>/g, "").trim();
    return withLines({ status: "error" }, message || "Error");
  }
  switch (name) {
    case "Bash":
    case "PowerShell": {
      if (data.interrupted === true) return { status: "error", summary: "Interrupted" };
      const out = [str(data.stdout), str(data.stderr)].filter((part) => part.trim()).join("\n") || text;
      return out.trim() ? withLines({ status: "ok" }, out) : { status: "ok", summary: "(No content)" };
    }
    case "Read": {
      const file = (data.file ?? {}) as Fields;
      const lines = num(file.numLines);
      return { status: "ok", summary: lines !== undefined ? `Read ${plural(lines, "line")}` : "Read file" };
    }
    case "Edit":
    case "MultiEdit":
    case "Write": {
      const { diff, added, removed } = diffOf(data.structuredPatch);
      const file = relPath(str(data.filePath) || str(fields.file_path), cwd);
      if (name === "Write" && data.type === "create") {
        const content = str(data.content) || str(fields.content);
        const count = content ? splitLines(content).length : 0;
        const lines = content ? splitLines(content).slice(0, KEEP_LINES).map((line, at) => clip(`${at + 1} ${line}`, LINE_LIMIT)) : [];
        return { status: "ok", summary: `Wrote ${plural(count, "line")} to ${file}`, lines, more: Math.max(0, count - KEEP_LINES) };
      }
      if (!diff.length) return withLines({ status: "ok" }, text);
      return {
        status: "ok",
        summary: `Updated ${file} with ${plural(added, "addition")} and ${plural(removed, "removal")}`,
        diff,
      };
    }
    case "Glob": {
      const files = num(data.numFiles);
      const names = Array.isArray(data.filenames) ? data.filenames.map((file) => relPath(str(file), cwd)).join("\n") : "";
      return withLines({ status: "ok", summary: files !== undefined ? `Found ${plural(files, "file")}` : undefined }, names);
    }
    case "Grep": {
      const lines = num(data.numLines);
      const files = num(data.numFiles);
      const summary =
        data.mode === "content" && lines !== undefined
          ? `Found ${plural(lines, "line")}`
          : files !== undefined
            ? `Found ${plural(files, "file")}`
            : undefined;
      return withLines({ status: "ok", summary }, text);
    }
    case "WebSearch": {
      const count = num(data.searchCount) ?? 1;
      const seconds = num(data.durationSeconds);
      return { status: "ok", summary: `Did ${plural(count, "search")}${seconds !== undefined ? ` in ${Math.round(seconds)}s` : ""}` };
    }
    case "WebFetch": {
      const bytes = num(data.bytes);
      const code = num(data.code);
      if (bytes === undefined) return withLines({ status: "ok" }, text);
      return { status: "ok", summary: `Received ${(bytes / 1024).toFixed(1)}KB${code ? ` (${code} ${str(data.codeText)})` : ""}` };
    }
    case "Task":
    case "Agent": {
      const uses = num(data.totalToolUseCount);
      const tokens = num(data.totalTokens);
      const ms = num(data.totalDurationMs);
      if (uses === undefined) return withLines({ status: "ok" }, text);
      const parts = [plural(uses, "tool use")];
      if (tokens !== undefined) parts.push(`${tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens} tokens`);
      if (ms !== undefined) parts.push(`${Math.round(ms / 1000)}s`);
      return { status: "ok", summary: `Done (${parts.join(" · ")})` };
    }
    case "AskUserQuestion": {
      const answers = (data.answers ?? {}) as Fields;
      const lines = Object.entries(answers).map(([question, answer]) => `· ${clip(question, 80)} → ${str(answer)}`);
      return lines.length ? { status: "ok", lines } : withLines({ status: "ok" }, text);
    }
    default:
      return text.trim() ? withLines({ status: "ok" }, text) : { status: "ok", summary: "(No content)" };
  }
}
