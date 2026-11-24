import { createHash, randomUUID } from "node:crypto";
import { countToday, startOfToday, type TodayStats } from "../catalog/todayStats";
import { isCodexHistoryReference } from "../catalog/codexSqliteHistory";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { cursorChatModel, readCursorQueue } from "../catalog/cursor";
import type { ToolQuota } from "../catalog/quotas";
import { indexSessions, listClaudeSessionFiles, listCodexSessionFiles, readCatalog, readSession, type Catalog, type CatalogRoots } from "../catalog/readCatalog";
import { readSchedules } from "../schedule/readSchedules";
import type { LaunchRequest, ParsedSession, ScheduleJob, SessionStatus, ToolBins, ToolId, ToolPrompt, TranscriptMessage } from "../shared/types";
import { readScreenPrompt, screenAnswerKeys } from "../transcript/screenPrompt";
import { settleBeforeProcess } from "../transcript/claude";
import { createScreenMirror, type ScreenMirror } from "../transcript/mirror";
import { asksForLogin, asksForTrust, trustKeys } from "../transcript/screen";
import { isOccupied, type ProcessInfo } from "./occupancy";
import type { DeepseekRun, DeepseekRunResult } from "./deepseekAgent";
import { DeepseekAppError, type DeepseekApp } from "./deepseekApp";
import { deepseekSessionFile } from "../catalog/readCatalog";
import { appendDesktopStream, type WindowPrompt } from "./desktopComposer";
import { injectClaudeInbox, type ClaudeInbox } from "./claudeInbox";
import { codexConfigFix, encodeClaudeProject, exitNote, launchSpec, samePath } from "./launch";

/** The latest call in the open round that waits on the person and has no answer yet. */
export function pendingAsk(messages: TranscriptMessage[]): NonNullable<TranscriptMessage["ask"]> | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "user") return undefined;
    if (message.role === "step" && message.ask && message.result?.status === "running") return message.ask;
  }
  return undefined;
}

const promptId = (parts: string[]) => createHash("sha1").update(parts.join("\n")).digest("hex").slice(0, 12);
const YES_LABEL = /^(?:allow|always allow|approve|accept|run|yes|proceed|continue|keep planning|trust|允许|始终允许|总是允许|批准|接受|运行|是|继续|信任)/i;
const NO_LABEL = /^(?:deny|reject|decline|don.?t allow|do not allow|skip|no\b|拒绝|跳过|否|不允许|不同意)/i;
const toneOf = (label: string) => (NO_LABEL.test(label) ? { tone: "no" as const } : YES_LABEL.test(label) ? { tone: "yes" as const } : {});

/** A question read off an app window, worded with the transcript's own question when it has one. */
export function promptFromWindow(seen: WindowPrompt, ask?: NonNullable<TranscriptMessage["ask"]>): ToolPrompt {
  const kind: ToolPrompt["kind"] = ask?.kind === "plan" ? "plan" : ask?.kind === "question" ? "question" : "permission";
  const title = seen.title || (kind === "plan" ? "要按这个计划开始吗？" : "需要你确认");
  const detail = seen.detail || (kind === "plan" ? (ask?.plan ?? "") : "");
  return {
    id: promptId(["window", title, detail, ...seen.buttons]),
    kind,
    title,
    ...(detail ? { detail } : {}),
    options: seen.buttons.map((label) => ({ id: label, label, ...toneOf(label) })),
    via: "window",
  };
}

/**
 * A question only the transcript shows. Its choices are clicked by name in the app window when the session is
 * followed there; a plan, or a question of several parts, is answered in the tool itself.
 */
export function promptFromAsk(ask: NonNullable<TranscriptMessage["ask"]>, inWindow: boolean): ToolPrompt {
  if (ask.kind === "plan") {
    return { id: promptId(["plan", ask.plan ?? ""]), kind: "plan", title: "要按这个计划开始吗？", ...(ask.plan ? { detail: ask.plan } : {}), options: [], via: "window", readOnly: true };
  }
  const first = ask.questions[0];
  const many = ask.questions.length;
  const options = first.options.map((option) => ({ id: option.label, label: option.label, ...(option.description ? { description: option.description } : {}) }));
  return {
    id: promptId(["question", ...ask.questions.map((item) => item.question), ...options.map((item) => item.label)]),
    kind: "question",
    title: first.question,
    ...(first.header || many > 1 ? { header: [first.header, many > 1 ? `第 1 / ${many} 题` : ""].filter(Boolean).join(" · ") } : {}),
    options,
    via: "window",
    ...(!inWindow || many > 1 || first.multiSelect ? { readOnly: true } : {}),
  };
}

/** What the session row is allowed to say. A reply that has not finished is "running"; occupancy is not part of that. */
export function shownActivity(
  session: { working: boolean; unseen: boolean },
  pending: boolean,
  streaming: boolean,
): { working: boolean; unseen: boolean } {
  const working = pending || streaming || session.working;
  return { working, unseen: working ? false : session.unseen };
}

export interface PtyLike {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(callback: (data: string) => void): void;
  onExit(callback: (code: number) => void): void;
}

export type SpawnFn = (spec: LaunchRequest & { cols: number; rows: number }) => PtyLike;

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}

export interface SessionView {
  id: string;
  tool: ToolId;
  title: string;
  workspacePath: string;
  status: SessionStatus;
  sendEnabled: boolean;
  attached: "process" | "claude" | "desktop";
  /** The desktop app could not take a message, so MirrorMix resumed the session in its own Claude Code. */
  takenOver?: boolean;
  /** The terminal is asking whether to trust the folder; it takes no message until that is answered. */
  question?: "trust";
  /** The tool is waiting on the person: allow a command, approve a plan, pick an answer. Answered by `answerPrompt`. */
  prompt?: ToolPrompt;
  /** What the process printed before it stopped, when it stopped almost at once. */
  exitNote?: string;
  /** Visible CLI prompt when the terminal is waiting for a choice, not a model reply. */
  inputPrompt?: string;
  readOnlyReason?: string;
  /** The model the session is on, as the tool names it. */
  model?: string;
  /** Codex's reasoning effort. */
  effort?: string;
  /** A message `/model <name>` reaches the tool's own command line, so the page can switch the model. */
  modelSwitch?: boolean;
  /** Created from the MirrorMix page, so the page may delete it. Sessions the tools made themselves are theirs. */
  deletable?: boolean;
  messages: TranscriptMessage[];
}

interface Runtime {
  id: string;
  tool: ToolId;
  cwd: string;
  title: string;
  status: SessionStatus;
  pty?: PtyLike;
  /** When the process now in `pty` started: a round the transcript left open before then is over. */
  ptyStartedAt?: number;
  filePath?: string;
  buffer: string;
  mirror: ScreenMirror;
  sockets: Set<TerminalSocket>;
  inbox?: ClaudeInbox;
  /** Cursor has no terminal. Sending starts one background run and the page reads the transcript file. */
  headless?: boolean;
  stop?: () => void;
  echo?: string;
  /** When the echoed message was sent, so the web can start the round's clock before the transcript catches up. */
  echoAt?: string;
  /** How many times the same words were already in the transcript when the echoed message was sent. */
  echoSeen?: number;
  pendingTurn?: boolean;
  codexSending?: boolean;
  /** Follow-ups sent while a round is still running. `seen` is how many times that text was already in the transcript. */
  queued?: QueuedItem[];
  /** The session the process was asked to resume, kept so it can be started again. */
  resume?: string;
  /** Set once the process has been restarted with a compatibility option, so it is not restarted twice. */
  retried?: boolean;
  /** Restarted once already because its Claude Code came up on the login screen. */
  loginRetried?: boolean;
  loginCheck?: ReturnType<typeof setTimeout>;
  exitNote?: string;
  /**
   * The Claude desktop app could not take the message (the screen was locked, or its window would not send),
   * so MirrorMix resumed the session in its own Claude Code. It keeps that process until the session is closed here.
   */
  takenOver?: boolean;
  /**
   * A new Claude session that exists only here until its first message. That message starts it in the desktop app
   * when it can, so the app lists it too; otherwise in MirrorMix's own Claude Code, under this same id.
   */
  draft?: boolean;
  /** The first message went to the desktop app; its session file has not been found yet. */
  binding?: boolean;
}

export interface TerminalSocket {
  send(data: string): void;
  onMessage(callback: (data: string) => void): void;
  onClose(callback: () => void): void;
}

