export type ToolId = "claude" | "codex" | "cursor" | "deepseek";

export type SessionStatus =
  | "idle"
  | "starting"
  | "running"
  | "occupied"
  | "exited"
  | "failed"
  | "create_failed";

export interface DiffLine {
  kind: "+" | "-" | " " | "…";
  /** Line number in the new file for "+" and " ", in the old file for "-". */
  no?: number;
  text: string;
}

export interface TodoItem {
  text: string;
  status: "pending" | "in_progress" | "completed";
}

/** What a tool call produced, shaped the way the terminal prints it under `⎿`. */
export interface StepResult {
  status: "running" | "ok" | "error";
  /** One line such as "Read 16 lines" that stands in for the output. */
  summary?: string;
  /** The first lines of the output; `more` counts the lines left out. */
  lines?: string[];
  more?: number;
  diff?: DiffLine[];
  todos?: TodoItem[];
}

/**
 * step: one tool call. `tool` is the name shown before the parentheses, `text` what goes inside them.
 * thinking: the model's visible reasoning.
 * turn: closes a round of work. `startedAt` / `endedAt` are ISO times, `tokens` the output tokens of the round.
 * A turn without `endedAt` is the round still running; it is always the last entry.
 */
export interface TranscriptMessage {
  id: string;
  role: "user" | "assistant" | "step" | "thinking" | "turn";
  text: string;
  tool?: string;
  /** The MCP server a tool belongs to. */
  server?: string;
  result?: StepResult;
  startedAt?: string;
  endedAt?: string;
  tokens?: number;
}

export interface ParsedSession {
  id: string;
  cwd: string;
  title: string;
  updatedAt: string;
  messages: TranscriptMessage[];
  turnComplete: boolean;
  /** Set when a round was stopped by hand: how many messages the transcript held at the latest stop. */
  interruptedAt?: number;
  /**
   * An open round waiting on nothing (no tool still running): when it last did anything. A round quiet for long is
   * one whose process went away mid-request, and is treated as over (see settleAbandoned).
   */
  idleSince?: string;
  /** An open round, tools still running or not: when it last did anything. */
  openActivityAt?: string;
  /** The model the session last used or was switched to, as the tool names it (`claude-opus-5-5`, `gpt-6.1-sol`). */
  model?: string;
  /** Codex's reasoning effort for that model (`low` … `xhigh`). */
  effort?: string;
  /**
   * DeepSeek Harness: the agent preset the session runs under. The desktop app sets one on every session it makes;
   * its one-shot command line only continues sessions without one.
   */
  agentPreset?: string;
}

export interface SessionSummary {
  tool: ToolId;
  id: string;
  title: string;
  updatedAt: string;
  status: SessionStatus;
  pinned: boolean;
  /** The latest reply has not finished. Shown as “运行中”. */
  working: boolean;
  /** The reply finished, and the AI tool still marks it unseen. Shown as a green dot. */
  unseen: boolean;
}

export interface WorkspaceGroup {
  path: string;
  /** The tool pins this project, or at least one of its conversations. */
  pinned?: boolean;
  /** Shown instead of the folder name, for groups that are not a folder in the tool's own list. */
  label?: string;
  missing: boolean;
  sessions: SessionSummary[];
}

export interface ToolBins {
  claudeExe: string;
  nodeExe: string;
  codexJs: string;
  /** Native desktop/standalone installs expose codex.exe instead of an npm JavaScript shim. */
  codexExe?: string;
  codexArgs?: string[];
  /** Present when the Cursor agent CLI is installed. */
  cursorNode?: string;
  cursorJs?: string;
}

export interface ScheduleJob {
  tool: ToolId;
  id: string;
  name: string;
  kind: string;
  status: string;
  cadence: string;
  prompt: string;
  location: string;
  updatedAt: string;
}

export interface LaunchRequest {
  file: string;
  args: string[];
  cwd: string;
}
