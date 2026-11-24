import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseWindowPrompt, type WindowPrompt } from "./desktopComposer";

const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "cursorComposer.ps1");

interface ComposerResponse {
  ok?: boolean;
  error?: string;
  text?: string;
}

/** Types into the open Cursor Agents window. The command-line agent never reaches that conversation. */
export function createCursorComposer() {
  let child: ChildProcessWithoutNullStreams | null = null;
  let chain: Promise<void> = Promise.resolve();
  const waiters: Array<(response: ComposerResponse) => void> = [];

  const ensure = () => {
    if (child && child.exitCode === null) return;
    child = spawn("powershell.exe", ["-NoProfile", "-NoLogo", "-File", scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stderr.on("data", (chunk) => {
      const line = String(chunk).trim();
      if (line) console.error(`[cursor window] ${line}`);
    });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const waiter = waiters.shift();
      if (!waiter) return;
      try {
        waiter(JSON.parse(line) as ComposerResponse);
      } catch {
        waiter({ ok: false, error: "failed" });
      }
    });
    child.on("exit", () => {
      while (waiters.length) waiters.shift()?.({ ok: false, error: "failed" });
      child = null;
    });
  };

  /** The question each chat was last seen asking in the window, by title. */
  const prompts = new Map<string, { prompt: WindowPrompt | null; at: number }>();
  let promptReading = false;
  let busy = 0;

  const request = (op: "send" | "send-now" | "prompt" | "answer" | "dump", title: string, text: string) => {
    const run = chain.then(
      () =>
        new Promise<ComposerResponse>((resolve) => {
          ensure();
          if (!child) {
            resolve({ ok: false, error: "failed" });
            return;
          }
          const timer = setTimeout(() => {
            const index = waiters.indexOf(finish);
            if (index >= 0) waiters.splice(index, 1);
            resolve({ ok: false, error: "failed" });
          }, 20_000);
          const finish = (response: ComposerResponse) => {
            clearTimeout(timer);
            resolve(response);
          };
          waiters.push(finish);
          child.stdin.write(
            `${JSON.stringify({
              op,
              title: Buffer.from(title, "utf8").toString("base64"),
              text: Buffer.from(text, "utf8").toString("base64"),
            })}\n`,
          );
        }),
      () => Promise.resolve<ComposerResponse>({ ok: false, error: "failed" }),
    );
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  return {
    async submit(title: string, text: string) {
      const response = await request("send", title, text);
      if (response.ok) return;
      throw new Error(response.error || "failed");
    },
    /** The question the chat shows in Cursor's window, read now and then; null while the window shows another chat. */
    prompt(title: string): WindowPrompt | null {
      const hit = prompts.get(title);
      if ((!hit || Date.now() - hit.at > 2000) && !promptReading && busy === 0) {
        promptReading = true;
        void request("prompt", title, "")
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
    /** Clicks `label` in the chat: Run, Skip, Accept… or a question's choice. */
    async answer(title: string, label: string) {
      busy += 1;
      try {
        const response = await request("answer", title, label);
        prompts.delete(title);
        if (response.ok) return;
        throw new Error(response.error || "failed");
      } finally {
        busy -= 1;
      }
    },
    async dump(title: string) {
      await request("dump", title, "");
    },
    async submitNow(title: string, text: string) {
      const response = await request("send-now", title, text);
      if (response.ok) return;
      throw new Error(response.error || "failed");
    },
    dispose() {
      child?.kill();
      child = null;
    },
  };
}
