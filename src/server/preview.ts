import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, createReadStream, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { MARKDOWN_FILE, markdownPage, markdownTitle } from "./markdownPage";
import http from "node:http";
import net from "node:net";
import path from "node:path";

/**
 * Shows a web page running on this PC (a dev server on localhost:5173, say) in the browser that MirrorMix is open in.
 *
 * It is a separate listener rather than a path under MirrorMix, because such pages load their files from "/":
 * under a prefix like /preview/5173/ every one of those would miss. Here the page sits at the root of its own address.
 * Locally that is http://127.0.0.1:<preview port>; through the tunnel it is its own subdomain.
 *
 * It only ever forwards to 127.0.0.1, so it cannot be used to reach other machines. A browser gets in with a
 * one-time ticket that the signed-in MirrorMix page asks for; the ticket becomes a cookie that also says which port.
 */

/** What one browser is let in to see: a local web server, or the files in one folder (generated HTML and what it links to). */
export type PreviewTarget = { port: number } | { root: string; entry: string };

export interface PreviewDeps {
  port: number;
  /** Ports that are not offered as pages: MirrorMix itself and this listener. */
  blocked: number[];
}

const TICKET_MS = 60_000;
const PASS_MS = 12 * 3_600_000;
const COOKIE = "mm_preview";
const ENTER = "/__mirrormix/enter";

export function previewPortAllowed(port: number, blocked: number[]): boolean {
  return Number.isInteger(port) && port >= 1024 && port <= 65535 && !blocked.includes(port);
}

function readCookie(header: string | undefined, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

/** The cookie header without ours, so the page behind never sees the pass. */
function withoutOurCookie(header: string | string[] | undefined): string | undefined {
  const text = Array.isArray(header) ? header.join("; ") : header;
  if (!text) return undefined;
  const kept = text
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith(`${COOKIE}=`));
  return kept.length ? kept.join("; ") : undefined;
}

function overHttps(request: http.IncomingMessage): boolean {
  const proto = request.headers["x-forwarded-proto"];
  return (Array.isArray(proto) ? proto[0] : proto)?.split(",")[0]?.trim().toLowerCase() === "https";
}

/** "http://localhost:5173/x" from the page behind becomes "/x", so a redirect stays on this address. */
export function localRedirect(location: string, port: number): string {
  const match = location.match(/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d+)(\/.*)?$/i);
  if (match && Number(match[1]) === port) return match[2] || "/";
  return location;
}

function page(response: http.ServerResponse, status: number, title: string, text: string) {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
      `<body style="font:15px/1.6 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px;color:#22313a">` +
      `<h1 style="font-size:20px">${title}</h1><p>${text}</p></body>`,
  );
}

