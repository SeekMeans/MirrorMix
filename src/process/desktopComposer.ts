import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendFileSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import os from "node:os";
import type { TranscriptMessage } from "../shared/types";
import { readDesktopUsageCache, saveDesktopUsageCache, type DesktopUsage } from "../catalog/claudeDesktopUsage";
export type { DesktopUsage } from "../catalog/claudeDesktopUsage";

const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "desktopComposer.ps1");

export function appendDesktopStream(messages: TranscriptMessage[], live: string): TranscriptMessage[] {
  const text = live.trim();
  if (!text) return messages;
  const last = messages.at(-1);
  if (last?.role === "assistant" && (text === last.text || last.text.startsWith(text))) return messages;
  if (last?.role === "assistant" && text.startsWith(last.text)) {
    return [...messages.slice(0, -1), { ...last, id: "c-stream", text }];
  }
  return [...messages, { id: "c-stream", role: "assistant", text }];
}

/** A question read off an app window: its texts and the names of its answer buttons. */
export interface WindowPrompt {
  title: string;
  detail: string;
  buttons: string[];
}

export function parseWindowPrompt(raw: string): WindowPrompt | null {
  if (!raw.trim()) return null;
  try {
    const value = JSON.parse(raw) as { title?: unknown; detail?: unknown; buttons?: unknown };
    const buttons = (Array.isArray(value.buttons) ? value.buttons : [value.buttons]).filter((item): item is string => typeof item === "string" && Boolean(item));
    if (buttons.length < 2) return null;
    return { title: typeof value.title === "string" ? value.title : "", detail: typeof value.detail === "string" ? value.detail : "", buttons };
  } catch {
    return null;
  }
}

interface ComposerResponse {
  ok?: boolean;
  error?: string;
  text?: string;
}

