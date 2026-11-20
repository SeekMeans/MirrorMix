import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, statSync, realpathSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { ApiError, type SessionView, type Supervisor } from "../process/supervisor";
import { AccountLocked } from "./windowsLogin";
import { ACTIVE_WINDOW_MS, createLoginSessions, LOGIN_LIFETIME_MS } from "./loginSessions";
import { RemoteError, type RemoteUpdate, type Tunnel } from "../remote/tunnel";
import type { SettingsStore } from "../settings/toolSettings";
import type { ToolId, TranscriptMessage } from "../shared/types";
import { createTerminalHub, TerminalError } from "./terminals";
import { slashCommands } from "../catalog/slashCommands";
import { resolveClaudeDataDir } from "../catalog/claudeData";
import { listFolder, sendFolderFile } from "./files";
import { handleSshRequest, handleSshUpgrade } from "../ssh/routes";
import type { SshManager } from "../ssh/manager";
import type { SshStore } from "../ssh/store";
import { CommandError, createCommandStore, type CommandStore } from "../settings/commandStore";
import { TaskError, type CommandTasks } from "../tasks/commandTasks";
import { workspaceTerminalKey, type TerminalProject } from "../shared/terminalScope";
import { createPreviewPickStore, PreviewPickError, type PreviewPickStore } from "../settings/previewPicks";
import { saveUpload, UploadError } from "./uploads";

function asTool(value: unknown): ToolId | null {
  return value === "claude" || value === "codex" || value === "cursor" || value === "deepseek" ? value : null;
}

export const LOCAL_HOST = "127.0.0.1";

const distDir = path.resolve("dist");

/** How many messages one page carries. The browser never holds a whole transcript unless it asks for it page by page. */
export const PAGE_SIZE = 60;
const MAX_PAGE_SIZE = 200;

export interface SessionWindow extends SessionView {
  /** Number of messages in the whole transcript. */
  total: number;
  /** Index of messages[0] within the whole transcript. */
  offset: number;
}

export function windowOf(view: SessionView, limit = PAGE_SIZE, before?: number): SessionWindow {
  const total = view.messages.length;
  const end = before === undefined ? total : Math.min(Math.max(before, 0), total);
  const start = Math.max(0, end - Math.min(Math.max(limit, 1), MAX_PAGE_SIZE));
  return { ...view, total, offset: start, messages: view.messages.slice(start, end) };
}

function wholeNumber(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value)) return undefined;
  return Number(value);
}

export function listenLocal(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve) => {
    server.listen(port, LOCAL_HOST, () => resolve());
  });
}

export interface LoginGate {
  /** True when Windows accepts this account. The password must not be stored or logged. */
  verify(username: string, password: string): Promise<boolean>;
  /** Where sign-ins are kept so a server restart does not sign everyone out. Memory only when absent. */
  sessionFile?: string;
}

const SESSION_COOKIE = "mirrormix";

/**
 * Page origins allowed besides the one the request was addressed to, comma separated.
 * Only needed behind a proxy that rewrites the Host header, e.g. MIRRORMIX_ALLOWED_ORIGINS=https://mm.example.com
 */
