import { randomUUID } from "node:crypto";

/**
 * The command lines opened from the page, kept on this side so they outlive the page that opened them.
 * Switching to another session, closing the panel or losing the connection only detaches the screen;
 * the cmd.exe keeps running and its recent output is replayed to whoever attaches next.
 */

export interface ShellProcess {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(callback: (data: string) => void): void;
  onExit(callback: () => void): void;
}

export interface TerminalInfo {
  tid: string;
  /** "1", "2"…: the order it was opened in within its project. */
  label: string;
  createdAt: string;
}

export interface TerminalSink {
  send(data: string): void;
  close(): void;
}

interface Entry {
  info: TerminalInfo;
  shell: ShellProcess;
  /** The tail of what it printed, replayed on attach. */
  backlog: string;
  sinks: Set<TerminalSink>;
  pending: string;
  flush: NodeJS.Timeout | null;
}

/** Replay this much. A screen of output is a few kilobytes; this keeps several screens of scrollback. */
const BACKLOG_CHARS = 200_000;
/** Output is gathered this long before it goes out, so a burst becomes one frame instead of hundreds. */
const FLUSH_MS = 8;
export const MAX_PER_PROJECT = 8;

/** Device-attribute inquiries are one-time handshakes, not display state to repeat on reconnect. */
export function replayTerminalOutput(data: string): string {
  return data.replace(/\x1b\[[?>=]?[0-9;]*c/g, "");
}

export class TerminalError extends Error {
  constructor(readonly code: "too_many" | "unknown_terminal" | "failed") {
    super(code);
  }
}

export function createTerminalHub(open: (cwd: string, cols: number, rows: number) => ShellProcess) {
  const projects = new Map<string, Entry[]>();

  const listOf = (key: string) => projects.get(key) ?? [];

  const remove = (key: string, entry: Entry) => {
    const left = listOf(key).filter((item) => item !== entry);
    if (left.length) projects.set(key, left);
    else projects.delete(key);
    if (entry.flush) clearTimeout(entry.flush);
    for (const sink of entry.sinks) sink.close();
    entry.sinks.clear();
  };

  const list = (key: string): TerminalInfo[] => listOf(key).map((entry) => entry.info);

  const create = (key: string, cwd: string): TerminalInfo => {
    const current = listOf(key);
    if (current.length >= MAX_PER_PROJECT) throw new TerminalError("too_many");
    let shell: ShellProcess;
    try {
      shell = open(cwd, 80, 24);
    } catch {
      throw new TerminalError("failed");
    }
    const used = new Set(current.map((entry) => entry.info.label));
    let number = 1;
    while (used.has(String(number))) number += 1;
    const entry: Entry = {
      info: { tid: `t${randomUUID()}`, label: String(number), createdAt: new Date().toISOString() },
      shell,
      backlog: "",
      sinks: new Set(),
      pending: "",
      flush: null,
    };
    shell.onData((data) => {
      entry.backlog = (entry.backlog + data).slice(-BACKLOG_CHARS);
      if (!entry.sinks.size) return;
      entry.pending += data;
      entry.flush ??= setTimeout(() => {
        entry.flush = null;
        const chunk = entry.pending;
        entry.pending = "";
        for (const sink of entry.sinks) sink.send(chunk);
      }, FLUSH_MS);
    });
    shell.onExit(() => remove(key, entry));
    projects.set(key, [...current, entry]);
    return entry.info;
  };

  const find = (key: string, tid: string) => listOf(key).find((entry) => entry.info.tid === tid);

  const close = (key: string, tid: string) => {
    const entry = find(key, tid);
    if (!entry) throw new TerminalError("unknown_terminal");
    remove(key, entry);
    try {
      entry.shell.kill();
    } catch {
      /* already gone */
    }
  };

  /** Connects a screen. What it missed comes first, then everything live. Returns null for a terminal that is gone. */
  const attach = (key: string, tid: string, sink: TerminalSink) => {
    const entry = find(key, tid);
    if (!entry) return null;
    // Drain to existing viewers first. A new viewer's replay already contains this pending output.
    if (entry.flush) { clearTimeout(entry.flush); entry.flush = null; }
    if (entry.pending) {
      const chunk = entry.pending;
      entry.pending = "";
      for (const current of entry.sinks) current.send(chunk);
    }
    if (entry.backlog) sink.send(replayTerminalOutput(entry.backlog));
    entry.sinks.add(sink);
    return {
      write(data: string) {
        entry.shell.write(data);
      },
      resize(cols: number, rows: number) {
        try {
          entry.shell.resize(cols, rows);
        } catch {
          /* exited in between */
        }
      },
      detach() {
        entry.sinks.delete(sink);
      },
    };
  };

  const dispose = () => {
    for (const [key, entries] of [...projects]) {
      for (const entry of entries) {
        remove(key, entry);
        try {
          entry.shell.kill();
        } catch {
          /* already gone */
        }
      }
    }
  };

  const ensure = (key: string, cwd: string) => listOf(key)[0]?.info ?? create(key, cwd);
  return { list, create, ensure, close, attach, dispose };
}

export type TerminalHub = ReturnType<typeof createTerminalHub>;