export interface SupervisorOptions {
  spawn: SpawnFn;
  bins: ToolBins;
  roots: CatalogRoots;
  listProcesses: () => ProcessInfo[];
  pollMs?: number;
  /** Desktop deployments must never silently launch a separate CLI conversation. */
  desktopOnly?: boolean;
  submitCodex?: (title: string, text: string, sessionId: string) => Promise<void>;
  codexReceiptMs?: number;
  codexDesktopSession?: (sessionId: string) => { title: string } | null;
  findClaudeInbox?: (sessionId: string, skipPids: number[]) => ClaudeInbox | null;
  injectClaude?: (inbox: ClaudeInbox, text: string) => Promise<void>;
  submitDesktop?: (title: string, text: string) => Promise<void>;
  /** Whether the Claude Code that MirrorMix starts can be signed in now (the desktop app's sign-in can be found). */
  claudeSignedIn?: () => boolean;
  /** Sessions taken off the list without touching their files (the ones an app keeps). */
  hidden?: import("../settings/hiddenSessions").HiddenSessions;
  /** Sessions created from the MirrorMix page. Only these can be deleted from it. */
  madeHere?: import("../settings/hiddenSessions").HiddenSessions;
  /** Moves a deleted session's files somewhere they can still be restored from. */
  trash?: (paths: string[]) => Promise<void>;
  /** Clicks Stop in the Claude or Codex window for the session titled so. Throws "idle" when nothing runs there. */
  stopDesktop?: (title: string) => Promise<void>;
  stopCodex?: (title: string, sessionId: string) => Promise<void>;
  /** Starts a session in the Claude desktop app for a folder it lists, with its first message. Rejects with a reason. */
  createDesktop?: (folder: string, text: string) => Promise<void>;
  /** Whether a new session may wait for the desktop app: the app is open and the screen is not locked. */
  desktopCanCreate?: () => Promise<boolean> | boolean;
  /**
   * The session as the Claude desktop app lists it, when that app is open. A session it lists is driven
   * through its window even when it is not running there yet, so both sides stay on one conversation.
   */
  desktopSession?: (sessionId: string) => { title: string } | null;
  /** The question an app window (Claude or Codex desktop, Cursor) shows in a conversation, by the app's title for it. */
  readWindowPrompt?: (tool: ToolId, title: string) => WindowPrompt | null;
  /** Clicks `label` in that conversation: an answer button, or a question's choice. */
  answerWindowPrompt?: (tool: ToolId, title: string, label: string, sessionId: string) => Promise<void>;
  readDesktopStream?: (title: string) => string;
  /** The Claude desktop app's own usage meter, when its window shows one. Replaces the guess from transcripts. */
  claudeUsage?: () => ToolQuota | null;
  /** Cursor's monthly usage, read from the Cursor CLI's /usage panel. */
  cursorUsage?: () => ToolQuota | null;
  disposeExtra?: () => void;
  /** Writes into the Cursor window for this chat. The CLI does not show up there. */
  submitCursor?: (title: string, text: string) => Promise<void>;
  /** Clicks Send now on a queued row, which interrupts the running reply. */
  submitCursorNow?: (title: string, text: string) => Promise<void>;
  /** Starts one Cursor agent reply. `kill` stops that reply only. */
  /** How long a command-line Cursor reply may run before it counts as started (default 5 s). */
  cursorStartWaitMs?: number;
  /** `output` is the tail of what the agent printed, for saying why a run failed. */
  startCursor?: (id: string, cwd: string, text: string, onExit: (code: number, output?: string) => void) => { kill: () => void };
  createCursorChat?: (cwd: string) => Promise<string>;
  /**
   * Starts one DeepSeek Harness reply (`dsh headless`). Without `sessionId` it makes a new session in `cwd`, whose
   * id `session` then gives. The page reads the session file, as for Cursor.
   */
  startDeepseek?: (cwd: string, text: string, sessionId: string | undefined, onExit: (result: DeepseekRunResult) => void) => DeepseekRun;
  /** The running DeepSeek Harness app's own server. Preferred over the command line while the app is open. */
  deepseekApp?: DeepseekApp;
  /** True while the Windows session is locked. The desktop windows stop taking input then. */
  workstationLocked?: () => Promise<boolean> | boolean;
  /** Delivers a Codex message through the local daemon, which keeps running while the terminal is frozen. */
  queueCodex?: (id: string, cwd: string, text: string) => Promise<void>;
}

const MAX_TEXT = 100_000;
/** A command-line Cursor reply that has not failed within this long is taken as started. */
const CURSOR_EARLY_EXIT_MS = 5_000;
/** How long a resumed Claude Code may take to draw its input line before the message is typed into it. */
const TAKEOVER_READY_MS = 20_000;
/** Output that has been quiet this long, after the first screen, means the terminal is waiting for input. */
const TAKEOVER_QUIET_MS = 1_200;
/** How long to look for the session file the desktop app writes for a session started there. */
const DESKTOP_BIND_MS = 120_000;

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** A follow-up just handed to Cursor can take a moment to show up in its queue. */
const QUEUE_HOLD_MS = 2_000;

export interface QueuedItem {
  text: string;
  seen: number;
  at?: number;
}

/**
 * The tray follows Cursor's queue. A message that has started is no longer in that list,
 * so it leaves the tray even when the transcript has not repeated its text yet.
 * For the first moments after sending, the local copy stays up until Cursor writes its own.
 */
export function reconcileQueue(local: QueuedItem[], client: string[] | null, userTexts: string[], now: number): QueuedItem[] {
  const count = (text: string) => userTexts.reduce((total, item) => total + (item === text ? 1 : 0), 0);
  if (client) {
    const optimistic = local.filter((item) => {
      if (client.includes(item.text)) return false;
      if (now - (item.at ?? 0) >= QUEUE_HOLD_MS) return false;
      return count(item.text) <= item.seen;
    });
    return [...client, ...optimistic.map((item) => item.text)].map((text) => {
      const prior = local.find((item) => item.text === text);
      return { text, seen: prior && !client.includes(text) ? prior.seen : count(text), at: prior?.at ?? now };
    });
  }
  const pending = new Map<string, number>();
  for (const text of userTexts) pending.set(text, (pending.get(text) ?? 0) + 1);
  const kept: QueuedItem[] = [];
  for (const item of local) {
    const have = pending.get(item.text) ?? 0;
    if (have <= item.seen) {
      kept.push(item);
      continue;
    }
    pending.set(item.text, have - 1);
  }
  return kept;
}

/**
 * The marker of the round still running belongs under everything else on screen.
 * A message just sent has no round in the transcript yet; `pendingSince` starts one so the clock runs right away.
 */
function withRound(messages: TranscriptMessage[], running?: TranscriptMessage, pendingSince?: string): TranscriptMessage[] {
  if (running) return [...messages, running];
  if (!pendingSince) return messages;
  return [...messages, { id: "pending-turn", role: "turn", text: "", startedAt: pendingSince, tokens: 0 }];
}
const CREATE_TIMEOUT_MS = 20_000;
/** A new terminal that has been quiet this long after its first output is waiting for input. */
const CREATE_QUIET_MS = 1_500;
/** How long a new Codex session is watched for its session file, which appears with the first message. */
const FOLLOW_NEW_MS = 6 * 3_600_000;
/** How long a sent message may stay unseen in the transcript before a finished transcript is believed instead. */
const ECHO_GRACE_MS = 15_000;
/** How long output may settle before the screen is checked for Claude Code's login menu. */
const LOGIN_CHECK_MS = 400;