export function createPreview(deps: PreviewDeps) {
  const tickets = new Map<string, { target: PreviewTarget; at: number }>();
  const passes = new Map<string, { target: PreviewTarget; at: number }>();

  const sweep = () => {
    const now = Date.now();
    for (const [key, item] of tickets) if (now - item.at > TICKET_MS) tickets.delete(key);
    for (const [key, item] of passes) if (now - item.at > PASS_MS) passes.delete(key);
  };

  /** A ticket for one browser to start viewing a port or a folder. Used once, good for a minute. */
  const issue = (target: number | PreviewTarget): string => {
    sweep();
    const ticket = randomBytes(24).toString("base64url");
    tickets.set(ticket, { target: typeof target === "number" ? { port: target } : target, at: Date.now() });
    return `${ENTER}?ticket=${ticket}`;
  };

  const passOf = (request: http.IncomingMessage) => {
    const key = readCookie(request.headers.cookie, COOKIE);
    const pass = key ? passes.get(key) : undefined;
    if (!pass || Date.now() - pass.at > PASS_MS) return null;
    return pass;
  };

  const upstreamHeaders = (request: http.IncomingMessage, port: number) => {
    const headers: http.OutgoingHttpHeaders = { ...request.headers };
    // Dev servers refuse hosts they do not know (Vite's allowedHosts); to them this is a local visit.
    headers.host = `localhost:${port}`;
    if (headers.origin) headers.origin = `http://localhost:${port}`;
    if (headers.referer) headers.referer = String(headers.referer).replace(/^https?:\/\/[^/]+/, `http://localhost:${port}`);
    const cookie = withoutOurCookie(request.headers.cookie);
    if (cookie) headers.cookie = cookie;
    else delete headers.cookie;
    return headers;
  };

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://preview.local");
    if (url.pathname === ENTER) {
      sweep();
      const ticket = url.searchParams.get("ticket") ?? "";
      const found = tickets.get(ticket);
      tickets.delete(ticket);
      if (!found) return page(response, 403, "预览链接已失效", "这个链接只能用一次，并且一分钟内有效。回到 MirrorMix，再点一次浏览器图标。");
      const key = randomBytes(24).toString("base64url");
      passes.set(key, { target: found.target, at: Date.now() });
      response.writeHead(302, {
        location: "root" in found.target ? `/${found.target.entry.split("/").map(encodeURIComponent).join("/")}` : "/",
        "cache-control": "no-store",
        "set-cookie": `${COOKIE}=${key}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${PASS_MS / 1000}${overHttps(request) ? "; Secure" : ""}`,
      });
      response.end();
      return;
    }
    const found = passOf(request);
    if (!found) return page(response, 401, "需要从 MirrorMix 打开", "这个地址用来查看这台电脑上的网页。请在 MirrorMix 里点浏览器图标，选择要看的文件或端口。");
    if ("root" in found.target) return serveFile(found.target.root, url.pathname, request, response);
    const pass = { port: found.target.port };
    const upstream = http.request(
      { host: "127.0.0.1", port: pass.port, method: request.method, path: request.url, headers: upstreamHeaders(request, pass.port) },
      (answer) => {
        const headers = { ...answer.headers };
        if (typeof headers.location === "string") headers.location = localRedirect(headers.location, pass.port);
        response.writeHead(answer.statusCode ?? 502, headers);
        answer.pipe(response);
      },
    );
    upstream.on("error", () => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      page(response, 502, `localhost:${pass.port} 没有响应`, `这台电脑上 ${pass.port} 端口没有在运行网页，或者已经停了。启动它之后刷新这一页。`);
    });
    request.pipe(upstream);
  });

  // Hot reload and other live pages talk over WebSocket. The upgrade is passed through as raw bytes.
  server.on("upgrade", (request, socket, head) => {
    const found = passOf(request);
    if (!found || !("port" in found.target)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    const pass = { port: found.target.port };
    const target = net.connect(pass.port, "127.0.0.1", () => {
      const lines = [`${request.method} ${request.url} HTTP/1.1`];
      const headers = upstreamHeaders(request, pass.port);
      for (const [name, value] of Object.entries(headers)) {
        if (value === undefined) continue;
        for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`);
      }
      target.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length) target.write(head);
      socket.pipe(target).pipe(socket);
    });
    const stop = () => {
      target.destroy();
      socket.destroy();
    };
    target.on("error", stop);
    socket.on("error", stop);
    target.on("close", () => socket.destroy());
    socket.on("close", () => target.destroy());
  });

  return {
    server,
    issue,
    listen(host: string) {
      return new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(deps.port, host, () => {
          server.off("error", reject);
          resolve();
        });
      });
    },
    allowed: (port: number) => previewPortAllowed(port, deps.blocked),
  };
}

export type Preview = ReturnType<typeof createPreview>;

export const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".csv": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".wasm": "application/wasm",
};

/**
 * The file under `root` that a request path names, or null when it is outside the folder (by "..", or by a
 * link that points elsewhere) or not there. A folder stands for its index.html.
 */
export function fileInFolder(root: string, requestPath: string): string | null {
  let relative: string;
  try {
    relative = decodeURIComponent(requestPath);
  } catch {
    return null;
  }
  if (relative.includes("\0")) return null;
  let base: string;
  try {
    base = realpathSync(root);
  } catch {
    return null;
  }
  const wanted = path.resolve(base, `.${path.posix.normalize(`/${relative.replace(/\\/g, "/")}`)}`);
  let real: string;
  try {
    real = realpathSync(wanted);
  } catch {
    return null;
  }
  const inside = (file: string) => file === base || file.startsWith(base.endsWith(path.sep) ? base : `${base}${path.sep}`);
  if (!inside(real)) return null;
  try {
    if (statSync(real).isDirectory()) {
      const index = path.join(real, "index.html");
      return statSync(index).isFile() ? index : null;
    }
  } catch {
    return null;
  }
  return real;
}

function serveFile(root: string, requestPath: string, request: http.IncomingMessage, response: http.ServerResponse) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { allow: "GET, HEAD" });
    response.end();
    return;
  }
  const file = fileInFolder(root, requestPath);
  if (!file) return page(response, 404, "找不到这个文件", `文件夹里没有 ${requestPath.replace(/[<>&"]/g, "")}。它可能已经被移走或改了名。`);
  // A Markdown file is shown as a page to read. "?raw" gives the file itself.
  if (MARKDOWN_FILE.test(file) && !/[?&]raw(?:=|&|$)/.test(request.url ?? "")) {
    let html: string;
    try {
      html = markdownPage(readFileSync(file, "utf8"), path.basename(file));
    } catch {
      return page(response, 404, "找不到这个文件", "它可能刚被删掉。");
    }
    const body = Buffer.from(html, "utf8");
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": String(body.length),
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
    });
    response.end(request.method === "HEAD" ? undefined : body);
    return;
  }
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    return page(response, 404, "找不到这个文件", "它可能刚被删掉。");
  }
  response.writeHead(200, {
    "content-type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
    "content-length": String(size),
    // Generated files change as the AI keeps working; a reload shows the newest.
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(file).on("error", () => response.destroy()).pipe(response);
}

export interface HtmlFile {
  /** Relative to the session folder, with forward slashes. */
  path: string;
  title?: string;
  size: number;
  modifiedAt: string;
}

/** Folders that hold installed packages or tool caches, not anything the AI wrote for the person. */
const SKIP_DIRS = new Set(["node_modules", ".git", ".hg", ".svn", ".venv", "venv", "__pycache__", ".next", ".nuxt", ".cache", ".turbo", ".pnpm-store", "bower_components", "site-packages", ".idea", ".vs", "coverage"]);

/** Read only the start of listed pages; large generated reports must not slow down the menu. */
function htmlTitle(file: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const buffer = Buffer.alloc(64 * 1024);
    const html = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString("utf8")
      .replace(/<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "");
    const raw = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1];
    if (!raw) return undefined;
    const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
    const title = raw.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, code: string) => {
      if (!code.startsWith("#")) return entities[code.toLowerCase()] ?? entity;
      const point = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : "\uFFFD";
    }).replace(/\s+/g, " ").trim();
    return title.slice(0, 200) || undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The HTML files in a session folder, newest first: what was just generated comes at the top. */
export function htmlFilesIn(root: string, limit = 60, maxDepth = 6, maxEntries = 20_000): HtmlFile[] {
  const found: HtmlFile[] = [];
  let visited = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth || visited > maxEntries) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      visited += 1;
      if (visited > maxEntries) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name.toLowerCase())) walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || !/\.html?$/i.test(entry.name)) continue;
      try {
        const info = statSync(full);
        found.push({ path: path.relative(root, full).split(path.sep).join("/"), size: info.size, modifiedAt: info.mtime.toISOString() });
      } catch {
        /* removed while listing */
      }
    }
  };
  walk(root, 0);
  found.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1));
  return found.slice(0, limit).map((item) => {
    const title = htmlTitle(path.join(root, item.path));
    return title ? { ...item, title } : item;
  });
}

