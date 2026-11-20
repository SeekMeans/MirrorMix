import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ToolQuota } from "../catalog/quotas";
import type { CursorAgentBins } from "./cursorAgent";

/**
 * Cursor's monthly usage, as the Cursor agent CLI shows it in its `/usage` panel:
 *
 *   Usage • Pro                    Resets 11月19日
 *   Included   92% used ████████████░░
 *     Auto    100% used
 *     API      11% used
 *   On-Demand  Disabled
 *
 * The CLI fetches it with its own login, so MirrorMix never handles the credential. It is opened in a hidden
 * terminal in a folder of its own, asked for /usage, read, and closed again.
 */
export interface CursorUsage {
  plan: string;
  /** Share of the plan's included usage spent this month, 0–100. */
  percent: number | null;
  auto: number | null;
  api: number | null;
  /** The reset date as the CLI words it ("11月19日", "Nov 19"); empty when it says "Current period". */
  reset: string;
  onDemand: string;
  /** When it was read (ms). */
  at: number;
}

export interface UsageTerminal {
  write(data: string): void;
  kill(): void;
  onData(callback: (data: string) => void): void;
  onExit(callback: () => void): void;
}

export type SpawnUsageTerminal = (file: string, args: string[], cwd: string) => UsageTerminal;

/** Escape sequences out; what is left is the text the panel drew, in the order it was drawn. */
export function stripTerminal(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // Colours change nothing in the text; a step right is a gap; any other move starts somewhere else.
    .replace(/\x1b\[[0-9;?]*m/g, "")
    .replace(/\x1b\[[0-9]*C/g, " ")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "\n")
    .replace(/\x1b[()][A-Za-z0-9]/g, "")
    .replace(/\x1b[=>78]/g, "");
}

function lastMatch(text: string, pattern: RegExp): RegExpMatchArray | null {
  let last: RegExpMatchArray | null = null;
  for (const match of text.matchAll(pattern)) last = match;
  return last;
}

function share(text: string, label: string): number | null {
  const found = lastMatch(text, new RegExp(`${label}[\\s\\n]*(\\d+(?:\\.\\d+)?)%[\\s\\n]*used`, "g"));
  return found ? Number(found[1]) : null;
}

/** The panel's numbers from what the terminal printed. Null until the panel has been drawn. */
export function parseCursorUsage(screen: string): Omit<CursorUsage, "at"> | null {
  const text = stripTerminal(screen);
  const percent = share(text, "Included");
  if (percent == null) return null;
  const head = lastMatch(text, /Usage[\s\n]*•[\s\n]*([^\n]*?)[\s\n]*(?:Resets[ \t]*([^\n█░]*?)[ \t]*(?:\n|$)|Current period)/g);
  const onDemand = lastMatch(text, /On-Demand[ \t\n]*([A-Za-z$][^\n█░—]*?)[ \t]*(?:[—█░]|\n|$)/g);
  return {
    plan: head?.[1]?.trim() ?? "",
    percent,
    auto: share(text, "Auto"),
    api: share(text, "API"),
    reset: head?.[2]?.trim() ?? "",
    onDemand: onDemand?.[1]?.trim() ?? "",
  };
}

/** How the limit reads in the tool bar, like Claude's: the month's share, the plan and reset date on hover. */
export function cursorUsageQuota(usage: CursorUsage | null): ToolQuota | null {
  if (!usage || usage.percent == null) return null;
  const percent = Math.max(0, Math.min(100, Math.round(usage.percent)));
  const full = percent >= 100;
  const plan = usage.plan ? `（${usage.plan}）` : "";
  const reset = usage.reset ? `，${usage.reset} 重置` : "";
  const parts = [usage.auto != null ? `Auto ${Math.round(usage.auto)}%` : "", usage.api != null ? `API ${Math.round(usage.api)}%` : ""].filter(Boolean);
  const detail = parts.length ? `（${parts.join("，")}）` : "";
  return {
    label: full ? "本月 已满" : `本月 ${percent}%`,
    title: `Cursor 本月额度${plan}已用 ${percent}%${detail}${reset}`,
    level: full ? "full" : percent >= 80 ? "high" : "ok",
    percent,
    resetLabel: usage.reset ? `${usage.reset}重置` : "",
  };
}

/**
 * Removes the empty chats the CLI leaves behind for the usage folder (`hasConversation: false`), so reading the
 * usage does not pile up chats. Nothing else is touched.
 */
export function removeUsageChats(chatsDir: string, usageDir: string): number {
  if (!existsSync(chatsDir)) return 0;
  let removed = 0;
  const same = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  for (const bucket of readdirSync(chatsDir, { withFileTypes: true })) {
    if (!bucket.isDirectory()) continue;
    const bucketPath = path.join(chatsDir, bucket.name);
    let chats: string[];
    try {
      chats = readdirSync(bucketPath);
    } catch {
      continue;
    }
    let left = chats.length;
    for (const chat of chats) {
      const chatPath = path.join(bucketPath, chat);
      let meta: { cwd?: unknown; hasConversation?: unknown };
      try {
        meta = JSON.parse(readFileSync(path.join(chatPath, "meta.json"), "utf8"));
      } catch {
        continue;
      }
      if (typeof meta.cwd !== "string" || !same(meta.cwd, usageDir) || meta.hasConversation !== false) continue;
      try {
        rmSync(chatPath, { recursive: true, force: true });
        removed += 1;
        left -= 1;
      } catch {
        /* still open: the next read takes it */
      }
    }
    if (left === 0 && removed > 0) {
      try {
        rmSync(bucketPath, { recursive: true, force: true });
      } catch {
        /* not empty after all */
      }
    }
  }
  return removed;
}

const LOGIN_SCREEN = /Press any key to log in|Not logged in/i;

/** Opens the CLI once, asks for /usage and resolves with what it showed. Never presses a key on the login screen. */
export function readCursorUsageOnce(
  bins: CursorAgentBins,
  spawn: SpawnUsageTerminal,
  usageDir: string,
  timing = { settleMs: 2000, minStartMs: 6000, startMs: 15_000, totalMs: 35_000, retryMs: 4000, now: () => Date.now() },
): Promise<{ usage: Omit<CursorUsage, "at"> } | { error: "login" | "timeout" | "unavailable"; message?: string }> {
  mkdirSync(usageDir, { recursive: true });
  return new Promise((resolve) => {
    let term: UsageTerminal;
    try {
      term = spawn(bins.node, [bins.js, "--trust"], usageDir);
    } catch {
      resolve({ error: "timeout" });
      return;
    }
    const started = timing.now();
    let output = "";
    let lastData = started;
    let asked = false;
    let askedAt = 0;
    let presses = 0;
    let done = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const finish = (result: Parameters<typeof resolve>[0]) => {
      if (done) return;
      done = true;
      for (const timer of timers) clearTimeout(timer);
      clearInterval(tick);
      try {
        if (!("error" in result && result.error === "login")) term.write("\x1b");
        term.write("\x03");
      } catch {
        /* already gone */
      }
      timers.push(setTimeout(() => {
        try {
          term.kill();
        } catch {
          /* already gone */
        }
      }, 300));
      resolve(result);
    };
    term.onData((data) => {
      output += data;
      lastData = timing.now();
      const text = stripTerminal(output);
      if (!asked && LOGIN_SCREEN.test(text)) {
        // Any key here would start a browser login. Leave without touching it.
        done = true;
        clearInterval(tick);
        try {
          term.kill();
        } catch {
          /* already gone */
        }
        resolve({ error: "login" });
        return;
      }
      if (asked) {
        const usage = parseCursorUsage(output);
        if (usage) finish({ usage });
        else {
          const unavailable = lastMatch(text, /(Usage details are not available[^\n]*)/g);
          if (unavailable) finish({ error: "unavailable", message: unavailable[1].trim() });
        }
      }
    });
    term.onExit(() => {
      if (!done) finish({ error: "timeout" });
    });
    // Ask once the chat has drawn and gone quiet.
    const tick = setInterval(() => {
      const now = timing.now();
      if (!asked && now - started >= timing.minStartMs && (now - lastData >= timing.settleMs || now - started >= timing.startMs)) {
        if (LOGIN_SCREEN.test(stripTerminal(output))) return;
        asked = true;
        askedAt = now;
        term.write("/usage");
        timers.push(setTimeout(() => {
          if (done) return;
          presses += 1;
          term.write("\r");
        }, 1000));
      }
      // An Enter that came while the CLI was still busy is lost: press it again, a few times at most.
      if (asked && !done && presses > 0 && presses < 4 && now - askedAt >= 1000 + presses * timing.retryMs) {
        presses += 1;
        term.write("\r");
      }
      if (now - started >= timing.totalMs) finish({ error: "timeout" });
    }, 250);
  });
}

export interface CursorUsageReader {
  current(): CursorUsage | null;
  dispose(): void;
}

/**
 * Reads Cursor's monthly usage now and then (it changes slowly) and keeps the last reading on disk, so a restart
 * shows it at once. A missing login is reported once in the log and retried at the normal pace.
 */
export function createCursorUsageReader(options: {
  bins: CursorAgentBins;
  spawn: SpawnUsageTerminal;
  usageDir: string;
  chatsDir: string;
  cacheFile: string;
  intervalMs?: number;
  firstDelayMs?: number;
}): CursorUsageReader {
  let usage: CursorUsage | null = null;
  try {
    const saved = JSON.parse(readFileSync(options.cacheFile, "utf8")) as CursorUsage;
    if (saved && typeof saved.at === "number" && (saved.percent == null || typeof saved.percent === "number")) usage = saved;
  } catch {
    usage = null;
  }
  let running = false;
  let lastProblem = "";
  const read = async () => {
    if (running) return;
    running = true;
    try {
      const result = await readCursorUsageOnce(options.bins, options.spawn, options.usageDir);
      if ("usage" in result) {
        usage = { ...result.usage, at: Date.now() };
        lastProblem = "";
        try {
          mkdirSync(path.dirname(options.cacheFile), { recursive: true });
          const temp = `${options.cacheFile}.${process.pid}.tmp`;
          writeFileSync(temp, JSON.stringify(usage));
          renameSync(temp, options.cacheFile);
        } catch {
          /* shown from memory until the next read */
        }
      } else if (result.error !== lastProblem) {
        lastProblem = result.error;
        const why =
          result.error === "login"
            ? "the Cursor CLI is not logged in (run `agent login` once)"
            : result.error === "unavailable"
              ? result.message ?? "usage is not available for this plan"
              : "the Cursor CLI did not show its usage in time";
        console.warn(`[cursor] monthly usage not read: ${why}`);
      }
    } finally {
      // Give the CLI a moment to write its chat, then take it away again.
      setTimeout(() => {
        try {
          removeUsageChats(options.chatsDir, options.usageDir);
        } catch {
          /* tried again next time */
        }
      }, 1500);
      running = false;
    }
  };
  const first = setTimeout(() => void read(), options.firstDelayMs ?? 8_000);
  const timer = setInterval(() => void read(), options.intervalMs ?? 15 * 60_000);
  first.unref?.();
  timer.unref?.();
  return {
    current: () => usage,
    dispose() {
      clearTimeout(first);
      clearInterval(timer);
    },
  };
}