function extraOrigins(): Set<string> {
  return new Set(
    (process.env.MIRRORMIX_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((item) => item.trim().toLowerCase().replace(/\/+$/, ""))
      .filter(Boolean),
  );
}

function headerList(value: string | string[] | undefined): string[] {
  const joined = Array.isArray(value) ? value.join(",") : value ?? "";
  return joined
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Whether a browser page may act on this server: its Origin must be the address the request was sent to
 * (directly, or as a proxy in front reports it), or one listed in MIRRORMIX_ALLOWED_ORIGINS.
 * A page on another site can make the browser send the login cookie along with a WebSocket or a form post;
 * this is what stops it. A request with no Origin is not a page acting across sites and is let through.
 */
export function originAllowed(request: http.IncomingMessage, also?: string | null): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  let page: URL;
  try {
    page = new URL(origin);
  } catch {
    return false;
  }
  if (page.protocol !== "http:" && page.protocol !== "https:") return false;
  const own = [...headerList(request.headers.host), ...headerList(request.headers["x-forwarded-host"])];
  if (own.includes(page.host.toLowerCase())) return true;
  if (also && page.origin.toLowerCase() === also.toLowerCase()) return true;
  return extraOrigins().has(page.origin.toLowerCase());
}

/** The browser reached this server over HTTPS, directly or through a proxy that says so. */
function overHttps(request: http.IncomingMessage): boolean {
  if (headerList(request.headers["x-forwarded-proto"])[0] === "https") return true;
  const origin = request.headers.origin;
  return typeof origin === "string" && origin.toLowerCase().startsWith("https://");
}

/** Over HTTPS the login cookie is marked Secure, so the browser never sends it over plain HTTP. */
function cookieFlags(request: http.IncomingMessage): string {
  return `HttpOnly; SameSite=Lax; Path=/${overHttps(request) ? "; Secure" : ""}`;
}
const MAX_LOGIN_BODY = 4_096;
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_LIMIT = 8;

export interface CommandShell {
  elevated?: boolean | null;
  windowsPty?: TerminalProject["windowsPty"];
  /** Starts cmd.exe in this directory. It runs until it is closed from the page or exits on its own. */
  open(cwd: string, cols: number, rows: number): {
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(): void;
    onData(callback: (data: string) => void): void;
    onExit(callback: () => void): void;
  };
}

/** Serves the page itself instead of the built files in dist: the Vite dev server, which reloads it on edits. */
export interface PageServer {
  handle(request: http.IncomingMessage, response: http.ServerResponse): void;
  /** True for a WebSocket the page server answers itself (its hot-reload channel). */
  ownsUpgrade(request: http.IncomingMessage): boolean;
}

/** Pages running on this PC, shown through the preview listener. */
export interface PreviewLink {
  allowed(port: number): boolean;
  /** The path on the preview address that lets one browser in, e.g. "/__mirrormix/enter?ticket=…". */
  issue(target: number | { root: string; entry: string }): string;
  ports(): Promise<Array<{ port: number; name: string }>>;
  /** The HTML files in a folder, newest first. */
  htmlFiles(root: string): Array<{ path: string; size: number; modifiedAt: string }>;
  /** One file of a folder, or null when it is not there (anymore). */
  htmlFile?(root: string, relative: string): { path: string; size: number; modifiedAt: string; title?: string } | null;
  /** Where the preview listener answers: this PC's own address, or the tunnel's preview subdomain. */
  origin(throughTunnel: boolean): string | null;
}

export function createApp(
  supervisor: Supervisor,
  settings?: SettingsStore,
  gate?: LoginGate,
  shells?: CommandShell,
  remote?: Tunnel,
  preview?: PreviewLink,
  pages?: PageServer,
  commands: CommandStore = createCommandStore(process.env.AIMISS_COMMANDS || path.join(os.homedir(), ".mirrormix", "commands.json")),
  previewPicks?: PreviewPickStore,
  /** Commands kept in Settings: run once, or kept running like a dev server. */
  tasks?: CommandTasks,
  /** Where files and pictures added to messages are kept. */
  uploadsDir: string = process.env.AIMISS_UPLOADS || path.join(os.homedir(), ".mirrormix", "uploads"),
  /** The SSH plugin: saved hosts, keychain, terminals, SFTP and port forwarding. */
  ssh?: { manager: SshManager; store: SshStore },
): http.Server {
  const picks =
    previewPicks ??
    (preview ? createPreviewPickStore(process.env.AIMISS_PREVIEW_PICKS || path.join(os.homedir(), ".mirrormix", "preview-picks.json"), (port) => preview.allowed(port)) : null);
  // While the tunnel is on, this PC's public address is its own page too.
  const sameDesk = (request: http.IncomingMessage) => originAllowed(request, remote?.origin());
  const sessions = createLoginSessions(gate?.sessionFile);
  const failures: number[] = [];
  const terminals = shells ? createTerminalHub((cwd, cols, rows) => shells.open(cwd, cols, rows)) : null;
  /** The folder a session's command lines start in, checked to still exist. */
  const sessionFolder = (tool: ToolId, id: string) => {
    let cwd = "";
    try {
      cwd = supervisor.getSession(tool, id).workspacePath;
    } catch {
      throw new ApiError(404, "unknown_session");
    }
    const folder = cwd ? path.resolve(cwd) : "";
    if (!folder || !existsSync(folder) || !statSync(folder).isDirectory()) throw new ApiError(409, "missing_workspace");
    return folder;
  };
  const signedIn = (request: http.IncomingMessage) => {
    const token = readCookie(request.headers.cookie, SESSION_COOKIE);
    return Boolean(token && sessions.has(token));
  };
  const terminalProject = (tool: ToolId, id: string, creating = false): TerminalProject => {
    const cwd = supervisor.getSession(tool, id).workspacePath;
    if (!cwd) throw new ApiError(409, "missing_workspace");
    let root = path.resolve(cwd);
    try { root = realpathSync.native(root); }
    catch { if (creating) throw new ApiError(409, "missing_workspace"); }
    if (creating && !statSync(root).isDirectory()) throw new ApiError(409, "missing_workspace");
    return { key: workspaceTerminalKey(root), root, elevated: shells?.elevated ?? null, survivesRestart: false, windowsPty: shells?.windowsPty };
  };
  /** Refuses work for a tool that is switched off in settings or whose app is not open on this machine. */
  const requireUsable = (tool: ToolId) => {
    if (settings && !settings.usable(tool)) throw new ApiError(409, "tool_offline");
  };
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${LOCAL_HOST}`);
      // Anything that changes state must come from this desk's own page, not from another site in the same browser.
      const reading = request.method === "GET" || request.method === "HEAD";
      if (url.pathname.startsWith("/api/") && !reading && !sameDesk(request)) {
        return sendJson(response, 403, { error: "bad_origin" });
      }
      if (gate && request.method === "POST" && url.pathname === "/api/login") {
        const now = Date.now();
        while (failures.length && now - failures[0] > LOGIN_WINDOW_MS) failures.shift();
        if (failures.length >= LOGIN_LIMIT) return sendJson(response, 429, { error: "rate_limited" });
        const body = await readJson<{ username?: unknown; password?: unknown }>(request, MAX_LOGIN_BODY);
        const username = typeof body.username === "string" ? body.username : "";
        const password = typeof body.password === "string" ? body.password : "";
        if (!username.trim() || !password || username.length > 256 || password.length > 256) {
          return sendJson(response, 401, { error: "bad_credentials" });
        }
        let ok = false;
        try {
          ok = await gate.verify(username.trim(), password);
        } catch (error) {
          if (error instanceof AccountLocked) return sendJson(response, 423, { error: "locked" });
          throw error;
        }
        if (!ok) {
          failures.push(Date.now());
          return sendJson(response, 401, { error: "bad_credentials" });
        }
        const token = randomBytes(32).toString("base64url");
        sessions.add(token, username);
        response.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "set-cookie": `${SESSION_COOKIE}=${token}; ${cookieFlags(request)}; Max-Age=${Math.floor(LOGIN_LIFETIME_MS / 1000)}`,
        });
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      if (gate && request.method === "POST" && url.pathname === "/api/logout") {
        const token = readCookie(request.headers.cookie, SESSION_COOKIE);
        if (token) sessions.delete(token);
        response.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "set-cookie": `${SESSION_COOKIE}=; ${cookieFlags(request)}; Max-Age=0`,
        });
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/session") {
        response.setHeader("Cache-Control", "no-store");
        const authenticated = !gate || signedIn(request);
        return sendJson(response, 200, { ok: true, authenticated, ...(!authenticated ? { username: os.userInfo().username } : {}) });
      }
      if (gate && url.pathname.startsWith("/api/") && url.pathname !== "/api/health" && !signedIn(request)) {
        return sendJson(response, 401, { error: "unauthenticated" });
      }
      // In use: the page says how long ago the person last touched it. Only then does the sign-in move out another
      // hour, so a tab left open (which still polls) signs out an hour after the last real use.
      if (gate && url.pathname.startsWith("/api/")) {
        const idle = Number(request.headers["x-mirrormix-idle"]);
        const token = readCookie(request.headers.cookie, SESSION_COOKIE);
        if (token && Number.isFinite(idle) && idle >= 0 && idle * 1000 < ACTIVE_WINDOW_MS && sessions.renew(token)) {
          response.setHeader("set-cookie", `${SESSION_COOKIE}=${token}; ${cookieFlags(request)}; Max-Age=${Math.floor(LOGIN_LIFETIME_MS / 1000)}`);
        }
      }
      if (request.method === "GET" && url.pathname === "/api/stats/today") {
        if (!supervisor.todayStats) return sendJson(response, 404, { error: "not_found" });
        response.setHeader("Cache-Control", "no-store");
        return sendJson(response, 200, supervisor.todayStats());
      }
      if (request.method === "GET" && url.pathname === "/api/health") {
        return sendJson(response, 200, { ok: true });
      }
      if (url.pathname === "/api/commands" || url.pathname === "/api/commands/prepare") {
        response.setHeader("Cache-Control", "no-store");
        try {
          if (request.method === "GET" && url.pathname === "/api/commands") return sendJson(response, 200, commands.read());
          if (request.method === "PUT" && url.pathname === "/api/commands") {
            const body = await readJson<{ commands?: unknown; revision?: unknown }>(request, 2 * 1024 * 1024);
            return sendJson(response, 200, commands.write(body.commands, body.revision));
          }
          if (request.method === "POST" && url.pathname === "/api/commands/prepare") {
            const body = await readJson<{ group?: unknown; name?: unknown; message?: unknown; revision?: unknown }>(request, 8_192);
            return sendJson(response, 200, { command: commands.prepare(body.group, body.name, body.message, body.revision) });
          }
          return sendJson(response, 405, { error: "bad_request" });
        } catch (error) {
          if (error instanceof CommandError) return sendJson(response, error.status, { error: error.code });
          throw error;
        }
      }
      if (tasks && (url.pathname === "/api/tasks" || url.pathname.startsWith("/api/tasks/"))) {
        response.setHeader("Cache-Control", "no-store");
        const match = url.pathname.match(/^\/api\/tasks(?:\/([0-9a-f]{1,32})(?:\/(start|stop|restart|log))?)?$/);
        try {
          if (!match) return sendJson(response, 404, { error: "not_found" });
          const [, id, action] = match;
          if (!id && request.method === "GET") return sendJson(response, 200, { tasks: await tasks.inspect(tasks.list()) });
          if (!id && request.method === "POST") return sendJson(response, 200, tasks.create(await readJson<unknown>(request, 16_384)));
          if (id && !action && request.method === "PUT") return sendJson(response, 200, tasks.update(id, await readJson<unknown>(request, 16_384)));
          if (id && !action && request.method === "DELETE") {
            await tasks.remove(id);
            return sendJson(response, 200, { ok: true });
          }
          if (id && action === "start" && request.method === "POST") return sendJson(response, 200, tasks.start(id));
          if (id && action === "stop" && request.method === "POST") return sendJson(response, 200, await tasks.stop(id));
          if (id && action === "restart" && request.method === "POST") return sendJson(response, 200, await tasks.restart(id));
          if (id && action === "log" && request.method === "GET") return sendJson(response, 200, tasks.log(id));
          return sendJson(response, 405, { error: "bad_request" });
        } catch (error) {
          if (error instanceof TaskError) return sendJson(response, error.status, { error: error.code });
          throw error;
        }
      }
      if (remote && request.method === "GET" && url.pathname === "/api/remote/token") {
        // Only for the eye button in Settings. Signed-in users can already run anything on this PC.
        response.setHeader("Cache-Control", "no-store");
        return sendJson(response, 200, { token: remote.token() ?? "" });
      }
      if (remote && url.pathname === "/api/remote") {
        if (request.method === "GET") return sendJson(response, 200, remote.view());
        if (request.method === "PUT") {
          const change = await readJson<RemoteUpdate>(request, 8_192);
          try {
            return sendJson(response, 200, remote.update(change ?? {}));
          } catch (error) {
            if (error instanceof RemoteError) return sendJson(response, 400, { error: error.code });
            throw error;
          }
        }
      }
      if (ssh && url.pathname.startsWith("/api/ssh/") && (await handleSshRequest(ssh, request, response, url))) return;
      if (settings && url.pathname === "/api/plugins") {
        if (request.method === "PUT") {
          try {
            return sendJson(response, 200, { installed: settings.setPlugins(await readJson<unknown>(request)) });
          } catch (error) {
            if (error instanceof ApiError) throw error;
            return sendJson(response, 400, { error: "bad_request" });
          }
        }
        if (request.method === "GET") return sendJson(response, 200, { installed: settings.plugins() });
      }
      if (settings && url.pathname === "/api/settings") {
        if (request.method === "PUT") {
          try {
            settings.write(await readJson<unknown>(request));
          } catch (error) {
            if (error instanceof ApiError) throw error;
            return sendJson(response, 400, { error: "bad_request" });
          }
        }
        if (request.method === "GET" || request.method === "PUT") {
          return sendJson(response, 200, { ...settings.read(), status: settings.status(), host: os.hostname(), capabilities: supervisor.capabilities() });
        }
      }
      if (request.method === "GET" && url.pathname === "/api/catalog") {
        return sendJson(response, 200, supervisor.catalog());
      }
      if (request.method === "GET" && url.pathname === "/api/schedules") {
        return sendJson(response, 200, supervisor.schedules());
      }
      const sessionMatch = url.pathname.match(/^\/api\/sessions\/(claude|codex|cursor|deepseek)\/([^/]+)$/);
      if (request.method === "GET" && sessionMatch) {
        const view = supervisor.getSession(sessionMatch[1] as ToolId, decodeURIComponent(sessionMatch[2]));
        return sendJson(
          response,
          200,
          windowOf(view, wholeNumber(url.searchParams.get("limit")), wholeNumber(url.searchParams.get("before"))),
        );
      }
      // A file or picture added to a message: the body is the file itself, its name in x-file-name (URI-encoded).
      if (request.method === "POST" && url.pathname === "/api/uploads") {
        let name = "";
        try {
          name = decodeURIComponent(String(request.headers["x-file-name"] ?? ""));
        } catch {
          return sendJson(response, 400, { error: "bad_request" });
        }
        try {
          return sendJson(response, 200, await saveUpload(uploadsDir, name || "file", request));
        } catch (error) {
          if (error instanceof UploadError) return sendJson(response, error.status, { error: error.code });
          throw error;
        }
      }
      if (request.method === "POST" && url.pathname === "/api/sessions/open") {
        const body = await readJson<{ tool: string; id: string }>(request);
        const tool = asTool(body.tool);
        if (!tool) return sendJson(response, 400, { error: "bad_request" });
        requireUsable(tool);
        return sendJson(response, 200, windowOf(supervisor.open(tool, body.id)));
      }
      if (request.method === "POST" && url.pathname === "/api/sessions/create") {
        const body = await readJson<{ tool: string; workspacePath: string }>(request);
        const tool = asTool(body.tool);
        if (!tool) return sendJson(response, 400, { error: "bad_request" });
        requireUsable(tool);
        return sendJson(response, 200, windowOf(await supervisor.create(tool, body.workspacePath)));
      }
      if (request.method === "POST" && url.pathname === "/api/sessions/delete") {
        const body = await readJson<{ tool: string; id: string }>(request);
        const tool = asTool(body.tool);
        if (!tool || typeof body.id !== "string" || !body.id) return sendJson(response, 400, { error: "bad_request" });
        return sendJson(response, 200, await supervisor.remove(tool, body.id));
      }
      if (request.method === "POST" && url.pathname === "/api/sessions/close") {
        const body = await readJson<{ tool: string; id: string }>(request);
        const tool = asTool(body.tool);
        if (!tool) return sendJson(response, 400, { error: "bad_request" });
        return sendJson(response, 200, windowOf(supervisor.close(tool, body.id)));
      }
      if (preview && request.method === "GET" && url.pathname === "/api/preview/ports") {
        return sendJson(response, 200, { ports: await preview.ports() });
      }
      // The file browser: one folder of the session's workspace at a time, and its files for the preview.
      if (request.method === "GET" && (url.pathname === "/api/files" || url.pathname === "/api/files/raw")) {
        const tool = asTool(url.searchParams.get("tool"));
        const id = url.searchParams.get("id");
        if (!tool || !id) return sendJson(response, 400, { error: "bad_request" });
        const root = sessionFolder(tool, id);
        if (url.pathname === "/api/files") {
          const listing = listFolder(root, url.searchParams.get("dir") ?? "");
          if (!listing) return sendJson(response, 404, { error: "not_found" });
          return sendJson(response, 200, { root, ...listing });
        }
        if (!sendFolderFile(root, url.searchParams.get("path") ?? "", url.searchParams.get("download") === "1", response)) {
          return sendJson(response, 404, { error: "not_found" });
        }
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/slash") {
        const tool = asTool(url.searchParams.get("tool"));
        const id = url.searchParams.get("id");
        if (!tool || !id) return sendJson(response, 400, { error: "bad_request" });
        let cwd = "";
        let desktop = false;
        try {
          const view = supervisor.getSession(tool, id);
          cwd = view.workspacePath;
          desktop = view.attached !== "process";
        } catch {
          /* without the session's folder only the tool's own and the user's commands are listed */
        }
        return sendJson(response, 200, { commands: slashCommands(tool, cwd, os.homedir(), { desktop, claudeDataDir: resolveClaudeDataDir() }) });
      }
      if (preview && request.method === "GET" && url.pathname === "/api/preview/files") {
        const tool = asTool(url.searchParams.get("tool"));
        const id = url.searchParams.get("id");
        if (!tool || !id) return sendJson(response, 400, { error: "bad_request" });
        const root = sessionFolder(tool, id);
        return sendJson(response, 200, { root, files: preview.htmlFiles(root) });
      }
      // What the preview menu shows, picked per project folder: all sessions in the folder share it.
      if (preview && picks && url.pathname === "/api/preview/picks") {
        response.setHeader("Cache-Control", "no-store");
        let tool: ToolId | null;
        let id: string;
        let body: { tool?: unknown; id?: unknown; files?: unknown; ports?: unknown } = {};
        if (request.method === "GET") {
          tool = asTool(url.searchParams.get("tool"));
          id = url.searchParams.get("id") ?? "";
        } else if (request.method === "PUT") {
          body = await readJson<typeof body>(request, 128 * 1024);
          tool = asTool(body.tool);
          id = typeof body.id === "string" ? body.id : "";
        } else {
          return sendJson(response, 405, { error: "bad_request" });
        }
        if (!tool || !id) return sendJson(response, 400, { error: "bad_request" });
        const root = sessionFolder(tool, id);
        let real = root;
        try {
          real = realpathSync.native(root);
        } catch {
          /* the folder was just checked; keep the plain path */
        }
        const key = workspaceTerminalKey(real);
        let chosen;
        try {
          chosen = request.method === "PUT" ? picks.set(key, real, body) : picks.get(key);
        } catch (error) {
          if (error instanceof PreviewPickError) return sendJson(response, 400, { error: error.code });
          throw error;
        }
        const files = (chosen?.files ?? []).map((file) => preview.htmlFile?.(root, file) ?? { path: file, missing: true as const });
        return sendJson(response, 200, { root, key, picks: chosen, files });
      }
      if (preview && request.method === "POST" && url.pathname === "/api/preview/open") {
        const body = await readJson<{ port?: unknown; tool?: unknown; id?: unknown; file?: unknown; path?: unknown }>(request, 8_192);
        let target: number | { root: string; entry: string };
        if (typeof body.file === "string" || typeof body.path === "string") {
          // A file in the session folder, or any HTML file on this PC given by its full path. The folder it is in is
          // what the page may load from, so its pictures, styles and scripts next to it show too.
          let root: string;
          let entry: string;
          if (typeof body.path === "string") {
            const full = path.resolve(body.path);
            if (!/\.html?$/i.test(full) || !existsSync(full) || !statSync(full).isFile()) return sendJson(response, 404, { error: "no_file" });
            root = path.dirname(full);
            entry = path.basename(full);
          } else {
            const tool = asTool(body.tool);
            if (!tool || typeof body.id !== "string") return sendJson(response, 400, { error: "bad_request" });
            root = sessionFolder(tool, body.id);
            entry = String(body.file).replace(/\\/g, "/").replace(/^\/+/, "");
            const full = path.resolve(root, entry);
            if (!full.startsWith(`${root}${path.sep}`) || !existsSync(full) || !statSync(full).isFile()) return sendJson(response, 404, { error: "no_file" });
          }
          target = { root, entry };
        } else {
          const port = typeof body.port === "number" ? body.port : Number(body.port);
          if (!preview.allowed(port)) return sendJson(response, 400, { error: "bad_port" });
          target = port;
        }
        // Reached through the tunnel: the page must open on the tunnel's preview subdomain, not on this PC's localhost.
        const publicOrigin = remote?.origin();
        const host = headerList(request.headers["x-forwarded-host"])[0] ?? headerList(request.headers.host)[0] ?? "";
        const throughTunnel = Boolean(publicOrigin && new URL(publicOrigin).host.toLowerCase() === host);
        const origin = preview.origin(throughTunnel);
        if (!origin) return sendJson(response, 409, { error: "preview_unavailable" });
        return sendJson(response, 200, { url: `${origin}${preview.issue(target)}` });
      }
      if (url.pathname === "/api/cmd/list" || url.pathname === "/api/cmd/new" || url.pathname === "/api/cmd/close") {
        if (!terminals) return sendJson(response, 404, { error: "not_found" });
        if (request.method === "GET" && url.pathname === "/api/cmd/list") {
          const tool = asTool(url.searchParams.get("tool"));
          const id = url.searchParams.get("id");
          if (!tool || !id) return sendJson(response, 400, { error: "bad_request" });
          const project = terminalProject(tool, id);
          return sendJson(response, 200, { project, terminals: terminals.list(project.key) });
        }
        if (request.method !== "POST") return sendJson(response, 405, { error: "bad_request" });
        const body = await readJson<{ tool?: string; id?: string; tid?: string; ensure?: boolean }>(request, 4_096);
        const tool = asTool(body.tool);
        const id = typeof body.id === "string" ? body.id : "";
        if (!tool || !id) return sendJson(response, 400, { error: "bad_request" });
        const project = terminalProject(tool, id, url.pathname === "/api/cmd/new");
        const key = project.key;
        try {
          if (url.pathname === "/api/cmd/new") {
            const terminal = body.ensure === true ? terminals.ensure(key, project.root) : terminals.create(key, project.root);
            return sendJson(response, 200, { project, terminal, terminals: terminals.list(key) });
          }
          if (typeof body.tid !== "string") return sendJson(response, 400, { error: "bad_request" });
          terminals.close(key, body.tid);
          return sendJson(response, 200, { project, terminals: terminals.list(key) });
        } catch (error) {
          if (error instanceof TerminalError) {
            return sendJson(response, error.code === "too_many" ? 409 : error.code === "unknown_terminal" ? 404 : 500, { error: error.code });
          }
          throw error;
        }
      }
      if (request.method === "POST" && url.pathname === "/api/sessions/answer") {
        const body = await readJson<{ tool: string; id: string; choice?: string }>(request);
        const tool = asTool(body.tool);
        if (!tool || (body.choice !== "trust" && body.choice !== "cancel")) return sendJson(response, 400, { error: "bad_request" });
        return sendJson(response, 200, windowOf(supervisor.answer(tool, body.id, body.choice)));
      }
      if (request.method === "POST" && url.pathname === "/api/sessions/send") {
        const body = await readJson<{ tool: string; id: string; text: string }>(request);
        const tool = asTool(body.tool);
        if (!tool) return sendJson(response, 400, { error: "bad_request" });
        requireUsable(tool);
        await supervisor.send(tool, body.id, body.text);
        return sendJson(response, 200, { ok: true });
      }
      if (request.method === "POST" && url.pathname === "/api/sessions/send-now") {
        const body = await readJson<{ tool: string; id: string; text: string }>(request);
        const tool = asTool(body.tool);
        if (!tool) return sendJson(response, 400, { error: "bad_request" });
        requireUsable(tool);
        await supervisor.sendNow(tool, body.id, body.text);
        return sendJson(response, 200, { ok: true });
      }
      if (request.method === "POST" && url.pathname === "/api/sessions/interrupt") {
        const body = await readJson<{ tool: string; id: string }>(request);
        const tool = asTool(body.tool);
        if (!tool || typeof body.id !== "string") return sendJson(response, 400, { error: "bad_request" });
        await supervisor.interrupt(tool, body.id);
        return sendJson(response, 200, { ok: true });
      }
      if (request.method === "GET" && !url.pathname.startsWith("/api/")) {
        if (pages) return pages.handle(request, response);
        return serveStatic(url.pathname, response);
      }
      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      if (error instanceof ApiError) sendJson(response, error.status, { error: error.code });
      else sendJson(response, 500, { error: "failed" });
    }
  });

  const sockets = new WebSocketServer({ noServer: true });
  const openCommand = (url: URL, request: http.IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => {
    const tool = asTool(url.searchParams.get("tool"));
    const id = url.searchParams.get("id");
    const tid = url.searchParams.get("tid");
    if (!terminals || !tool || !id || !tid) {
      socket.destroy();
      return;
    }
    let project: TerminalProject;
    try { project = terminalProject(tool, id); }
    catch { socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n"); socket.destroy(); return; }
    sockets.handleUpgrade(request, socket, head, (client) => {
      const link = terminals.attach(project.key, tid, {
        send(data) {
          if (client.readyState === client.OPEN) client.send(data);
        },
        close() {
          client.close(4000, "exited");
        },
      });
      // The terminal was closed or its cmd.exe exited: the page asks for the list again.
      if (!link) {
        client.close(4404, "unknown_terminal");
        return;
      }
      client.on("message", (data) => {
        const text = String(data);
        const resize = readShellResize(text);
        if (resize) {
          link.resize(resize.cols, resize.rows);
          return;
        }
        link.write(text);
      });
      // Leaving only detaches this screen. The command line keeps running for the next one.
      client.on("close", () => link.detach());
    });
  };
  server.on("upgrade", (request, socket, head) => {
    // The page server listens on this server too and checks its own channel.
    if (pages?.ownsUpgrade(request)) return;
    const url = new URL(request.url ?? "/", `http://${LOCAL_HOST}`);
    if (url.pathname !== "/api/terminal" && url.pathname !== "/api/live" && url.pathname !== "/api/cmd" && url.pathname !== "/api/ssh/term") {
      socket.destroy();
      return;
    }
    // A WebSocket is not covered by the browser's same-origin rules, so the page that opens it is checked here.
    if (!sameDesk(request)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if (gate && !signedIn(request)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if (url.pathname === "/api/ssh/term") {
      if (!ssh) return void socket.destroy();
      handleSshUpgrade(ssh.manager, url, request, socket, head);
      return;
    }
    if (url.pathname === "/api/cmd") {
      openCommand(url, request, socket, head);
      return;
    }
    sockets.handleUpgrade(request, socket, head, (client) => {
      const tool = asTool(url.searchParams.get("tool"));
      const id = url.searchParams.get("id");
      if (!tool || !id) {
        client.close();
        return;
      }
      if (url.pathname === "/api/live") {
        // First frame is a snapshot of the newest page. After that only the part of the
        // transcript that changed goes over the wire, so a long session costs the same as a short one.
        let sent: TranscriptMessage[] | null = null;
        let sentMeta = "";
        const stop = supervisor.subscribe(tool, id, (view) => {
          if (client.readyState !== client.OPEN) return;
          const { messages, ...meta } = view;
          const nextMeta = JSON.stringify(meta);
          if (!sent) {
            client.send(JSON.stringify({ type: "snapshot", ...windowOf(view) }));
          } else {
            const shared = Math.min(sent.length, messages.length);
            let from = 0;
            while (from < shared && sameMessage(sent[from], messages[from])) from += 1;
            if (from === messages.length && from === sent.length && nextMeta === sentMeta) return;
            if (from < messages.length - PAGE_SIZE) {
              client.send(JSON.stringify({ type: "snapshot", ...windowOf(view) }));
            } else {
              client.send(
                JSON.stringify({ type: "patch", ...meta, total: messages.length, offset: from, messages: messages.slice(from) }),
              );
            }
          }
          sent = messages;
          sentMeta = nextMeta;
        });
        client.on("close", () => stop());
        return;
      }
      supervisor.connectTerminal(tool, id, {
        send(data: string) {
          if (client.readyState === client.OPEN) client.send(data);
        },
        onMessage(callback) {
          client.on("message", (data) => callback(String(data)));
        },
        onClose(callback) {
          client.on("close", () => callback());
        },
      });
      void client;
    });
  });

  server.on("close", () => {
    terminals?.dispose();
    ssh?.manager.dispose();
  });
  return server;
}

function readShellResize(data: string): { cols: number; rows: number } | null {
  if (!data.startsWith("{")) return null;
  try {
    const value = JSON.parse(data) as { type?: string; cols?: unknown; rows?: unknown };
    if (
      value.type === "resize" &&
      typeof value.cols === "number" &&
      typeof value.rows === "number" &&
      value.cols >= 2 &&
      value.cols <= 500 &&
      value.rows >= 2 &&
      value.rows <= 200
    ) {
      return { cols: value.cols, rows: value.rows };
    }
  } catch {
    return null;
  }
  return null;
}

function sameMessage(a: TranscriptMessage, b: TranscriptMessage): boolean {
  if (a === b) return true;
  if (a.id !== b.id || a.role !== b.role || a.text !== b.text) return false;
  // Steps change in place when their result lands, and rounds when their clock or tokens move.
  if (a.role !== "step" && a.role !== "turn") return true;
  return (
    a.tool === b.tool &&
    a.startedAt === b.startedAt &&
    a.endedAt === b.endedAt &&
    a.tokens === b.tokens &&
    JSON.stringify(a.result) === JSON.stringify(b.result)
  );
}

function sendJson(response: http.ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function readJson<T>(request: http.IncomingMessage, maxBytes = 1_000_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        tooBig = true;
        request.destroy();
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    request.on("end", () => {
      if (tooBig) {
        reject(new ApiError(400, "bad_request"));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as T);
      } catch {
        reject(new ApiError(400, "bad_request"));
      }
    });
    request.on("error", () => reject(new ApiError(400, "bad_request")));
  });
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

function serveStatic(pathname: string, response: http.ServerResponse) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.resolve(distDir, `.${requested}`);
  if (!filePath.startsWith(distDir) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    sendJson(response, 404, { error: "not_found" });
    return;
  }
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
  };
  const ext = path.extname(filePath);
  const headers: Record<string, string> = { "content-type": types[ext] ?? "application/octet-stream" };
  if (ext === ".html") headers["cache-control"] = "no-cache";
  response.writeHead(200, headers);
  createReadStream(filePath).pipe(response);
}

export type { WebSocket };