export function createDesktopComposer(tool: "claude" | "codex" = "claude", usageCacheFile?: string) {
  let child: ChildProcessWithoutNullStreams | null = null;
  let chain: Promise<void> = Promise.resolve();
  let refreshing = false;
  /** The app's usage meter, read now and then: it changes slowly and reading it walks the whole window. */
  let meter: DesktopUsage & { at: number } = { ...readDesktopUsageCache(usageCacheFile), at: 0 };
  let meterReading = false;
  /** Sends waiting their turn. Reading the streaming reply waits while there are any, so a send never queues behind reads. */
  let sending = 0;
  let nextId = 1;
  const cache = new Map<string, { text: string; at: number }>();
  /** The question each session's conversation was last seen asking in the window, by title. */
  const prompts = new Map<string, { prompt: WindowPrompt | null; at: number }>();
  let promptReading = false;
  // Answers are matched to requests by id. Matching by order would hand a late answer to the next request,
  // and from then on every reading of the window would be one step behind.
  const waiters = new Map<string, { owner: ChildProcessWithoutNullStreams; settle: (response: ComposerResponse) => void }>();

  /** Fails the requests that were handed to one helper. A replaced helper exiting late must not fail its successor's. */
  const failThoseOf = (owner: ChildProcessWithoutNullStreams) => {
    for (const [id, waiter] of [...waiters]) {
      if (waiter.owner !== owner) continue;
      waiters.delete(id);
      waiter.settle({ ok: false, error: "failed" });
    }
  };

  const ensure = () => {
    if (child && child.exitCode === null) return;
    const started = spawn("powershell.exe", ["-NoProfile", "-NoLogo", "-File", scriptPath, "-Tool", tool], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child = started;
    const lines = createInterface({ input: started.stdout });
    lines.on("line", (line) => {
      let response: ComposerResponse & { id?: string };
      try {
        response = JSON.parse(line) as ComposerResponse & { id?: string };
      } catch {
        return;
      }
      const waiter = response.id ? waiters.get(response.id) : undefined;
      if (!waiter || !response.id) return;
      waiters.delete(response.id);
      waiter.settle(response);
    });
    started.on("exit", () => {
      if (child === started) child = null;
      failThoseOf(started);
    });
  };

  const request = (op: "send" | "stream" | "usage" | "create" | "stop" | "prompt" | "answer" | "dump", title: string, text = "", threadId = "", replace = false) => {
    const run = chain.then(
      () =>
        new Promise<ComposerResponse>((resolve, reject) => {
          ensure();
          const target = child;
          if (!target) {
            reject(new Error("failed"));
            return;
          }
          const id = String(nextId++);
          // Reading the window is quick; a read that takes this long means the helper is stuck on the window.
          // It is replaced so the next request does not queue up behind it.
          const timer = setTimeout(
            () => {
              waiters.delete(id);
              if (child === target) child = null;
              target.kill();
              resolve({ ok: false, error: "failed" });
            },
            // A send can wait on the window several times (picking the session, the Send button); the script gives up
            // on its own well before this and takes its words back out of the box.
            op === "send" || op === "create" || op === "stop" || op === "answer" ? 30_000 : 8_000,
          );
          waiters.set(id, {
            owner: target,
            settle: (response) => {
              clearTimeout(timer);
              resolve(response);
            },
          });
          target.stdin.write(
            `${JSON.stringify({
              id,
              op,
              ...(threadId ? { threadId } : {}),
              ...(replace ? { replace: true } : {}),
              title: Buffer.from(title, "utf8").toString("base64"),
              text: Buffer.from(text, "utf8").toString("base64"),
            })}\n`,
          );
        }),
      () => Promise.reject(new Error("failed")),
    );
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  return {
    /** Starts a session in the app for a folder it already lists, with `text` as its first message. */
    async create(folder: string, text: string) {
      sending += 1;
      let response: ComposerResponse;
      try {
        response = await request("create", folder, text);
      } finally {
        sending -= 1;
      }
      if (response.ok) return;
      const detail = response.text ? Buffer.from(response.text, "base64").toString("utf8") : "";
      console.warn(`[${tool} window] could not start a session in "${folder}": ${response.error || "failed"}${detail ? ` (${detail})` : ""}`);
      throw new Error(response.error || "failed");
    },
    /** `replaceDraft`: a draft in the box gives way to this message instead of stopping it. */
    async submit(title: string, text: string, threadId?: string, replaceDraft = false) {
      sending += 1;
      let response: ComposerResponse;
      try {
        response = await request("send", title, text, threadId, replaceDraft);
      } finally {
        sending -= 1;
      }
      if (response.ok) return;
      // Say why in the server's own output; the page only gets a short code.
      const detail = response.text ? Buffer.from(response.text, "base64").toString("utf8") : "";
      console.warn(`[${tool} window] could not send to "${title}": ${response.error || "failed"}${detail ? ` (${detail})` : ""}`);
      noteFailedSend(tool, title, response.error || "failed", detail);
      throw new Error(response.error || "failed");
    },
    /** Clicks the app's Stop button for the session's running reply. Fails with "idle" when no reply is running. */
    async stop(title: string, threadId?: string) {
      sending += 1;
      let response: ComposerResponse;
      try {
        response = await request("stop", title, "", threadId);
      } finally {
        sending -= 1;
      }
      if (response.ok) return;
      const detail = response.text ? Buffer.from(response.text, "base64").toString("utf8") : "";
      if (response.error !== "idle") {
        console.warn(`[${tool} window] could not stop the reply in "${title}": ${response.error || "failed"}${detail ? ` (${detail})` : ""}`);
      }
      throw new Error(response.error || "failed");
    },
    /**
     * The question the session's conversation shows in the window, read now and then (null when it asks nothing, or
     * when the window shows another conversation). Like `read`, it never switches the window to the session.
     */
    prompt(title: string): WindowPrompt | null {
      const hit = prompts.get(title);
      if ((!hit || Date.now() - hit.at > 1500) && !promptReading && sending === 0) {
        promptReading = true;
        void request("prompt", title)
          .then((response) => {
            const raw = response.ok && response.text ? Buffer.from(response.text, "base64").toString("utf8") : "";
            prompts.set(title, { prompt: parseWindowPrompt(raw), at: Date.now() });
          })
          .finally(() => {
            promptReading = false;
          });
      }
      return hit?.prompt ?? null;
    },
    /** Clicks `label` in the session's conversation: an answer button, or a question's choice and then its Submit. */
    async answer(title: string, label: string, threadId?: string) {
      sending += 1;
      let response: ComposerResponse;
      try {
        response = await request("answer", title, label, threadId);
      } finally {
        sending -= 1;
      }
      prompts.delete(title);
      if (response.ok) return;
      console.warn(`[${tool} window] could not answer in "${title}": ${response.error || "failed"}`);
      throw new Error(response.error || "failed");
    },
    /** Writes the conversation's buttons and texts to ~/.mirrormix/window-prompt-dump.txt, for a new app layout. */
    async dump(title: string) {
      await request("dump", title);
    },
    read(title: string) {
      const hit = cache.get(title);
      // Each reading walks the window's accessibility tree, which slows the window itself while it streams.
      if ((!hit || Date.now() - hit.at > 700) && !refreshing && sending === 0) {
        refreshing = true;
        void request("stream", title)
          .then((response) => {
            const raw = response.ok && response.text ? Buffer.from(response.text, "base64").toString("utf8") : "";
            cache.set(title, { text: raw, at: Date.now() });
          })
          .finally(() => {
            refreshing = false;
          });
      }
      return hit?.text ?? "";
    },
    /**
     * The app's usage: the button's own text (its fullest window, e.g. "Usage: Weekly · all models: 62%, Resets Tue 1:30 AM")
     * and the 5-hour window from its panel. Reads an already-open panel without changing it; only opens a closed
     * panel while locked. The latest successful reading survives service restarts.
     */
    usage(): DesktopUsage {
      if (Date.now() - meter.at > 60_000 && !meterReading && sending === 0) {
        meterReading = true;
        void request("usage", "", "panel")
          .then((response) => {
            if (!response.ok) {
              const detail = response.text ? Buffer.from(response.text, "base64").toString("utf8") : response.error;
              console.warn(`[${tool} window] could not read usage: ${detail || "failed"}`);
            }
            const raw = response.ok && response.text ? Buffer.from(response.text, "base64").toString("utf8") : "";
            let read: { meter?: unknown; fiveHour?: unknown; fiveHourReset?: unknown } = {};
            try {
              read = JSON.parse(raw || "{}") as typeof read;
            } catch {
              read = {};
            }
            const five = typeof read.fiveHour === "number" && Number.isFinite(read.fiveHour) ? read.fiveHour : null;
            meter = {
              // A window that is closed or still loading keeps the last reading instead of blanking it.
              meter: typeof read.meter === "string" && read.meter ? read.meter : meter.meter,
              fiveHour: five ?? meter.fiveHour,
              fiveHourReset: five != null && typeof read.fiveHourReset === "string" ? read.fiveHourReset : meter.fiveHourReset,
              fiveHourAt: five != null ? Date.now() : meter.fiveHourAt,
              at: Date.now(),
              ...(!response.ok ? { error: response.text ? Buffer.from(response.text, "base64").toString("utf8") : response.error || "failed" } : {}),
            };
            saveDesktopUsageCache(usageCacheFile, meter);
          })
          .finally(() => {
            meterReading = false;
          });
      }
      const { at: _at, ...usage } = meter;
      return usage;
    },
    dispose() {
      child?.kill();
      child = null;
    },
  };
}

/**
 * A send the window refused, kept in ~/.mirrormix/desktop-send.log so a failure can be looked into later even when
 * nobody watched the server output. The reason and the session title only: never the message itself.
 */
function noteFailedSend(tool: string, title: string, reason: string, detail: string) {
  try {
    const dir = path.join(os.homedir(), ".mirrormix");
    const file = path.join(dir, "desktop-send.log");
    mkdirSync(dir, { recursive: true });
    try {
      if (statSync(file).size > 200 * 1024) unlinkSync(file);
    } catch {
      /* no log yet */
    }
    appendFileSync(file, `${new Date().toISOString()} [${tool}] send failed in "${title}": ${reason}${detail ? ` (${detail})` : ""}\n`);
  } catch {
    /* the log is a help, never a reason for a send to fail */
  }
}
