import { execFile } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ProcessInfo } from "./occupancy";

/**
 * Talks to the running DeepSeek Harness app through its own local server, the one its window is a page of. A message
 * sent this way goes into the app itself, so its window shows it at once and every kind of session can take it,
 * including the ones the app made (its one-shot command line refuses those).
 *
 * The server admits a browser cookie signed with the app's stored secret
 * (`records["client-connection/browser-session"].payload.secret` in `~/.dsh/.credentials.yaml`). MirrorMix signs one
 * per call. The secret never leaves this process and is never logged. Calls are `POST /api/<endpoint>` with
 * `{ type: "client-request", rpcId, method, payload: { args: { <parameter>: value } } }`.
 */

const b64u = (bytes: Buffer) => bytes.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");

/** The signing secret, or null when the file has none in the form the app writes. */
export function readBrowserSecret(credentialsFile: string): Buffer | null {
  let text: string;
  try {
    text = readFileSync(credentialsFile, "utf8");
  } catch {
    return null;
  }
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s+client-connection\/browser-session:\s*$/.test(line));
  if (start < 0) return null;
  const indent = lines[start].match(/^\s*/)![0].length;
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && line.match(/^\s*/)![0].length <= indent) break;
    const match = line.match(/^\s+secret:\s*["']?([A-Za-z0-9_-]+)["']?\s*$/);
    if (!match) continue;
    const secret = Buffer.from(match[1].replaceAll("-", "+").replaceAll("_", "/"), "base64");
    return secret.length === 32 ? secret : null;
  }
  return null;
}

/** The cookie the app's own page would carry for `authority` (`127.0.0.1:<port>`). */
export function browserCookie(secret: Buffer, authority: string, now = Date.now()): string {
  const body = b64u(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt: now - 1_000, expiresAt: now + 10 * 60_000 })));
  const name = `dsh-auth-${b64u(createHash("sha256").update(authority).digest())}`;
  return `${name}=v1.${body}.${b64u(createHmac("sha256", secret).update(body).digest())}`;
}

/** The app's host process: the one that runs dsh-desktop-host's index.js (its command line runs cli.js instead). */
export function deepseekHostPid(processes: ProcessInfo[]): number | null {
  const host = processes.find((item) => /DeepSeek Harness\.exe/i.test(item.commandLine ?? "") && /dsh-desktop-host[\\/]lib[\\/]index\.js/i.test(item.commandLine ?? ""));
  return host?.pid ?? null;
}

/** `netstat -ano` lines: the loopback port the given process listens on. */
export function listeningPort(netstat: string, pid: number): number | null {
  for (const line of netstat.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || parts[0] !== "TCP" || parts[3] !== "LISTENING" || Number(parts[4]) !== pid) continue;
    const match = parts[1].match(/^127\.0\.0\.1:(\d+)$/);
    if (match) return Number(match[1]);
  }
  return null;
}

export interface DeepseekAppSession {
  sessionId: string;
  running: boolean;
}

export interface DeepseekApp {
  /** The app is open and its server answers (as last seen; refreshed in the background). */
  available(): boolean;
  prompt(sessionId: string, text: string, mode: "queue" | "steer"): Promise<void>;
  create(cwd: string): Promise<string>;
  cancel(sessionId: string): Promise<void>;
  sessions(): Promise<DeepseekAppSession[]>;
}

export class DeepseekAppError extends Error {
  constructor(
    /** "unavailable": the app or its server cannot be reached; "refused": it answered with an error. */
    readonly reason: "unavailable" | "refused",
    message: string,
    readonly code = "",
  ) {
    super(message);
  }
}

const CALL_TIMEOUT_MS = 15_000;

export function createDeepseekApp(options: {
  credentialsFile: string;
  listProcesses: () => ProcessInfo[];
  /** Reads `netstat -ano`. Replaced in tests. */
  netstat?: () => Promise<string>;
  fetch?: typeof fetch;
}): DeepseekApp {
  const doFetch = options.fetch ?? fetch;
  const netstat =
    options.netstat ??
    (() =>
      new Promise<string>((resolve, reject) =>
        execFile("netstat", ["-ano", "-p", "TCP"], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(stdout))),
      ));
  let found: { pid: number; port: number } | null = null;

  const locate = async (): Promise<{ pid: number; port: number }> => {
    const pid = deepseekHostPid(options.listProcesses());
    if (pid === null) throw new DeepseekAppError("unavailable", "DeepSeek Harness is not running");
    if (found?.pid === pid) return found;
    const port = listeningPort(await netstat(), pid);
    if (port === null) throw new DeepseekAppError("unavailable", "DeepSeek Harness has no local server");
    found = { pid, port };
    return found;
  };

  const call = async <T>(method: string, args: Record<string, unknown>): Promise<T> => {
    const secret = readBrowserSecret(options.credentialsFile);
    if (!secret) throw new DeepseekAppError("unavailable", "no browser-session secret");
    const { port } = await locate();
    const authority = `127.0.0.1:${port}`;
    let response: Response;
    try {
      response = await doFetch(`http://${authority}/api/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: browserCookie(secret, authority) },
        body: JSON.stringify({ type: "client-request", rpcId: randomUUID(), method, payload: { args } }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch (error) {
      // The app restarted on another port, say: look again next time.
      found = null;
      throw new DeepseekAppError("unavailable", error instanceof Error ? error.message : String(error));
    }
    if (!response.ok) {
      found = null;
      throw new DeepseekAppError("unavailable", `HTTP ${response.status}`);
    }
    const reply = (await response.json()) as { result?: { ok: boolean; value?: T; error?: { code?: string; message?: string } } };
    if (!reply.result?.ok) throw new DeepseekAppError("refused", reply.result?.error?.message ?? "refused", reply.result?.error?.code ?? "");
    return reply.result.value as T;
  };

  return {
    available: () => deepseekHostPid(options.listProcesses()) !== null && readBrowserSecret(options.credentialsFile) !== null,
    async prompt(sessionId, text, mode) {
      await call("session/prompt", {
        request: { requestId: randomUUID(), sessionId, mode, content: [{ type: "text", text }], clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      });
    },
    async create(cwd) {
      const value = await call<{ sessionId: string }>("session/create", { request: { cwd } });
      return value.sessionId;
    },
    async cancel(sessionId) {
      await call("session/cancel", { request: { sessionId } });
    },
    async sessions() {
      const value = await call<{ items?: Array<{ sessionId: string; running?: boolean }> }>("session/list", { _request: {} });
      return (value.items ?? []).map((item) => ({ sessionId: item.sessionId, running: Boolean(item.running) }));
    },
  };
}