/** One picked HTML file of a folder, as the menu lists it; null when it is gone or would reach outside the folder. */
export function htmlFileAt(root: string, relative: string): HtmlFile | null {
  if (!/\.html?$/i.test(relative) && !MARKDOWN_FILE.test(relative)) return null;
  const full = fileInFolder(root, relative);
  if (!full) return null;
  try {
    const info = statSync(full);
    if (!info.isFile()) return null;
    const title = MARKDOWN_FILE.test(relative) ? markdownFileTitle(full) : htmlTitle(full);
    const item: HtmlFile = { path: relative, size: info.size, modifiedAt: info.mtime.toISOString() };
    return title ? { ...item, title } : item;
  } catch {
    return null;
  }
}

/** A Markdown file's first heading, read from its first few KB. */
function markdownFileTitle(file: string): string | undefined {
  try {
    const fd = openSync(file, "r");
    try {
      const buffer = Buffer.alloc(16_384);
      const read = readSync(fd, buffer, 0, buffer.length, 0);
      return markdownTitle(buffer.subarray(0, read).toString("utf8"));
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

export interface ListeningPort {
  port: number;
  /** The program listening, e.g. "node". */
  name: string;
}

/**
 * Programs that serve the pages people build: dev servers and app runtimes. Everything else listening on a PC
 * (chat apps, remote-desktop agents, proxies, system services) is left out of the list; its port can still be typed in.
 */
const SERVERS = /^(node|bun|deno|python\d*|pythonw|py|java|javaw|dotnet|php|php-cgi|ruby|go|air|uvicorn|gunicorn|hugo|nginx|httpd|caddy|iisexpress|w3wp|com\.docker\.backend|wslrelay|docker-proxy|vite|esbuild)$/i;

const PORT_QUERY = [
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  "$names=@{}; Get-Process | ForEach-Object { $names[$_.Id]=$_.ProcessName }; " +
    "Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | " +
    "Where-Object { $_.LocalAddress -in @('127.0.0.1','0.0.0.0','::','::1') } | " +
    "ForEach-Object { [string]$_.LocalPort + [char]9 + $names[[int]$_.OwningProcess] }",
];

/** Turns the listing into the ports worth offering: a program of the person's, a port a dev server would use. */
export function readListening(output: string, blocked: number[]): ListeningPort[] {
  const seen = new Map<number, string>();
  for (const line of output.split(/\r?\n/)) {
    const [portText, nameText = ""] = line.trim().split("\t");
    const port = Number(portText);
    const name = nameText.trim();
    if (!previewPortAllowed(port, blocked) || port >= 49152) continue;
    if (!SERVERS.test(name)) continue;
    if (!seen.has(port)) seen.set(port, name);
  }
  return [...seen].map(([port, name]) => ({ port, name })).sort((a, b) => a.port - b.port);
}

let portCache: { at: number; ports: ListeningPort[] } | null = null;

/** The local ports something is listening on, read at most every few seconds. */
export function listeningPorts(blocked: number[]): Promise<ListeningPort[]> {
  if (portCache && Date.now() - portCache.at < 4_000) return Promise.resolve(portCache.ports);
  return new Promise((resolve) => {
    execFile("powershell.exe", PORT_QUERY, { encoding: "utf8", windowsHide: true, timeout: 15_000 }, (error, stdout) => {
      const ports = error ? portCache?.ports ?? [] : readListening(stdout, blocked);
      portCache = { at: Date.now(), ports };
      resolve(ports);
    });
  });
}
