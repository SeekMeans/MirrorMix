import type { DiffLine, StepResult, TodoItem } from "../shared/types";
import { clip, diffOf, relPath, splitLines, withLines } from "./claudeTools";

/* Codex steps named and filled the way its terminal prints them: `• Ran <command>`,
   `• Edited <file> (+a -r)` with the diff, `• Updated Plan` with a checklist, `• Called server.tool(...)`. */

const ARGS_LIMIT = 240;

type Fields = Record<string, unknown>;

const str = (value: unknown) => (typeof value === "string" ? value : "");

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The end of a `{...}` literal starting at `from`, skipping braces inside strings. */
function objectEnd(code: string, from: number): number {
  let depth = 0;
  let quote = "";
  for (let at = from; at < code.length; at += 1) {
    const char = code[at];
    if (quote) {
      if (char === "\\") at += 1;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return at + 1;
    }
  }
  return -1;
}

/** Codex in code mode wraps each call in a small script: `await tools.shell_command({...})`. */
export function callsInScript(code: string): Array<{ name: string; args: unknown }> {
  const calls: Array<{ name: string; args: unknown }> = [];
  for (const match of code.matchAll(/tools\.([A-Za-z0-9_]+)\(\s*/g)) {
    const start = (match.index ?? 0) + match[0].length;
    let args: unknown;
    if (code[start] === "{") {
      const end = objectEnd(code, start);
      if (end > 0) args = parseJson(code.slice(start, end));
    }
    calls.push({ name: match[1], args });
  }
  return calls;
}

function commandOf(args: unknown): string {
  const command = (args as Fields | undefined)?.command;
  if (Array.isArray(command)) {
    const parts = command.filter((part): part is string => typeof part === "string");
    // ["powershell", "-Command", "..."] and ["bash", "-lc", "..."] read best as the script itself.
    if (parts.length >= 3 && /^(-c|-lc|-command)$/i.test(parts[parts.length - 2])) return parts[parts.length - 1];
    return parts.join(" ");
  }
  return str(command);
}

function firstLine(text: string): string {
  return clip(text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "", ARGS_LIMIT);
}

function argsSummary(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const fields = args as Fields;
  const title = str(fields.title) || str(fields.description) || str(fields.query);
  if (title) return clip(title, ARGS_LIMIT);
  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === "") continue;
    parts.push(`${key}: ${typeof value === "string" ? `"${value.replace(/\s+/g, " ")}"` : JSON.stringify(value)}`);
  }
  return clip(parts.join(", "), ARGS_LIMIT);
}

function planStatus(value: unknown): TodoItem["status"] {
  return value === "completed" || value === "in_progress" ? value : "pending";
}

export function planOfCodex(args: unknown): TodoItem[] | undefined {
  const plan = (args as Fields | undefined)?.plan;
  if (!Array.isArray(plan)) return undefined;
  return plan.map((item) => ({ text: str((item as Fields).step), status: planStatus((item as Fields).status) }));
}

export interface CodexCall {
  tool: string;
  text: string;
  /** Drawn some other way (patches by their apply event) or not worth a line (waiting on a running script). */
  hidden?: boolean;
  todos?: TodoItem[];
}

function oneCall(name: string, args: unknown, cwd: string): CodexCall {
  if (name === "shell_command" || name === "shell" || name === "exec_command" || name === "local_shell") {
    return { tool: "Ran", text: firstLine(commandOf(args)) };
  }
  if (name === "apply_patch") return { tool: "Edited", text: "", hidden: true };
  if (name === "update_plan") return { tool: "Updated Plan", text: "", todos: planOfCodex(args) };
  if (name === "view_image") return { tool: "Viewed Image", text: relPath(str((args as Fields | undefined)?.path), cwd) };
  if (name === "wait") return { tool: "Waited", text: "", hidden: true };
  const mcp = name.match(/^mcp__(.+?)__(.+)$/);
  if (mcp) return { tool: "Called", text: `${mcp[1]}.${mcp[2]}(${argsSummary(args)})` };
  return { tool: "Called", text: `${name.replace(/__/g, ".")}(${argsSummary(args)})` };
}