function sameWords(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export interface Supervisor {
  capabilities(): { create: Record<ToolId, boolean> };
  catalog(): Catalog;
  /** Messages sent today, per AI tool. */
  todayStats?(): TodayStats;
  schedules(): ScheduleJob[];
  getSession(tool: ToolId, id: string): SessionView;
  open(tool: ToolId, id: string): SessionView;
  create(tool: ToolId, workspacePath: string): Promise<SessionView>;
  close(tool: ToolId, id: string): SessionView;
  send(tool: ToolId, id: string, text: string): Promise<void>;
  sendNow(tool: ToolId, id: string, text: string): Promise<void>;
  /** Stops the reply under way, the way the person would in the tool itself. */
  interrupt(tool: ToolId, id: string): Promise<void>;
  answer(tool: ToolId, id: string, choice: "trust" | "cancel"): SessionView;
  /** Answers what the tool is asking (`SessionView.prompt`) with one of its options; refused once the question changed. */
  answerPrompt(tool: ToolId, id: string, promptId: string, optionId: string): Promise<SessionView>;
  /** "trash": its files went to the Recycle Bin. "hidden": an app keeps it, so it only left this list. */
  remove(tool: ToolId, id: string): Promise<{ removed: "trash" | "hidden" }>;
  connectTerminal(tool: ToolId, id: string, socket: TerminalSocket): void;
  subscribe(tool: ToolId, id: string, listener: (view: SessionView) => void): () => void;
  dispose(): void;
}

export function createSupervisor(options: SupervisorOptions): Supervisor {
  const pollMs = options.pollMs ?? 500;
  const runtimes = new Map<string, Runtime>();
  const timers = new Set<NodeJS.Timeout>();

  const keyOf = (tool: ToolId, id: string) => `${tool}:${id}`;
  const aliases = new Map<string, string>();
  const runtimeFor = (tool: ToolId, id: string) => {
    const key = keyOf(tool, id);
    return runtimes.get(aliases.get(key) ?? key);
  };

  const ownedPids = () =>
    [...runtimes.values()].flatMap((runtime) => (runtime.pty && runtime.status !== "exited" ? [runtime.pty.pid] : []));

  const findStored = (tool: ToolId, id: string) => {
    const stored = indexSessions(options.roots)[tool].find((session) => session.id === id);
    return stored && isCodexHistoryReference(stored.filePath) ? readSession(tool, stored.filePath) ?? undefined : stored;
  };

  const workspaceKnown = (tool: ToolId, workspacePath: string) =>
    indexSessions(options.roots)[tool].some((session) => samePath(session.cwd, workspacePath)) ||
    // A project the tool lists with no sessions yet is still somewhere a session can be started.
    readCatalog(options.roots)[tool].some((entry) => !entry.label && samePath(entry.path, workspacePath));

  /** The transcript as the Claude Code now running the session sees it: rounds left by an earlier process are over. */
  const currentRound = <T extends ParsedSession>(runtime: Runtime, stored: T | null | undefined): T | null | undefined =>
    stored && runtime.tool === "claude" && runtime.pty && runtime.ptyStartedAt
      ? (settleBeforeProcess(stored, runtime.ptyStartedAt) as T)
      : stored;

  /** The name the app's window knows a session by, for a session followed in that window; null for any other. */
  const windowTitleOf = (runtime: Runtime, storedTitle?: string): string | null => {
    if (runtime.tool === "cursor" && runtime.headless && !runtime.takenOver) return storedTitle || runtime.title;
    if (runtime.inbox && !runtime.pty && (runtime.tool === "claude" || runtime.tool === "codex")) {
      const own = runtime.tool === "claude" ? options.desktopSession?.(runtime.id)?.title : options.codexDesktopSession?.(runtime.id)?.title;
      return own || storedTitle || runtime.title;
    }
    return null;
  };

  /**
   * What the session is waiting on the person for, if anything. A terminal's own menu is read off its screen; an app
   * window's question by its buttons; a question only the transcript shows (AskUserQuestion, a plan) by its words.
   */
  const promptFor = (runtime: Runtime, stored: ParsedSession | null | undefined, open: boolean): ToolPrompt | undefined => {
    if (runtime.pty) {
      const screen = readScreenPrompt(runtime.mirror.lines());
      // The trust question has its own banner, which also holds back the message box.
      return screen && screen.kind !== "trust" ? screen : undefined;
    }
    if (!open) return undefined;
    const ask = stored ? pendingAsk(stored.messages) : undefined;
    const title = windowTitleOf(runtime, stored?.title);
    const seen = title ? (options.readWindowPrompt?.(runtime.tool, title) ?? null) : null;
    if (seen) return promptFromWindow(seen, ask);
    if (ask) return promptFromAsk(ask, Boolean(title && options.answerWindowPrompt));
    return undefined;
  };

  /** Answers the session's question with one of its options, where it was asked: keys in the terminal, a click in the window. */
  const answerPrompt = async (tool: ToolId, id: string, promptId: string, optionId: string): Promise<SessionView> => {
    const runtime = runtimeFor(tool, id);
    if (!runtime) throw new ApiError(404, "unknown_session");
    const stored = currentRound(runtime, runtime.filePath ? readSession(runtime.tool, runtime.filePath, options.roots.cursorStateDb) : null);
    const prompt = promptFor(runtime, stored, true);
    if (!prompt) throw new ApiError(409, "no_question");
    // The question on screen changed since the page showed it: an answer meant for the earlier one is not given.
    if (prompt.id !== promptId) throw new ApiError(409, "prompt_changed");
    const option = prompt.options.find((item) => item.id === optionId);
    if (!option || prompt.readOnly) throw new ApiError(409, "no_option");
    if (prompt.via === "terminal") {
      const keys = runtime.pty ? screenAnswerKeys(runtime.mirror.lines(), promptId, optionId) : null;
      if (!keys || !runtime.pty) throw new ApiError(409, "prompt_changed");
      runtime.pty.write(keys);
    } else {
      const title = windowTitleOf(runtime, stored?.title);
      if (!title || !options.answerWindowPrompt) throw new ApiError(409, "no_option");
      try {
        await options.answerWindowPrompt(tool, title, option.label, runtime.id);
      } catch (error) {
        const reason = error instanceof Error ? error.message : "";
        if (reason === "locked") throw new ApiError(502, "answer_locked");
        if (reason === "minimized") throw new ApiError(502, "cursor_minimized");
        if (reason === "no_option") throw new ApiError(409, "option_missing");
        if (reason === "missing") throw new ApiError(502, "answer_window_missing");
        throw new ApiError(502, "answer_failed");
      }
    }
    emit(tool, id);
    return viewOf(runtime);
  };

  const viewOf = (runtime: Runtime): SessionView => {
    if (runtime.tool === "codex" && runtime.filePath && !isCodexHistoryReference(runtime.filePath) && !existsSync(runtime.filePath)) {
      const found = findStored("codex", runtime.id);
      if (found) runtime.filePath = found.filePath;
    }
    if (runtime.tool === "cursor" && runtime.filePath?.startsWith("cursor:")) {
      const found = findStored("cursor", runtime.id);
      if (found && !found.filePath.startsWith("cursor:")) runtime.filePath = found.filePath;
    }
    if (runtime.tool === "deepseek" && !runtime.filePath && !runtime.id.startsWith("new-")) {
      runtime.filePath = deepseekSessionFile(options.roots.deepseekSessionsDir, runtime.id) ?? undefined;
    }
    const stored = currentRound(runtime, runtime.filePath ? readSession(runtime.tool, runtime.filePath, options.roots.cursorStateDb) : null) ?? undefined;
    if (stored?.title) runtime.title = stored.title;
    // The running round's marker is put back at the very end once everything else is in place.
    const messages = (stored?.messages ?? []).filter((message) => message.role !== "turn" || message.endedAt);
    const running = stored?.messages.find((message) => message.role === "turn" && !message.endedAt);
    if (runtime.echo) {
      // The tool may store the message with its spacing tidied, so compare the words, not the exact bytes.
      const sent = sameWords(runtime.echo);
      // The same words may have been said before. Only a copy that was not there when this one was sent counts.
      const copies: number[] = [];
      messages.forEach((message, index) => {
        if (message.role === "user" && sameWords(message.text) === sent) copies.push(index);
      });
      const echoed = copies.length > (runtime.echoSeen ?? 0) ? copies[copies.length - 1] : -1;
      const answered = echoed >= 0 && messages.slice(echoed + 1).some((message) => message.role === "assistant" && message.text);
      // Stopped by hand in the tool itself: no reply is coming, so stop waiting for one.
      const stopped = echoed >= 0 && stored?.interruptedAt !== undefined && stored.interruptedAt > echoed;
      // The round the message started is over according to the transcript, whatever it ended with.
      const finished = echoed >= 0 && stored?.turnComplete === true;
      // The message never showed up in a recognisable form, yet the transcript has moved on and is at rest.
      // Waiting longer would leave this side "running" for good.
      const sentAt = runtime.echoAt ? Date.parse(runtime.echoAt) : 0;
      const lost =
        echoed < 0 &&
        stored?.turnComplete === true &&
        sentAt > 0 &&
        Date.now() - sentAt > ECHO_GRACE_MS &&
        Date.parse(stored.updatedAt) > sentAt;
      const unconfirmedCodex = runtime.tool === "codex" && !runtime.codexSending && echoed < 0 &&
        sentAt > 0 && Date.now() - sentAt > ECHO_GRACE_MS;
      if (answered || stopped || finished || lost || unconfirmedCodex) {
        runtime.echo = undefined;
        runtime.pendingTurn = false;
      } else if (echoed < 0) {
        messages.push({ id: "pending-user", role: "user", text: runtime.echo });
      }
    }
    const live =
      runtime.tool === "claude" && runtime.inbox && !runtime.pty
        ? options.readDesktopStream?.(options.desktopSession?.(runtime.id)?.title || stored?.title || runtime.title) ?? ""
        : "";
    const userTexts = messages.filter((message) => message.role === "user").map((message) => message.text);
    const clientQueue = runtime.tool === "cursor" ? readCursorQueue(options.roots.cursorStateDb, runtime.id) : null;
    const now = Date.now();
    const pendingQueue = runtime.tool === "codex" && !running
      ? runtime.queued?.filter((item) => now - (item.at ?? 0) <= ECHO_GRACE_MS) : runtime.queued;
    const queued = reconcileQueue(pendingQueue ?? [], clientQueue, userTexts, now);
    runtime.queued = queued.length ? queued : undefined;
    const shown = withRound(appendDesktopStream(messages, live), running, runtime.tool !== "codex" && runtime.pendingTurn ? runtime.echoAt : undefined);
    const withQueue = queued.length
      ? [...shown, ...queued.map((item, index) => ({ id: `queued-${index}`, role: "user" as const, text: item.text }))]
      : shown;
    const turnComplete = (stored?.turnComplete ?? runtime.status !== "running") && !runtime.pendingTurn && !live.trim();
    const trusting = Boolean(runtime.pty) && asksForTrust(runtime.mirror.lines());
    const screenReady = runtime.inbox || runtime.headless ? true : runtime.mirror.allowsInput() && !trusting;
    // A running round still accepts a follow-up. The client queues it instead of starting a second reply.
    // A DeepSeek session made in its desktop app can only go on there: the command line refuses its preset.
    const appOnly = runtime.tool === "deepseek" && Boolean(stored?.agentPreset) && !options.deepseekApp?.available();
    const sendEnabled = runtime.status === "running" && screenReady && !runtime.binding && !appOnly && !runtime.codexSending;
    return {
      id: runtime.id,
      tool: runtime.tool,
      title: stored?.title || runtime.title,
      workspacePath: runtime.cwd,
      status: runtime.status,
      sendEnabled,
      ...(!screenReady && runtime.status === "running" ? { inputPrompt: runtime.mirror.prompt() } : {}),
      ...(runtime.exitNote && runtime.status !== "running" ? { exitNote: runtime.exitNote } : {}),
      attached: runtime.inbox && !runtime.pty ? (runtime.tool === "codex" ? "desktop" : "claude") : "process",
      ...(runtime.takenOver ? { takenOver: true } : {}),
      ...(appOnly ? { readOnlyReason: "deepseek_app_session" } : {}),
      ...(trusting ? { question: "trust" as const } : {}),
      ...((() => {
        const prompt = trusting ? undefined : promptFor(runtime, stored, !turnComplete || Boolean(running));
        return prompt ? { prompt } : {};
      })()),
      ...modelOf(runtime.tool, runtime.id, stored),
      // Only Claude Code's own terminal takes `/model <name>` as a command. The desktop apps and Codex's picker do not.
      ...(runtime.tool === "claude" && runtime.pty && runtime.status === "running" ? { modelSwitch: true } : {}),
      ...(madeHere(runtime.tool, runtime.id) ? { deletable: true } : {}),
      messages: withQueue,
    };
  };

  const modelOf = (tool: ToolId, id: string, stored: { model?: string; effort?: string } | undefined) => {
    const model = stored?.model || (tool === "cursor" ? cursorChatModel(options.roots.cursorStateDb, id) : "");
    return model ? { model, ...(stored?.effort ? { effort: stored.effort } : {}) } : {};
  };

  const catalog = (): Catalog => {
    const disk = readCatalog(options.roots);
    const meter = options.claudeUsage?.();
    // A limit already hit (from the transcript) says more than the meter until its window resets.
    if (meter && disk.quotas.claude.level !== "full") disk.quotas = { ...disk.quotas, claude: meter };
    const month = options.cursorUsage?.();
    if (month) disk.quotas = { ...disk.quotas, cursor: month };
    for (const tool of ["claude", "codex", "cursor", "deepseek"] as const) {
      for (const group of disk[tool]) {
        if (options.hidden) group.sessions = group.sessions.filter((session) => !options.hidden!.has(tool, session.id));
        group.sessions = group.sessions.map((session) => {
          const runtime = runtimeFor(tool, session.id);
          // Asked for under the same name the session view uses, so the window is read once for both.
          const live =
            tool === "claude" && runtime?.inbox && !runtime.pty
              ? options.readDesktopStream?.(options.desktopSession?.(runtime.id)?.title || runtime.title || session.title) ?? ""
              : "";
          if (runtime && session.title && runtime.status !== "starting") runtime.title = session.title;
          // A message sent from this page keeps the row "running" until its reply is seen in the transcript. That check
          // used to happen only when the conversation was opened, so a finished reply stayed "running" on the list.
          if (runtime?.pendingTurn) viewOf(runtime);
          const stale =
            session.working && runtime?.pty && runtime.filePath
              ? currentRound(runtime, readSession(runtime.tool, runtime.filePath, options.roots.cursorStateDb))?.turnComplete === true
              : false;
          const asking =
            session.asking ||
            (runtime && (session.working || runtime.pendingTurn) ? Boolean(promptFor(runtime, null, true)) : false);
          const activity = shownActivity(stale ? { ...session, working: false } : session, tool !== "codex" && Boolean(runtime?.pendingTurn), live.trim().length > 0);
          return {
            ...session,
            title: session.title || runtime?.title || "",
            working: activity.working || Boolean(asking),
            unseen: activity.unseen,
            ...(asking ? { asking: true } : {}),
            status: runtime?.status === "failed" || runtime?.status === "create_failed" ? runtime.status : session.status,
          };
        });
      }
      for (const runtime of runtimes.values()) {
        if (runtime.tool !== tool || runtime.status !== "starting") continue;
        const group = disk[tool].find((item) => samePath(item.path, runtime.cwd));
        const summary = {
          tool,
          id: runtime.id,
          title: "正在创建",
          updatedAt: new Date().toISOString(),
          status: "starting" as const,
          pinned: false,
          working: false,
          unseen: false,
        };
        if (group) group.sessions.unshift(summary);
      }
    }
    return disk;
  };

  /** Options the installed Codex CLI turned out to need, learned from its own error and kept for later launches. */
  let codexOptions: string[] = [];

  const attach = (runtime: Runtime, pty: PtyLike) => {
    runtime.pty = pty;
    runtime.ptyStartedAt = Date.now();
    runtime.mirror.replyWith((data) => runtime.pty?.write(data));
    pty.onData((data) => {
      runtime.buffer = (runtime.buffer + data).slice(-2_000_000);
      runtime.mirror.write(data);
      for (const socket of runtime.sockets) socket.send(data);
      // Started without the sign-in (it could not be found at that moment): once it can be, start it again with it.
      // The screen copy takes output in a moment later, so it is looked at once the output settles.
      if (runtime.tool === "claude" && !runtime.loginRetried && runtime.pty === pty) {
        clearTimeout(runtime.loginCheck);
        runtime.loginCheck = setTimeout(() => {
          if (runtime.loginRetried || runtime.pty !== pty || !asksForLogin(runtime.mirror.lines())) return;
          runtime.loginRetried = true;
          if (!options.claudeSignedIn?.()) return;
          console.warn(`[claude] ${runtime.id} started signed out; starting it again with the desktop app's sign-in`);
          runtime.buffer = "";
          runtime.mirror = createScreenMirror();
          try {
            const next = launch(runtime.tool, runtime.cwd, runtime.resume);
            pty.kill();
            attach(runtime, next);
            emit(runtime.tool, runtime.id);
          } catch {
            /* keep the one that is running; the page shows its login screen */
          }
        }, LOGIN_CHECK_MS);
      }
    });
    pty.onExit(() => {
      // A process that was replaced (started again, or handed to the desktop app) says nothing about the session.
      if (runtime.pty !== pty) return;
      runtime.pty = undefined;
      if (runtime.inbox) return;
      // An older Codex CLI stops at once on a setting the desktop app wrote. Start it again with that setting overridden.
      const fix = runtime.tool === "codex" && !runtime.retried ? codexConfigFix(runtime.buffer) : null;
      if (fix && (runtime.status === "running" || runtime.status === "starting")) {
        runtime.retried = true;
        codexOptions = fix;
        runtime.buffer = "";
        runtime.mirror = createScreenMirror();
        try {
          attach(runtime, launch(runtime.tool, runtime.cwd, runtime.resume));
          return;
        } catch {
          /* fall through: the session is reported as exited with what the first attempt printed */
        }
      }
      runtime.exitNote = exitNote(runtime.buffer) || undefined;
      if (runtime.status === "starting") runtime.status = "create_failed";
      else if (runtime.status === "running") runtime.status = "exited";
    });
  };

  /** The CLI for `tool` is installed on this PC. */
  const hasCli = (tool: ToolId) =>
    tool === "claude" ? Boolean(options.bins.claudeExe) : tool === "codex" ? Boolean(options.bins.codexExe || options.bins.codexJs) : true;

  const launch = (tool: ToolId, cwd: string, sessionId?: string, newSessionId?: string, initialPrompt?: string) => {
    if (!hasCli(tool)) throw new ApiError(409, tool === "claude" ? "claude_cli_missing" : "codex_cli_missing");
    let pty: PtyLike;
    try {
      pty = options.spawn({ ...launchSpec(tool, cwd, options.bins, sessionId, codexOptions, newSessionId, initialPrompt), cols: 100, rows: 28 });
    } catch {
      throw new ApiError(500, "failed");
    }
    return pty;
  };

  const externalInbox = (tool: ToolId, id: string) =>
    tool === "claude" && !options.desktopOnly ? options.findClaudeInbox?.(id, ownedPids()) ?? null : null;

  /** Stands in for an inbox when the desktop app lists the session but has not started it: sending goes through its window. */
  const VIA_WINDOW: ClaudeInbox = { pipe: "", token: "" };

  const usableInbox = (inbox: ClaudeInbox | undefined): ClaudeInbox | null =>
    inbox?.pipe && inbox.token ? inbox : null;

  /** Set when the Claude desktop app is open, lists this session, and messages can be typed into its window. */
  const desktopRow = (tool: ToolId, id: string) =>
    tool === "codex" && options.submitCodex ? (options.codexDesktopSession ? options.codexDesktopSession(id) : { title: "" }) :
      tool === "claude" && options.submitDesktop ? options.desktopSession?.(id) ?? null : null;

  const followTool = (tool: ToolId, id: string, stored: { cwd: string; title: string; filePath: string }, inbox: ClaudeInbox) => {
    const existing = runtimeFor(tool, id);
    if (existing) {
      existing.inbox = inbox;
      existing.takenOver = false;
      existing.status = "running";
      existing.pty?.kill();
      existing.pty = undefined;
      return viewOf(existing);
    }
    const relay: Runtime = {
      id,
      tool,
      cwd: stored.cwd,
      title: stored.title,
      status: "running",
      buffer: "",
      mirror: createScreenMirror(),
      sockets: new Set(),
      filePath: stored.filePath,
      inbox,
    };
    runtimes.set(keyOf(tool, id), relay);
    return viewOf(relay);
  };

  const openHeadless = (stored: { id: string; cwd: string; title: string; filePath: string }, tool: ToolId = "cursor"): SessionView => {
    const existing = runtimeFor(tool, stored.id);
    if (existing?.status === "running") return viewOf(existing);
    const runtime: Runtime = {
      id: stored.id,
      tool,
      cwd: stored.cwd,
      title: stored.title,
      status: "running",
      buffer: "",
      mirror: createScreenMirror(),
      sockets: new Set(),
      filePath: stored.filePath,
      headless: true,
    };
    runtimes.set(keyOf(tool, stored.id), runtime);
    return viewOf(runtime);
  };

  const open = (tool: ToolId, id: string): SessionView => {
    id = runtimeFor(tool, id)?.id ?? id;
    const stored = findStored(tool, id);
    if (!stored) throw new ApiError(404, "unknown_session");
    if (!existsSync(stored.cwd)) throw new ApiError(409, "missing_workspace");
    if (tool === "cursor" || tool === "deepseek") return openHeadless(stored, tool);
    const held = runtimes.get(keyOf(tool, id));
    if (held?.takenOver && held.pty) return viewOf(held);
    const inbox = externalInbox(tool, id);
    if (inbox) return followTool(tool, id, stored, inbox);
    // Starting a separate process here would fork the conversation away from the desktop app, which would
    // never show what is written from this side. Follow the app's own session instead.
    if (desktopRow(tool, id)) return followTool(tool, id, stored, VIA_WINDOW);
    if (options.desktopOnly) return getSession(tool, id);
    const existing = runtimeFor(tool, id);
    if (existing?.status === "running" && existing.pty) return viewOf(existing);
    const occupied = isOccupied(id, options.listProcesses(), ownedPids());
    if (occupied) throw new ApiError(409, "occupied");
    const pty = launch(tool, stored.cwd, id);
    const runtime: Runtime = {
      id,
      tool,
      cwd: stored.cwd,
      title: stored.title,
      status: "running",
      buffer: "",
      mirror: createScreenMirror(),
      sockets: new Set(),
      filePath: stored.filePath,
      resume: id,
    };
    attach(runtime, pty);
    runtimes.set(keyOf(tool, id), runtime);
    if (!runtime.pty) {
      runtime.status = "failed";
      throw new ApiError(500, "failed");
    }
    return viewOf(runtime);
  };

  /** Without a store (tests, older setups) nothing counts as made here, so nothing can be deleted. */
  const madeHere = (tool: ToolId, id: string) => Boolean(options.madeHere?.has(tool, id));
  const rememberMade = (tool: ToolId, id: string) => {
    try {
      options.madeHere?.add(tool, id);
    } catch (error) {
      console.warn(`[create] could not record new ${tool} session ${id}: ${error instanceof Error ? error.message : error}`);
    }
  };

  const filesFor = (tool: ToolId) =>
    tool === "claude" ? listClaudeSessionFiles(options.roots.claudeProjectsDir) : listCodexSessionFiles(options.roots.codexSessionsDir);

  /**
   * A new DeepSeek Harness session exists only once its first message runs: the tool names it then. Until that, the
   * page holds it under a stand-in id, which keeps answering after the real one is known.
   */
  const createDeepseek = async (workspacePath: string): Promise<SessionView> => {
    if (!workspaceKnown("deepseek", workspacePath)) throw new ApiError(404, "unknown_workspace");
    if (!existsSync(workspacePath)) throw new ApiError(409, "missing_workspace");
    let made: string | null = null;
    if (options.deepseekApp?.available()) {
      try {
        made = await options.deepseekApp.create(workspacePath);
      } catch (error) {
        if (error instanceof DeepseekAppError && error.reason === "refused") throw new ApiError(502, "create_failed");
      }
    }
    if (!made && !options.startDeepseek) throw new ApiError(500, "failed");
    const standIn = made ?? `new-${randomUUID()}`;
    const runtime: Runtime = {
      id: standIn,
      tool: "deepseek",
      cwd: workspacePath,
      title: "新会话",
      status: "running",
      buffer: "",
      mirror: createScreenMirror(),
      sockets: new Set(),
      headless: true,
    };
    rememberMade("deepseek", standIn);
    runtimes.set(keyOf("deepseek", standIn), runtime);
    return viewOf(runtime);
  };

  const createCursor = async (workspacePath: string): Promise<SessionView> => {
    if (!workspaceKnown("cursor", workspacePath)) throw new ApiError(404, "unknown_workspace");
    if (!existsSync(workspacePath)) throw new ApiError(409, "missing_workspace");
    if (!options.createCursorChat) throw new ApiError(500, "failed");
    let id: string;
    try {
      id = await options.createCursorChat(workspacePath);
    } catch {
      throw new ApiError(504, "create_failed");
    }
    const runtime: Runtime = {
      id,
      tool: "cursor",
      cwd: workspacePath,
      title: "新会话",
      status: "running",
      buffer: "",
      mirror: createScreenMirror(),
      sockets: new Set(),
      filePath: `cursor:${id}`,
      headless: true,
    };
    rememberMade("cursor", id);
    runtimes.set(keyOf("cursor", id), runtime);
    return viewOf(runtime);
  };

  /**
   * Starts a new session in a folder and hands it back as soon as its terminal is up.
   * Claude Code is given the session's id up front. Codex writes its session file only once the first message
   * is sent, so its session goes by a stand-in id until that file appears, then by the real one; the stand-in
   * keeps answering, so a page that still uses it follows along.
   */
  const create = async (tool: ToolId, workspacePath: string): Promise<SessionView> => {
    if (tool === "cursor") return createCursor(workspacePath);
    if (tool === "deepseek") return createDeepseek(workspacePath);
    if (options.desktopOnly) throw new ApiError(409, "desktop_create_required");
    if (!workspaceKnown(tool, workspacePath)) throw new ApiError(404, "unknown_workspace");
    if (!existsSync(workspacePath)) throw new ApiError(409, "missing_workspace");
    if (tool === "claude" && options.createDesktop && (await desktopMayCreate())) {
      // Nothing starts yet: the first message decides where the session lives.
      const draftId = randomUUID();
      const draft: Runtime = {
        id: draftId,
        tool,
        cwd: workspacePath,
        title: "新会话",
        status: "running",
        buffer: "",
        mirror: createScreenMirror(),
        sockets: new Set(),
        draft: true,
      };
      rememberMade(tool, draftId);
      runtimes.set(keyOf(tool, draftId), draft);
      return viewOf(draft);
    }
    const before = new Set(filesFor(tool));
    const beforeThreads = tool === "codex" ? new Set(indexSessions(options.roots).codex.map((session) => session.id)) : new Set<string>();
    const newId = tool === "claude" ? randomUUID() : undefined;
    const pty = launch(tool, workspacePath, undefined, newId);
    const runtime: Runtime = {
      id: newId ?? `pending-${pty.pid}`,
      tool,
      cwd: workspacePath,
      title: "新会话",
      status: "running",
      buffer: "",
      mirror: createScreenMirror(),
      sockets: new Set(),
      ...(newId
        ? { filePath: path.join(options.roots.claudeProjectsDir, encodeClaudeProject(workspacePath), `${newId}.jsonl`), resume: newId }
        : {}),
    };
    attach(runtime, pty);
    if (newId) rememberMade(tool, newId);
    runtimes.set(keyOf(tool, runtime.id), runtime);

    if (!newId) {
      // Find the Codex session file once it exists and move the session over to its real id.
      const standIn = runtime.id;
      const startedAt = Date.now();
      const timer = setInterval(() => {
        const gone = !runtime.pty || runtime.status !== "running";
        if (gone || Date.now() - startedAt > FOLLOW_NEW_MS) {
          clearInterval(timer);
          timers.delete(timer);
          return;
        }
        const appeared = filesFor(tool).filter((file) => !before.has(file));
        // Another Codex in the same folder can write a session file meanwhile. Only the file that starts with
        // the message sent from here is this one.
        const sent = runtime.echo;
        if (!sent) return;
        const stored = indexSessions(options.roots)[tool].find(
          (session) =>
            (appeared.includes(session.filePath) || (tool === "codex" && isCodexHistoryReference(session.filePath) && !beforeThreads.has(session.id))) &&
            samePath(session.cwd, workspacePath) &&
            (isCodexHistoryReference(session.filePath) ? readSession(tool, session.filePath)?.messages ?? [] : session.messages)
              .some((message) => message.role === "user" && sameWords(message.text) === sameWords(sent)),
        );
        if (!stored) return;
        clearInterval(timer);
        timers.delete(timer);
        runtime.id = stored.id;
        runtime.filePath = stored.filePath;
        runtime.resume = stored.id;
        if (stored.title) runtime.title = stored.title;
        rememberMade(tool, stored.id);
        runtimes.set(keyOf(tool, stored.id), runtime);
        // The stand-in stays as a second name for the same session.
        runtimes.set(keyOf(tool, standIn), runtime);
        emit(tool, standIn);
      }, pollMs);
      timers.add(timer);
    }

    // Wait for its first screen: either ready for a message, or asking whether to trust the folder.
    const started = Date.now();
    let seen = 0;
    let quietSince = Date.now();
    for (;;) {
      if (!runtime.pty) {
        runtime.status = "create_failed";
        throw new ApiError(504, "create_failed");
      }
      const length = runtime.buffer.length;
      if (length !== seen) {
        seen = length;
        quietSince = Date.now();
      }
      // A terminal that prints nothing at all is handed over anyway; the page follows its screen from there.
      const quiet = Date.now() - quietSince >= CREATE_QUIET_MS;
      if (seen > 0 ? asksForTrust(runtime.mirror.lines()) || quiet : Date.now() - started >= CREATE_QUIET_MS * 2) break;
      if (Date.now() - started > CREATE_TIMEOUT_MS) break;
      await pause(150);
    }
    return viewOf(runtime);
  };

  /** Answers the question the terminal is asking (for now: whether to trust the folder). */
  const answer = (tool: ToolId, id: string, choice: "trust" | "cancel"): SessionView => {
    const runtime = runtimes.get(keyOf(tool, id));
    if (!runtime?.pty) throw new ApiError(404, "unknown_session");
    const keys = trustKeys(runtime.mirror.lines(), choice);
    if (!keys) throw new ApiError(409, "no_question");
    runtime.pty.write(keys);
    return viewOf(runtime);
  };

  const close = (tool: ToolId, id: string): SessionView => {
    const runtime = runtimeFor(tool, id);
    if (!runtime) throw new ApiError(404, "unknown_session");
    if (runtime.headless) {
      runtime.stop?.();
      runtime.stop = undefined;
      runtime.pendingTurn = false;
      runtime.status = "exited";
      const view = viewOf(runtime);
      runtimes.delete(keyOf(tool, id));
      return { ...view, status: "exited", sendEnabled: false };
    }
    if (runtime.inbox && !runtime.pty) {
      const view = viewOf(runtime);
      runtimes.delete(keyOf(tool, id));
      return { ...view, status: "occupied", sendEnabled: false };
    }
    runtime.pty?.kill();
    if (runtime.status === "running" || runtime.status === "starting") runtime.status = "exited";
    return viewOf(runtime);
  };

  const send = async (tool: ToolId, id: string, text: string) => {
    if (!text.trim() || text.length > MAX_TEXT) throw new ApiError(400, "bad_request");
    let runtime = runtimeFor(tool, id);
    // A session taken over here keeps its own process; going back to the window would drop it.
    const inbox = runtime?.pty && !runtime.takenOver ? externalInbox(tool, id) ?? (desktopRow(tool, id) ? VIA_WINDOW : null) : null;
    if (runtime && inbox) {
      followTool(tool, id, { cwd: runtime.cwd, title: runtime.title, filePath: runtime.filePath ?? "" }, inbox);
      runtime = runtimeFor(tool, id);
    }
    const current = runtime ? viewOf(runtime) : null;
    if (!runtime || !current?.sendEnabled) throw new ApiError(409, "not_idle");
    const inTurn = Boolean(current.messages.some((message) => message.role === "turn" && !message.endedAt));
    const desktopHistory = tool === "codex" && isCodexHistoryReference(runtime.filePath ?? "");
    const remember = () => {
      if (inTurn) {
        const seen = current.messages.filter((message) => message.role === "user" && message.text === text).length;
        runtime.queued = [...(runtime.queued ?? []), { text, seen, at: Date.now() }];
        return;
      }
      runtime.echo = text;
      runtime.echoSeen = current.messages.filter(
        (message) => message.role === "user" && message.id !== "pending-user" && sameWords(message.text) === sameWords(text),
      ).length;
      runtime.echoAt = new Date().toISOString();
      runtime.pendingTurn = true;
    };
    const forget = () => {
      if (runtime.queued?.at(-1)?.text === text) {
        runtime.queued = runtime.queued.slice(0, -1);
        if (!runtime.queued.length) runtime.queued = undefined;
      }
      if (runtime.echo === text) {
        runtime.echo = undefined;
        runtime.pendingTurn = false;
      }
    };
    const screenLocked = async () => {
      try {
        return Boolean(await options.workstationLocked?.());
      } catch {
        return false;
      }
    };
    /**
     * Runs the reply with Cursor's command-line agent. A run that fails at once (not signed in, say) is reported to
     * the page instead of letting the message vanish; one still going after a few seconds is treated as started.
     */
    const startCursorReply = async (target: Runtime, reply: string) => {
      if (!options.startCursor) return false;
      target.stop?.();
      target.takenOver = true;
      let settle: (result: { code: number; output: string } | null) => void = () => {};
      const early = new Promise<{ code: number; output: string } | null>((resolve) => {
        settle = resolve;
      });
      const wait = setTimeout(() => settle(null), options.cursorStartWaitMs ?? CURSOR_EARLY_EXIT_MS);
      const run = options.startCursor(target.id, target.cwd, reply, (code, output = "") => {
        clearTimeout(wait);
        settle({ code, output });
        if (target.stop === run.kill) target.stop = undefined;
        if (code !== 0) {
          target.echo = undefined;
          target.pendingTurn = false;
          console.warn(`[cursor agent] reply failed (exit ${code}): ${output.trim().slice(-400)}`);
        }
        emit(tool, id);
      });
      target.stop = run.kill;
      emit(tool, id);
      const result = await early;
      if (result && result.code !== 0) {
        target.takenOver = false;
        forget();
        if (/authentication required|agent login|not logged in|unauthori[sz]ed/i.test(result.output)) throw new ApiError(502, "cursor_login");
        throw new ApiError(502, "cursor_cli_failed");
      }
      return true;
    };
    /**
     * Runs one DeepSeek Harness reply. A run that fails at once (no API key, say) is reported to the page instead of
     * letting the message vanish; one still going after a few seconds is treated as started. A new session moves
     * over to the id the tool gives it.
     */
    const startDeepseekReply = async (target: Runtime, reply: string) => {
      if (!options.startDeepseek) throw new ApiError(500, "failed");
      target.stop?.();
      target.takenOver = true;
      const standIn = target.filePath ? undefined : target.id;
      let settle: (result: DeepseekRunResult | null) => void = () => {};
      const early = new Promise<DeepseekRunResult | null>((resolve) => {
        settle = resolve;
      });
      const wait = setTimeout(() => settle(null), options.cursorStartWaitMs ?? CURSOR_EARLY_EXIT_MS);
      const run = options.startDeepseek(target.cwd, reply, standIn ? undefined : target.id, (result) => {
        clearTimeout(wait);
        settle(result);
        if (target.stop === run.kill) target.stop = undefined;
        if (result.code !== 0) {
          target.echo = undefined;
          target.pendingTurn = false;
          console.warn(`[deepseek] reply failed (${result.errorCode || result.code}): ${(result.error ?? "").slice(-400)}`);
        }
        emit("deepseek", standIn ?? target.id);
      });
      target.stop = run.kill;
      if (standIn) {
        run.session.then(
          (sessionId) => {
            target.id = sessionId;
            target.filePath = deepseekSessionFile(options.roots.deepseekSessionsDir, sessionId) ?? undefined;
            rememberMade("deepseek", sessionId);
            runtimes.set(keyOf("deepseek", sessionId), target);
            emit("deepseek", standIn);
          },
          () => {},
        );
      }
      emit("deepseek", standIn ?? target.id);
      const result = await early;
      if (result && result.code !== 0) {
        target.takenOver = false;
        forget();
        if (result.errorCode === "MISSING_CREDENTIAL") throw new ApiError(502, "deepseek_key");
        if (result.errorCode === "AUTH") throw new ApiError(502, "deepseek_auth");
        throw new ApiError(502, "deepseek_failed");
      }
    };
    if (tool === "deepseek") {
      // The file of a session started from here is only known once the tool has written it.
      if (!runtime.filePath && !runtime.id.startsWith("new-")) runtime.filePath = deepseekSessionFile(options.roots.deepseekSessionsDir, runtime.id) ?? undefined;
      remember();
      const app = options.deepseekApp;
      if (app?.available()) {
        try {
          if (runtime.id.startsWith("new-")) {
            const standIn = runtime.id;
            const made = await app.create(runtime.cwd);
            runtime.id = made;
            rememberMade("deepseek", made);
            runtimes.set(keyOf("deepseek", made), runtime);
            emit("deepseek", standIn);
          }
          // A message sent while a reply runs waits for the next turn, as one typed into the app does.
          await app.prompt(runtime.id, text, "queue");
          runtime.takenOver = false;
          emit(tool, id);
          return;
        } catch (error) {
          if (error instanceof DeepseekAppError && error.reason === "refused") {
            forget();
            console.warn(`[deepseek app] refused (${error.code}): ${error.message}`);
            throw new ApiError(502, "deepseek_app_refused");
          }
          // Unreachable: the command line below can still answer the sessions it may continue.
        }
      }
      const stored = runtime.filePath ? readSession("deepseek", runtime.filePath) : null;
      if (stored?.agentPreset) {
        forget();
        throw new ApiError(409, "deepseek_app_session");
      }
      await startDeepseekReply(runtime, text);
      emit(tool, id);
      return;
    }
    if (runtime.draft) {
      await startDraft(runtime, text);
      remember();
      emit(tool, id);
      return;
    }
    if (runtime.headless) {
      if (!options.submitCursor) throw new ApiError(500, "failed");
      const title = (runtime.filePath ? readSession(runtime.tool, runtime.filePath, options.roots.cursorStateDb)?.title : "") || runtime.title;
      remember();
      emit(tool, id);
      try {
        await options.submitCursor(title, text);
        runtime.takenOver = false;
      } catch (error) {
        const reason = error instanceof Error ? error.message : "";
        // The window cannot be typed into (the screen is locked, it is minimized while someone is at the computer, or
        // it would not send): run the reply with Cursor's command-line agent instead, which needs no window.
        if ((reason === "locked" || reason === "failed" || reason === "minimized") && (await startCursorReply(runtime, text))) return;
        forget();
        if (reason === "busy") throw new ApiError(409, "not_idle");
        if (reason === "locked") throw new ApiError(502, "cursor_locked");
        if (reason === "minimized") throw new ApiError(502, "cursor_minimized");
        if (reason === "missing") throw new ApiError(502, "cursor_unavailable");
        throw new ApiError(502, "cursor_failed");
      }
      emit(tool, id);
      return;
    }
    // Whether the page was already shown the message (as sent, its round under way) before it was delivered.
    let shownEarly = false;
    const abandonEarly = () => {
      if (!shownEarly) return;
      forget();
      shownEarly = false;
      emit(tool, id);
    };
    if (runtime.inbox && !runtime.pty) {
      // Typing into the desktop window takes a few seconds. The page shows the message at once and the round's clock
      // starts now, so the wait counts as part of the reply; it is taken back if the window and every fallback refuse.
      remember();
      shownEarly = true;
      emit(tool, id);
      // The desktop app's own name for the session is what its sidebar shows, so that is what to look for there.
      const title =
        (tool === "claude" ? options.desktopSession?.(id)?.title : options.codexDesktopSession?.(id)?.title) ||
        (runtime.filePath ? readSession(runtime.tool, runtime.filePath, options.roots.cursorStateDb)?.title : "") ||
        runtime.title;
      try {
        if (tool === "codex" && options.submitCodex) {
          runtime.codexSending = true;
          const copies = runtime.echoSeen ?? 0;
          await options.submitCodex(title, text, runtime.id);
          if (desktopHistory && !inTurn) {
            const deadline = Date.now() + (options.codexReceiptMs ?? ECHO_GRACE_MS);
            const sent = sameWords(text);
            for (;;) {
              const observed = readSession("codex", runtime.filePath!)?.messages.filter(
                (message) => message.role === "user" && sameWords(message.text) === sent,
              ).length ?? 0;
              if (observed > copies) break;
              const left = deadline - Date.now();
              if (left <= 0) throw new ApiError(502, "codex_delivery_unconfirmed");
              await pause(Math.min(pollMs, left));
            }
          }
        } else if (options.submitDesktop) await options.submitDesktop(title, text);
        else await (options.injectClaude ?? injectClaudeInbox)(runtime.inbox, text);
      } catch (error) {
        if (error instanceof ApiError) {
          abandonEarly();
          throw error;
        }
        const reason = error instanceof Error ? error.message : "";
        if (reason === "busy") {
          abandonEarly();
          throw new ApiError(409, "not_idle");
        }
        if (reason === "draft") {
          abandonEarly();
          throw new ApiError(409, "desktop_draft");
        }
        // The app's list does not show the session (an old one, say). Nobody at a phone can go and click it open
        // there, so MirrorMix runs it itself; only desktop-only mode, which never starts a CLI, gives up.
        if (reason === "missing" && options.desktopOnly) {
          abandonEarly();
          throw new ApiError(502, tool === "codex" ? "codex_unavailable" : "desktop_unavailable");
        }
        if (reason === "missing" && tool === "claude" && runtime.inbox === VIA_WINDOW) {
          try {
            await takeOver(runtime, text, "desktop_unavailable");
          } catch (fallbackError) {
            abandonEarly();
            throw fallbackError;
          }
        } else if (reason === "missing" && tool === "claude") {
          throw new ApiError(502, "desktop_unavailable");
        } else if (tool === "codex") {
          // The Codex app is closed, the thread is not in it, or the screen is locked: the message goes to a Codex
          // that MirrorMix runs on the same thread instead. Desktop-only mode starts no Codex of its own.
          if (options.desktopOnly) {
            abandonEarly();
            throw new ApiError(502, reason === "locked" ? "codex_locked" : reason === "missing" ? "codex_unavailable" : "codex_failed");
          }
          // While the screen is locked Codex's background service takes it without a terminal of its own.
          let queued = false;
          if (reason === "locked" && options.queueCodex) {
            try {
              await options.queueCodex(runtime.id, runtime.cwd, text);
              queued = true;
            } catch (error) {
              console.warn(`[codex] could not queue while the screen is locked: ${error instanceof Error ? error.message : "failed"}`);
            }
          }
          if (!queued) {
            if (desktopHistory || inTurn) {
              abandonEarly();
              throw new ApiError(502, reason === "locked" ? "codex_locked" : reason === "missing" ? "codex_unavailable" : "codex_failed");
            }
            try {
              await takeOver(runtime, text, reason === "locked" ? "codex_locked" : "codex_failed");
            } catch (fallbackError) {
              abandonEarly();
              throw fallbackError;
            }
          }
        } else if (reason === "locked") {
          // The screen is locked, so the window cannot take the text. A process that is already running still
          // accepts it on its own pipe, which does not need the desktop.
          const pipe = usableInbox(runtime.inbox) ?? externalInbox(tool, id);
          if (pipe) {
            try {
              await (options.injectClaude ?? injectClaudeInbox)(pipe, text);
            } catch {
              try {
                await takeOver(runtime, text, "desktop_locked");
              } catch (fallbackError) {
                abandonEarly();
                throw fallbackError;
              }
            }
          } else {
            try {
              await takeOver(runtime, text, "desktop_locked");
            } catch (fallbackError) {
              abandonEarly();
              throw fallbackError;
            }
          }
        }
        // The window took the words but would not send them (no Send button showed, say). A Claude Code that is
        // running for the session still takes the message on its own pipe, as when the screen is locked; only
        // without one does the session run here, or the error reach the page.
        else {
          const pipe = tool === "claude" ? usableInbox(runtime.inbox) ?? externalInbox(tool, id) : null;
          let delivered = false;
          if (pipe) {
            try {
              await (options.injectClaude ?? injectClaudeInbox)(pipe, text);
              delivered = true;
            } catch (error) {
              console.warn(`[claude] the window and the pipe both refused the message: ${error instanceof Error ? error.message : "failed"}`);
            }
          }
          if (!delivered) {
            if (runtime.inbox === VIA_WINDOW) {
              try {
                await takeOver(runtime, text, "inbox_failed");
              } catch (fallbackError) {
                abandonEarly();
                throw fallbackError;
              }
            } else {
              abandonEarly();
              throw new ApiError(502, "inbox_failed");
            }
          }
        }
      } finally {
        runtime.codexSending = false;
        if (tool === "codex") emit(tool, id);
      }
    } else if (runtime.pty) {
      // The Codex terminal stops reading keystrokes while the screen is locked. The daemon still accepts a queued message.
      if (runtime.tool === "codex" && (await screenLocked())) {
        if (!options.queueCodex) throw new ApiError(502, "codex_locked");
        try {
          await options.queueCodex(runtime.id, runtime.cwd, text);
        } catch (error) {
          const reason = error instanceof Error ? error.message : "failed";
          console.warn(`[codex] could not queue while the screen is locked: ${reason}`);
          throw new ApiError(502, "codex_locked");
        }
      } else if (tool === "codex") {
        const terminal = runtime.pty;
        terminal.write(`\u001b[200~${text}\u001b[201~`);
        // Codex treats a fast text+Enter burst as pasted input. End the bracketed paste first,
        // then submit a separate key event once its input loop has consumed the text.
        await new Promise((resolve) => setTimeout(resolve, 200));
        if (runtime.pty !== terminal || runtime.status !== "running") throw new ApiError(409, "not_idle");
        terminal.write("\r");
      } else {
        runtime.pty.write(`${text}\r`);
      }
    } else {
      throw new ApiError(409, "not_idle");
    }
    if (!shownEarly) remember();
    emit(tool, id);
  };

  const desktopMayCreate = async () => {
    try {
      return Boolean(await (options.desktopCanCreate?.() ?? true));
    } catch {
      return false;
    }
  };

  /**
   * Sends the first message of a new Claude session. The desktop app is asked first, so the session shows in its
   * list; the session file it writes is then found by that message and followed like any other desktop session.
   * When the app cannot take it, MirrorMix's own Claude Code starts the session under the id it already has.
   */
  const startDraft = async (runtime: Runtime, text: string) => {
    runtime.draft = false;
    const draftId = runtime.id;
    const before = new Set(filesFor("claude"));
    let reason = "";
    try {
      await options.createDesktop!(runtime.cwd, text);
    } catch (error) {
      reason = error instanceof Error ? error.message : "failed";
    }
    if (!reason) {
      runtime.binding = true;
      runtime.inbox = VIA_WINDOW;
      const startedAt = Date.now();
      const timer = setInterval(() => {
        if (!runtime.binding) {
          clearInterval(timer);
          timers.delete(timer);
          return;
        }
        const appeared = filesFor("claude").filter((file) => !before.has(file));
        const stored = appeared.length
          ? indexSessions(options.roots).claude.find(
              (session) =>
                appeared.includes(session.filePath) &&
                samePath(session.cwd, runtime.cwd) &&
                session.messages.some((message) => message.role === "user" && sameWords(message.text) === sameWords(text)),
            )
          : undefined;
        if (!stored) {
          if (Date.now() - startedAt > DESKTOP_BIND_MS) {
            clearInterval(timer);
            timers.delete(timer);
            runtime.binding = false;
            runtime.inbox = undefined;
            runtime.status = "exited";
            runtime.exitNote = "消息已经交给 Claude 桌面版，但没有找到它新建的会话。请在桌面版里查看。";
            emit("claude", draftId);
          }
          return;
        }
        clearInterval(timer);
        timers.delete(timer);
        runtime.binding = false;
        runtime.id = stored.id;
        runtime.filePath = stored.filePath;
        runtime.resume = stored.id;
        if (stored.title) runtime.title = stored.title;
        rememberMade("claude", stored.id);
        runtimes.set(keyOf("claude", stored.id), runtime);
        // The draft's id stays a second name for the same session, so a page still using it follows along.
        runtimes.set(keyOf("claude", draftId), runtime);
        emit("claude", draftId);
        emit("claude", stored.id);
      }, pollMs);
      timers.add(timer);
      return;
    }
    console.warn(`[claude] new session not started in the desktop app (${reason}); starting it here instead`);
    let pty: PtyLike;
    try {
      pty = launch("claude", runtime.cwd, undefined, draftId);
    } catch {
      throw new ApiError(502, "create_failed");
    }
    runtime.filePath = path.join(options.roots.claudeProjectsDir, encodeClaudeProject(runtime.cwd), `${draftId}.jsonl`);
    runtime.resume = draftId;
    attach(runtime, pty);
    const started = Date.now();
    let seen = 0;
    let quietSince = Date.now();
    for (;;) {
      if (!runtime.pty) throw new ApiError(502, "create_failed");
      // A folder Claude Code has not run in asks to be trusted first. The page shows that question; the message
      // stays in the box to be sent again once it is answered.
      if (asksForTrust(runtime.mirror.lines())) throw new ApiError(409, "trust_first");
      const length = runtime.buffer.length;
      if (length !== seen) {
        seen = length;
        quietSince = Date.now();
      }
      const ready = seen > 0 && (/for shortcuts/i.test(runtime.buffer) || Date.now() - quietSince >= TAKEOVER_QUIET_MS);
      if (ready && runtime.mirror.allowsInput()) break;
      if (Date.now() - started > TAKEOVER_READY_MS) throw new ApiError(504, "create_failed");
      await pause(150);
    }
    runtime.pty.write(`${text}\r`);
  };

  /**
   * Resumes a desktop-app session in MirrorMix's own Claude Code (or Codex) and types the message there.
   * The conversation file is the same one, so this page keeps showing it; the desktop app shows the new turns
   * only once the session is opened there again.
   */
  const takeOver = async (runtime: Runtime, text: string, failure: string) => {
    const claudePromptAtLaunch = runtime.tool === "claude" && failure === "desktop_locked";
    let pty: PtyLike;
    try {
      pty = launch(runtime.tool === "codex" ? "codex" : "claude", runtime.cwd, runtime.id, undefined, claudePromptAtLaunch ? text : undefined);
    } catch {
      throw new ApiError(502, failure);
    }
    runtime.inbox = undefined;
    runtime.takenOver = true;
    runtime.resume = runtime.id;
    runtime.buffer = "";
    runtime.mirror = createScreenMirror();
    runtime.status = "running";
    attach(runtime, pty);
    // A lockscreen Claude takeover receives its prompt at launch, avoiding an unprompted desktop-session resume.
    if (claudePromptAtLaunch) return;
    const started = Date.now();
    let seen = 0;
    let quietSince = Date.now();
    for (;;) {
      if (!runtime.pty) {
        runtime.takenOver = false;
        throw new ApiError(502, failure);
      }
      const length = runtime.buffer.length;
      if (length !== seen) {
        seen = length;
        quietSince = Date.now();
      }
      const ready = seen > 0 && (/for shortcuts|send\s+.*newline/i.test(runtime.buffer) || Date.now() - quietSince >= TAKEOVER_QUIET_MS);
      if (ready && runtime.mirror.allowsInput()) break;
      if (Date.now() - started > TAKEOVER_READY_MS) {
        runtime.pty.kill();
        runtime.takenOver = false;
        throw new ApiError(504, failure);
      }
      await pause(150);
    }
    if (runtime.tool === "codex") {
      // Codex takes the text as a bracketed paste, then Enter on its own once it has read the paste.
      const terminal = runtime.pty;
      terminal.write(`\u001b[200~${text}\u001b[201~`);
      await pause(200);
      if (runtime.pty === terminal) terminal.write("\r");
    } else {
      runtime.pty.write(`${text}\r`);
    }
  };

  const interrupt = async (tool: ToolId, id: string) => {
    const runtime = runtimeFor(tool, id);
    if (!runtime) throw new ApiError(404, "unknown_session");
    // A reply run by Cursor's command-line agent for this page is a process of ours.
    // A DeepSeek reply running in the app is stopped there, as its own Stop button does.
    if (tool === "deepseek" && !(runtime.takenOver && runtime.stop) && options.deepseekApp?.available()) {
      try {
        await options.deepseekApp.cancel(runtime.id);
      } catch {
        throw new ApiError(502, "stop_failed");
      }
      runtime.echo = undefined;
      runtime.pendingTurn = false;
      emit(tool, id);
      return;
    }
    if ((tool === "cursor" || tool === "deepseek") && runtime.takenOver && runtime.stop) {
      runtime.stop();
      runtime.stop = undefined;
      runtime.echo = undefined;
      runtime.pendingTurn = false;
      emit(tool, id);
      return;
    }
    // MirrorMix's own Claude Code or Codex terminal: Esc stops the reply in both.
    if (runtime.pty) {
      runtime.pty.write("\u001b");
      if (tool === "codex") {
        runtime.echo = undefined;
        runtime.pendingTurn = false;
      }
      emit(tool, id);
      return;
    }
    if (runtime.inbox && (tool === "claude" || tool === "codex")) {
      if (tool === "codex" ? !options.stopCodex : !options.stopDesktop) throw new ApiError(409, "stop_unsupported");
      const title =
        (tool === "claude" ? options.desktopSession?.(id)?.title : options.codexDesktopSession?.(id)?.title) ||
        (runtime.filePath ? readSession(runtime.tool, runtime.filePath, options.roots.cursorStateDb)?.title : "") ||
        runtime.title;
      try {
        if (tool === "codex") await options.stopCodex!(title, runtime.id);
        else await options.stopDesktop!(title);
      } catch (error) {
        const reason = error instanceof Error ? error.message : "";
        if (tool === "codex" && !runtime.codexSending && (reason === "idle" || reason === "missing") &&
          !viewOf(runtime).messages.some((message) => message.role === "turn" && !message.endedAt)) {
          runtime.echo = undefined;
          runtime.pendingTurn = false;
          runtime.queued = undefined;
          emit(tool, id);
          return;
        }
        if (reason === "idle") throw new ApiError(409, "not_running");
        if (reason === "locked") throw new ApiError(502, "desktop_locked");
        if (reason === "missing") throw new ApiError(502, "desktop_missing");
        throw new ApiError(502, "stop_failed");
      }
      emit(tool, id);
      return;
    }
    throw new ApiError(409, "stop_unsupported");
  };

  const sendNow = async (tool: ToolId, id: string, text: string) => {
    if (tool !== "cursor" || !text.trim() || text.length > MAX_TEXT) throw new ApiError(400, "bad_request");
    const runtime = runtimeFor(tool, id);
    if (!runtime) throw new ApiError(404, "unknown_session");
    if (!options.submitCursorNow) throw new ApiError(500, "failed");
    const title = (runtime.filePath ? readSession(runtime.tool, runtime.filePath, options.roots.cursorStateDb)?.title : "") || runtime.title;
    try {
      await options.submitCursorNow(title, text);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "";
      if (reason === "missing") throw new ApiError(502, "cursor_unavailable");
      if (reason === "minimized") throw new ApiError(502, "cursor_minimized");
      throw new ApiError(502, "queue_send");
    }
    emit(tool, id);
  };

  const listeners = new Map<string, Set<(view: SessionView) => void>>();

  const emit = (tool: ToolId, id: string) => {
    const group = listeners.get(keyOf(tool, id));
    if (!group?.size) return;
    let view: SessionView;
    try {
      view = getSession(tool, id);
    } catch {
      return;
    }
    for (const listener of group) listener(view);
  };

  const subscribe = (tool: ToolId, id: string, listener: (view: SessionView) => void) => {
    const key = keyOf(tool, id);
    const group = listeners.get(key) ?? new Set();
    group.add(listener);
    listeners.set(key, group);
    const timer = setInterval(() => emit(tool, id), 200);
    timers.add(timer);
    try {
      listener(getSession(tool, id));
    } catch {
      listener({
        id,
        tool,
        title: "",
        workspacePath: "",
        status: "failed",
        sendEnabled: false,
        attached: "process",
        messages: [],
      });
    }
    return () => {
      clearInterval(timer);
      timers.delete(timer);
      group.delete(listener);
    };
  };

  const connectTerminal = (tool: ToolId, id: string, socket: TerminalSocket) => {
    const runtime = runtimeFor(tool, id);
    if (!runtime || runtime.status !== "running" || !runtime.pty) {
      socket.send("");
      return;
    }
    runtime.sockets.add(socket);
    if (runtime.buffer) socket.send(runtime.buffer);
    socket.onMessage((data) => {
      if (!runtime.pty) return;
      const resize = readResize(data);
      if (resize) {
        runtime.pty.resize(resize.cols, resize.rows);
        runtime.mirror.resize(resize.cols, resize.rows);
        return;
      }
      runtime.pty.write(data);
    });
    socket.onClose(() => runtime.sockets.delete(socket));
  };

  const getSession = (tool: ToolId, id: string): SessionView => {
    const runtime = runtimeFor(tool, id);
    if (runtime) return viewOf(runtime);
    const stored = findStored(tool, id);
    if (!stored) throw new ApiError(404, "unknown_session");
    // Cursor and DeepSeek replies run as separate processes per message; none of them holds the session.
    const occupied = tool !== "cursor" && tool !== "deepseek" && isOccupied(id, options.listProcesses(), ownedPids());
    const readOnlyReason = tool === "deepseek"
      ? (stored.agentPreset && !options.deepseekApp?.available() ? "deepseek_app_session" : undefined)
      : options.desktopOnly && tool !== "cursor" && !desktopRow(tool, id)
        ? (tool === "codex" ? "codex_history_only" : "claude_history_only") : undefined;
    return {
      id,
      tool,
      title: stored.title,
      workspacePath: stored.cwd,
      status: occupied ? "occupied" : "idle",
      sendEnabled: false,
      ...(readOnlyReason ? { readOnlyReason } : {}),
      attached: "process",
      ...modelOf(tool, id, stored),
      ...(madeHere(tool, id) ? { deletable: true } : {}),
      messages: stored.messages,
    };
  };

  /**
   * Deletes a session from the page. Files only MirrorMix and the command line use go to the Recycle Bin. A session an
   * app keeps (the Claude or Codex desktop app, Cursor) is only taken off this list: its files are that app's data,
   * and deleting them underneath it would break the app's own list.
   */
  const remove = async (tool: ToolId, id: string): Promise<{ removed: "trash" | "hidden" }> => {
    const runtime = runtimeFor(tool, id);
    // Only a reply under way stops it: its work would be lost. A process MirrorMix merely holds open for the
    // session (it opens one for any session looked at) is closed here first.
    const replying =
      runtime &&
      (runtime.pendingTurn ||
        runtime.stop ||
        (runtime.pty && runtime.status === "running" && viewOf(runtime).messages.some((message) => message.role === "turn" && !message.endedAt)));
    if (replying) throw new ApiError(409, "session_running");
    const stored = findStored(tool, id);
    if (!stored && !runtime) throw new ApiError(404, "unknown_session");
    // A session the tool made itself belongs to the tool: only what the page created can be deleted from it.
    if (!madeHere(tool, runtime?.id ?? id)) throw new ApiError(403, "not_made_here");
    const closing = runtime?.pty ?? null;
    if (runtime && closing) {
      closing.kill();
      if (runtime.status === "running" || runtime.status === "starting") runtime.status = "exited";
      // Let it go before its files are moved: Windows will not move a file a process still has open.
      for (let waited = 0; waited < 2_000 && runtime.pty === closing; waited += 100) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // The process just closed may still be on the process list for a moment; it is ours, not another program's.
    const ours = closing ? [...ownedPids(), closing.pid] : ownedPids();
    if (tool !== "cursor" && tool !== "deepseek" && isOccupied(id, options.listProcesses(), ours)) throw new ApiError(409, "occupied");
    const forget = () => {
      for (const [key, held] of runtimes) if (held === runtime || key === keyOf(tool, id)) runtimes.delete(key);
      emit(tool, id);
    };
    const appOwned =
      tool === "cursor" ||
      tool === "deepseek" ||
      (tool === "claude" && Boolean(options.desktopSession?.(id))) ||
      (tool === "codex" && Boolean(options.codexDesktopSession?.(id)));
    if (appOwned || !stored?.filePath || isCodexHistoryReference(stored.filePath) || !options.trash) {
      if (!options.hidden) throw new ApiError(500, "delete_failed");
      options.hidden.add(tool, id);
      forget();
      return { removed: "hidden" };
    }
    const paths = [stored.filePath];
    // Claude Code keeps a session's subagent transcripts and large tool results in a folder named after it.
    if (tool === "claude") {
      const folder = path.join(path.dirname(stored.filePath), id);
      if (existsSync(folder)) paths.push(folder);
    }
    try {
      await options.trash(paths);
    } catch (error) {
      console.warn(`[delete] could not move ${tool} session ${id} to the Recycle Bin: ${error instanceof Error ? error.message : error}`);
      throw new ApiError(500, "delete_failed");
    }
    forget();
    return { removed: "trash" };
  };

  return {
    remove,
    todayStats: () => {
      const today = indexSessions(options.roots);
      const now = Date.now();
      const since = startOfToday(now);
      return countToday({
        ...today,
        codex: today.codex.map((session) => isCodexHistoryReference(session.filePath) && Date.parse(session.updatedAt) >= since
          ? readSession("codex", session.filePath) ?? session : session),
        cursor: today.cursor.map((session) => readSession("cursor", session.filePath, options.roots.cursorStateDb) ?? session),
      }, now);
    },
    // A new Claude session can still start in the desktop app without the CLI; a new Codex one cannot.
    capabilities: () => ({
      create: {
        claude: !options.desktopOnly && (hasCli("claude") || Boolean(options.createDesktop)),
        codex: !options.desktopOnly && hasCli("codex"),
        cursor: Boolean(options.createCursorChat),
        deepseek: Boolean(options.startDeepseek),
      },
    }),
    catalog,
    schedules: () => readSchedules(options.roots),
    getSession,
    open,
    create,
    close,
    send,
    sendNow,
    interrupt,
    answer,
    answerPrompt,
    connectTerminal,
    subscribe,
    dispose() {
      for (const timer of timers) {
        clearInterval(timer);
        clearTimeout(timer);
      }
      timers.clear();
      for (const runtime of runtimes.values()) {
        runtime.pty?.kill();
        runtime.stop?.();
      }
      options.disposeExtra?.();
    },
  };
}

function readResize(data: string): { cols: number; rows: number } | null {
  if (!data.startsWith("{")) return null;
  try {
    const value = JSON.parse(data) as { type?: string; cols?: unknown; rows?: unknown };
    if (value.type === "resize" && Number.isInteger(value.cols) && Number.isInteger(value.rows)) {
      return { cols: value.cols as number, rows: value.rows as number };
    }
  } catch {
    return null;
  }
  return null;
}

export function sessionFileDir(tool: ToolId, cwd: string, roots: CatalogRoots): string {
  return tool === "claude"
    ? path.join(roots.claudeProjectsDir, encodeClaudeProject(cwd))
    : roots.codexSessionsDir;
}