/** A function_call / custom_tool_call record, named the way the Codex terminal names it. */
export function codexCall(payload: Fields, cwd: string): CodexCall {
  const name = str(payload.name);
  const namespace = str(payload.namespace);
  if (payload.type === "custom_tool_call" && name === "exec") {
    const code = str(payload.input);
    const calls = callsInScript(code);
    if (calls.some((call) => call.name === "apply_patch")) return { tool: "Edited", text: "", hidden: true };
    if (!calls.length) return { tool: "Ran", text: firstLine(code) };
    const first = oneCall(calls[0].name, calls[0].args, cwd);
    if (first.tool === "Ran" && calls.length > 1) {
      const commands = calls.filter((call) => call.name === "shell_command").map((call) => firstLine(commandOf(call.args)));
      return { tool: "Ran", text: clip(commands.join(" && "), ARGS_LIMIT) };
    }
    return first;
  }
  if (payload.type === "custom_tool_call") return oneCall(name, payload.input, cwd);
  const args = typeof payload.arguments === "string" ? parseJson(payload.arguments) : payload.arguments;
  if (namespace.startsWith("mcp__")) return { tool: "Called", text: `${namespace.slice(5)}.${name}(${argsSummary(args)})` };
  if (namespace) return { tool: "Called", text: `${namespace}.${name}(${argsSummary(args)})` };
  return oneCall(name, args, cwd);
}

/** Text of a call's output: a plain string, or the text parts of a list. */
export function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return "";
  return output
    .map((part) => {
      const block = (part ?? {}) as Fields;
      if (typeof block.text === "string") return block.text;
      if (block.type === "input_image" || block.type === "image") return "[Image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** Shell output comes as `Exit code: N / Wall time / Output:` headers around the real output. */
export function codexResult(output: unknown): StepResult {
  const text = outputText(output);
  const codes = [...text.matchAll(/Exit code:\s*(-?\d+)/g)];
  if (!codes.length) {
    if (/^\s*Script running/i.test(text)) return { status: "running" };
    const body = text.replace(/^Script completed\s*\nWall time[^\n]*\nOutput:\n?/, "");
    return body.trim() ? withLines({ status: "ok" }, body) : { status: "ok", summary: "(No output)" };
  }
  const exit = Number(codes[codes.length - 1][1]);
  const marker = text.lastIndexOf("Output:\n");
  const body = marker >= 0 ? text.slice(marker + "Output:\n".length) : "";
  const result: StepResult = { status: exit === 0 ? "ok" : "error" };
  if (exit !== 0) result.summary = `Exit code ${exit}`;
  return body.trim() ? withLines(result, body) : { ...result, summary: result.summary ?? "(No output)" };
}

/** `@@ -a,b +c,d @@` hunks into the shape the Claude diff already uses. */
export function hunksOf(unified: string): Array<{ oldStart: number; newStart: number; lines: string[] }> {
  const hunks: Array<{ oldStart: number; newStart: number; lines: string[] }> = [];
  for (const line of splitLines(unified)) {
    const head = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (head) hunks.push({ oldStart: Number(head[1]), newStart: Number(head[2]), lines: [] });
    else if (hunks.length && /^[ +\-\\]/.test(line)) hunks[hunks.length - 1].lines.push(line);
  }
  return hunks;
}

export interface PatchStep {
  tool: string;
  text: string;
  result: StepResult;
}

/** One step per file a patch touched, as `• Edited file (+a -r)` with its diff. */
export function patchSteps(payload: Fields, cwd: string): PatchStep[] {
  const changes = (payload.changes ?? {}) as Record<string, Fields>;
  const ok = payload.success !== false;
  return Object.entries(changes).map(([file, change]) => {
    const name = relPath(str(change.move_path) || file, cwd);
    let diff: DiffLine[] = [];
    let added = 0;
    let removed = 0;
    if (change.type === "add") {
      const lines = str(change.content) ? splitLines(str(change.content)) : [];
      ({ diff, added, removed } = diffOf([{ oldStart: 0, newStart: 1, lines: lines.map((line) => `+${line}`) }]));
    } else if (change.type === "update") {
      ({ diff, added, removed } = diffOf(hunksOf(str(change.unified_diff))));
    }
    const tool = change.type === "add" ? "Added" : change.type === "delete" ? "Deleted" : "Edited";
    const counts = change.type === "delete" ? "" : ` (+${added} -${removed})`;
    const result: StepResult = ok ? { status: "ok", diff } : withLines({ status: "error" }, str(payload.stderr) || "Patch failed");
    return { tool, text: `${name}${counts}`, result };
  });
}
