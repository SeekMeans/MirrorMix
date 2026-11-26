import { execFileSync, spawn as spawnProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

/**
 * Reaching this desk from outside: MirrorMix runs frpc, which keeps a tunnel open to the frps on your server.
 * Your server's nginx answers https://<subdomain>.<domain> and hands the traffic to frps, which passes it down
 * the tunnel to 127.0.0.1 here. Several PCs can share one server, each under its own subdomain.
 */
export interface RemoteConfig {
  enabled: boolean;
  /** This PC's name under the server's domain. */
  subdomain: string;
}

/** The server every PC shares. Read from mirrormix.config.json, not set from the page. */
export interface RemoteServer {
  /** frps address: the server's public IP or name. */
  server: string;
  /** frps bindPort. */
  serverPort: number;
  /** The domain the server answers under (frps subDomainHost). Each PC is <subdomain>.<domain> on port 443. */
  domain: string;
  /** DNSMgr: where this PC applies for its address, learns when it is approved and fetches its connection token. */
  api: string;
}

/** Where an application for an address stands, as DNSMgr last said. */
export type ApplicationStatus = "pending" | "ready" | "rejected";

/** One application this PC sent for a subdomain. Kept on this PC as its 申请记录. */
export interface RemoteApplication {
  slug: string;
  status: ApplicationStatus;
  /** Why it was turned down. */
  message: string;
  /** When it was sent (ms since 1970). */
  submittedAt: number;
  /** When DNSMgr was last asked (ms since 1970). */
  checkedAt?: number;
  /** This PC is bound to this address now. */
  current?: boolean;
  /** Approved, and the connection token came with it: the record shows it (through the eye button) to keep safe. */
  hasToken?: boolean;
  /** Approved, but binding it to this PC did not work (another PC is connected to it, for one). */
  bindError?: string;
}

/** A record as kept on disk: the key this PC applied with and the token it got, both encrypted. Never sent to the page. */
interface StoredApplication extends RemoteApplication {
  /** Generated here when applying; DNSMgr keeps only its hash and hands the token to whoever shows it once approved. */
  sealedKey?: string;
  sealedToken?: string;
}

/** This PC's address: bound with its subdomain and connection token. */
export interface RemoteBinding {
  /** Bound: a token is saved and DNSMgr has not said it stopped working. */
  bound: boolean;
  slug: string;
  /** A WeChat account has scanned this PC's code; it opens this PC straight from the mini program. */
  wechat: boolean;
  nickname: string;
  /** When the WeChat account was bound (s since 1970). Changes when another account binds instead. */
  boundAt?: number;
  /** DNSMgr could not be reached, turned the last request down, or said the token no longer works. */
  error?: string;
}

/** The mini program code shown for 绑定微信. `image` is a PNG/JPEG as base64, empty when DNSMgr could not make one. */
export interface BindCode {
  image: string;
  ticket: string;
  expiresIn: number;
  imageError?: string;
}

export type RemoteState = "off" | "starting" | "connected" | "error";

export interface RemoteStatus {
  state: RemoteState;
  /** Why it is not connected, in plain words. */
  message: string;
  /** The address to open from outside, once a domain and subdomain are set. */
  url: string;
  /** When MirrorMix tries again on its own (ms since 1970), while it is not connected and a retry is waiting. */
  retryAt?: number;
}

export interface RemoteView extends RemoteConfig, RemoteServer {
  /** Where the server settings come from, for the page to point at. */
  configFile: string;
  /** A connection token is saved. It is only sent to the page when asked for (the eye button). */
  hasToken: boolean;
  /** An access password is set: what someone coming in through the public address signs in with. */
  hasAccessPassword: boolean;
  status: RemoteStatus;
  /** The address this PC is bound to. */
  binding: RemoteBinding;
  /** Applications sent from this PC, newest first. */
  applications: RemoteApplication[];
}

/** What the page may send. The token is only written when a new one is given. */
export interface RemoteUpdate extends Partial<RemoteConfig> {
  token?: string;
  /** A new access password. Only written when one is given. */
  accessPassword?: string;
}

interface Stored extends RemoteConfig {
  /** The token, encrypted for this Windows account. */
  sealedToken: string;
  /** The access password as "scrypt:<salt>:<hash>"; the password itself is never kept. */
  accessHash?: string;
  /** The WeChat account bound to the address, as DNSMgr last said. */
  wechat?: { bound: boolean; nickname: string; boundAt?: number };
  /** DNSMgr said the saved token no longer works (reset, bound by another PC, or the address taken back). */
  tokenDead?: string;
  /** Applications sent from this PC. */
  applications?: StoredApplication[];
  /** The frps this address was assigned to, when DNSMgr says one; otherwise the server from mirrormix.config.json. */
  assigned?: { server: string; serverPort: number };
}

/** What DNSMgr answered: HTTP status and the JSON body ({} when there was none). */
export interface ApiResponse {
  status: number;
  body: Record<string, unknown>;
}

async function postJson(url: string, body: unknown): Promise<ApiResponse> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  let parsed: unknown = {};
  try {
    parsed = await response.json();
  } catch {
    parsed = {};
  }
  return { status: response.status, body: parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {} };
}

export const ACCESS_PASSWORD_MIN = 6;
const ACCESS_PASSWORD_MAX = 256;

export function hashAccessPassword(password: string): string {
  const salt = randomBytes(16);
  return `scrypt:${salt.toString("base64")}:${scryptSync(password, salt, 32).toString("base64")}`;
}

export function accessPasswordMatches(hash: string | undefined, password: string): boolean {
  const [kind, salt, expected] = (hash ?? "").split(":");
  if (kind !== "scrypt" || !salt || !expected || !password || password.length > ACCESS_PASSWORD_MAX) return false;
  const want = Buffer.from(expected, "base64");
  const got = scryptSync(password, Buffer.from(salt, "base64"), want.length);
  return want.length > 0 && timingSafeEqual(want, got);
}

export interface FrpcProcess {
  onLine(callback: (line: string) => void): void;
  onExit(callback: (code: number | null) => void): void;
  kill(): void;
}

export interface TunnelDeps {
  /** Folder for remote.json and frpc's short-lived config. */
  dir: string;
  /** The port MirrorMix listens on here. */
  localPort: number;
  /** MirrorMix's preview listener, published on <subdomain>-preview when given. */
  previewPort?: number;
  /** The shared server. Defaults to DEFAULT_SERVER. */
  server?: RemoteServer;
  /** Shown on the page as where the server settings live. */
  configFile?: string;
  /** The frpc.exe shipped with MirrorMix and launched for this tunnel. */
  bundledFrpc?: string;
  spawn?: (file: string, args: string[], env: Record<string, string>) => FrpcProcess;
  seal?: (secret: string) => string;
  unseal?: (sealed: string) => string;
  /** Waits before starting frpc again after it stopped. */
  retryMs?: (attempt: number) => number;
  /** Talks to DNSMgr. Defaults to fetch. */
  post?: (url: string, body: unknown) => Promise<ApiResponse>;
  /** How long to wait before asking DNSMgr again: "pending" while an application is under review, "ready" while bound. 0 or less: not on its own. */
  pollMs?: (status: ApplicationStatus) => number;
}

export class RemoteError extends Error {
  /** `message` is DNSMgr's own words, when it gave some. */
  constructor(
    public code: string,
    message = "",
  ) {
    super(message || code);
  }
}

export const DEFAULT_SERVER: RemoteServer = { server: "seekmeans.cn", serverPort: 5000, domain: "mm.seekmeans.cn", api: "https://dns.seekmeans.cn" };
const API = /^https?:\/\/[a-z0-9.\-:[\]]{1,253}$/i;
const SUBDOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HOST = /^[a-z0-9.\-:[\]]{1,253}$/i;
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * Reads the "remote" part of mirrormix.config.json. Anything missing or malformed falls back
 * to DEFAULT_SERVER, and what was wrong is returned so startup can say so.
 */
export function loadRemoteServer(file: string): { server: RemoteServer; problems: string[] } {
  const server = { ...DEFAULT_SERVER };
  const problems: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") problems.push(`${file} is not valid JSON; using the defaults.`);
    return { server, problems };
  }
  const remote = (raw as { remote?: Record<string, unknown> } | null)?.remote ?? {};
  if (remote.server !== undefined) {
    const value = String(remote.server).trim();
    if (value && HOST.test(value)) server.server = value;
    else problems.push(`remote.server "${value}" is not a host name or IP.`);
  }
  if (remote.serverPort !== undefined) {
    const value = Number(remote.serverPort);
    if (Number.isInteger(value) && value >= 1 && value <= 65535) server.serverPort = value;
    else problems.push(`remote.serverPort ${String(remote.serverPort)} is not a port.`);
  }
  if (remote.domain !== undefined) {
    const value = String(remote.domain).trim().toLowerCase();
    if (DOMAIN.test(value)) server.domain = value;
    else problems.push(`remote.domain "${value}" is not a domain.`);
  }
  if (remote.api !== undefined) {
    const value = String(remote.api).trim().replace(/\/+$/, "");
    if (API.test(value)) server.api = value;
    else problems.push(`remote.api "${value}" is not an http(s) address like https://dns.seekmeans.cn.`);
  }
  return { server, problems };
}

/** This computer's name as a subdomain: lower case, anything else turned into dashes. */
export function defaultSubdomain(hostname = os.hostname()): string {
  const cleaned = hostname
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/, "");
  return cleaned || "pc";
}

function defaults(): RemoteConfig {
  return { enabled: false, subdomain: defaultSubdomain() };
}

export function publicUrl(subdomain: string, domain: string): string {
  return subdomain && domain ? `https://${subdomain}.${domain}` : "";
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** The subdomain local web pages are shown on, next to MirrorMix's own. Null when the name would be too long. */
export function previewSubdomain(subdomain: string): string | null {
  const name = `${subdomain}-preview`;
  return subdomain && name.length <= 63 ? name : null;
}

/**
 * The frpc config, token included. Each PC logs in as its own frp user: the user is the subdomain
 * and the token is the one DNSMgr issued when the address this PC applied for was approved.
 * The server's auth plugin checks the pair and only lets this user register <subdomain> and
 * <subdomain>-preview. frpc 0.61 sent a wrong token when it was given as an {{ .Envs.X }} template,
 * so the token is written in plain; the file only lives until frpc has read it.
 */
export function frpcConfig(config: RemoteConfig & Omit<RemoteServer, "api">, localPort: number, token: string, previewPort?: number): string {
  const preview = previewPort ? previewSubdomain(config.subdomain) : null;
  return [
    `serverAddr = ${tomlString(config.server)}`,
    `serverPort = ${config.serverPort}`,
    `user = ${tomlString(config.subdomain)}`,
    `metadatas.token = ${tomlString(token)}`,
    // Keep trying when the server is unreachable instead of quitting on the first failure.
    `loginFailExit = false`,
    `log.to = "console"`,
    `log.level = "info"`,
    `log.disablePrintColor = true`,
    ``,
    `[[proxies]]`,
    `name = ${tomlString(`mirrormix-${config.subdomain}`)}`,
    `type = "http"`,
    `localIP = "127.0.0.1"`,
    `localPort = ${localPort}`,
    `subdomain = ${tomlString(config.subdomain)}`,
    ``,
    // Pages running on this PC (a dev server), relayed by MirrorMix's preview listener at the root of their own address.
    ...(preview
      ? [
          `[[proxies]]`,
          `name = ${tomlString(`mirrormix-${preview}`)}`,
          `type = "http"`,
          `localIP = "127.0.0.1"`,
          `localPort = ${previewPort}`,
          `subdomain = ${tomlString(preview)}`,
          ``,
        ]
      : []),
  ].join("\n");
}

/** Turns one line of frpc output into a change of state, when it says something that matters. */
export function readFrpcLine(line: string): { state: RemoteState; message: string } | null {
  const text = line.trim();
  if (!text) return null;
  if (/start proxy success/i.test(text)) return { state: "connected", message: "" };
  if (/not granted/i.test(text)) {
    return { state: "error", message: "这个子域名没有分配给这台电脑的连接口令，正在向服务器重新取口令。" };
  }
  if (/token|authorization/i.test(text) && /(fail|invalid|mismatch|error)/i.test(text)) {
    return { state: "error", message: "服务器拒绝了连接口令，可能被管理员重置或收回了。正在向服务器重新取口令。" };
  }
  // frps still has this proxy from another connection: another computer using the same subdomain, or an old link
  // the server has not noticed is gone. frpc keeps trying, so it connects by itself once that one is released.
  if (/proxy \[[^\]]*\] already exists/i.test(text)) {
    return {
      state: "error",
      message: "这个子域名正被另一条连接占用：可能是另一台电脑上的 MirrorMix 也用了这个子域名，也可能是服务器上还挂着一条没断开的旧连接。关掉另一台电脑的外网访问，或者等几分钟，这里会自动连上；一直不行就重启服务器上的 frps。",
    };
  }
  if (/subdomain/i.test(text) && /(used|exist|conflict)/i.test(text)) {
    return { state: "error", message: "这个子域名已经被另一台电脑占用。换一个子域名。" };
  }
  if (/subdomain/i.test(text) && /(not support|subDomainHost|invalid)/i.test(text)) {
    return { state: "error", message: "服务器没有开启子域名转发。检查 frps.toml 里的 subDomainHost 和 vhostHTTPPort。" };
  }
  if (/(connection refused|i\/o timeout|no such host|connect: |dial tcp)/i.test(text)) {
    return { state: "error", message: "连不上服务器。检查服务器地址、端口，以及服务器的安全组是否放行了这个端口。" };
  }
  if (/login to (the )?server success/i.test(text)) return { state: "starting", message: "" };
  if (/start proxy error|login to (the )?server fail/i.test(text)) {
    return { state: "error", message: text.replace(/^.*?\]\s*/, "").slice(0, 200) };
  }
  return null;
}

/** DPAPI: the token can only be read back by this Windows account on this machine. */
function runPowerShell(script: string, input: string): string {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, MIRRORMIX_SECRET: input },
  }).trim();
}

function dpapiSeal(secret: string): string {
  if (process.platform !== "win32") return Buffer.from(secret, "utf8").toString("base64");
  return runPowerShell(
    "Add-Type -AssemblyName System.Security; $b=[Text.Encoding]::UTF8.GetBytes($env:MIRRORMIX_SECRET); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'))",
    secret,
  );
}

function dpapiUnseal(sealed: string): string {
  if (process.platform !== "win32") return Buffer.from(sealed, "base64").toString("utf8");
  // The bytes come back as base64: PowerShell would print text in the console's code page and mangle anything non-ASCII.
  const bytes = runPowerShell(
    "Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String($env:MIRRORMIX_SECRET); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))",
    sealed,
  );
  return Buffer.from(bytes, "base64").toString("utf8");
}

function realSpawn(file: string, args: string[], env: Record<string, string>): FrpcProcess {
  const child = spawnProcess(file, args, { env: { ...process.env, ...env }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const listeners: Array<(line: string) => void> = [];
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on("line", (line) => listeners.forEach((listener) => listener(line)));
  }
  return {
    onLine: (callback) => void listeners.push(callback),
    onExit: (callback) => {
      child.on("exit", (code) => callback(code));
      child.on("error", () => callback(-1));
    },
    kill: () => {
      child.kill();
    },
  };
}

export interface Tunnel {
  view(): RemoteView;
  update(change: RemoteUpdate): RemoteView;
  /** Connects again at once, without waiting for the next automatic try. */
  retryNow(): RemoteView;
  /** The public address this PC answers under while the tunnel is on, so the page served there is let in. */
  origin(): string | null;
  /** Where local pages are shown through the tunnel, while it is on. */
  previewOrigin(): string | null;
  /** The saved connection token in plain text, or null when none is saved or it cannot be read.
   * With a subdomain: the token kept in that application record. */
  token(slug?: string): string | null;
  /** Whether an access password is set. */
  hasAccessPassword(): boolean;
  /** Whether this is the access password. False while none is set. */
  checkAccess(password: string): boolean;
  /** Applies to DNSMgr for <subdomain>.<domain>; the subdomain is the one key. The application shows in this PC's records. */
  apply(subdomain: string): Promise<RemoteView>;
  /** Binds this PC to an approved address with its subdomain and connection token; DNSMgr refuses while another PC is connected to it. */
  bind(subdomain: string, token: string): Promise<RemoteView>;
  /** Asks DNSMgr how the applications under review and this PC's address stand now. */
  refresh(): Promise<RemoteView>;
  /** Forgets remote access on this PC: the tunnel stops, and the address, token and access password are cleared. */
  reset(): RemoteView;
  /** A fresh mini program code that binds a WeChat account to this PC's address when scanned. */
  bindCode(): Promise<BindCode>;
  dispose(): void;
}

export function createTunnel(deps: TunnelDeps): Tunnel {
  const file = path.join(deps.dir, "remote.json");
  /** frpc's config holds the token, so each run gets its own file, removed as soon as frpc has read it. */
  const RUN_FILE = /^frpc(-run-.+)?\.toml$/;
  const removeFile = (target: string) => {
    try {
      unlinkSync(target);
    } catch {
      /* already gone */
    }
  };
  // Left behind by a run that ended without cleaning up (or the older frpc.toml).
  try {
    for (const name of readdirSync(deps.dir)) if (RUN_FILE.test(name)) removeFile(path.join(deps.dir, name));
  } catch {
    /* folder not made yet */
  }
  const spawn = deps.spawn ?? realSpawn;
  const seal = deps.seal ?? dpapiSeal;
  const unseal = deps.unseal ?? dpapiUnseal;
  const retryMs = deps.retryMs ?? ((attempt: number) => Math.min(30_000, 2_000 * 2 ** attempt));
  const post = deps.post ?? postJson;
  // An application under review: every 15 s, so it binds soon after approval. Bound: every 2 min, to notice a token
  // that was reset, a WeChat account that was bound, or an address that was taken back.
  const pollMs = deps.pollMs ?? ((state: ApplicationStatus) => (state === "pending" ? 15_000 : state === "ready" ? 120_000 : 0));
  const shared: RemoteServer = deps.server ?? DEFAULT_SERVER;
  const bundledFrpc = () => {
    const file = deps.bundledFrpc;
    return file && existsSync(file) && statSync(file).isFile() ? file : null;
  };
  const urlOf = (config: Pick<RemoteConfig, "subdomain">) => publicUrl(config.subdomain, shared.domain);

  let stored: Stored = { ...defaults(), sealedToken: "" };
  try {
    const saved = JSON.parse(readFileSync(file, "utf8")) as Partial<Stored> & Record<string, unknown>;
    // Older saves carried the server, its port and the domain; those come from mirrormix.config.json now.
    const { domain: _d, publicPort: _p, server: _s, serverPort: _sp, frpcPath: _fp, ...rest } = saved;
    stored = { ...stored, ...rest };
  } catch {
    /* nothing saved yet */
  }

  let status: RemoteStatus = { state: "off", message: "", url: urlOf(stored) };
  let child: FrpcProcess | null = null;
  let retry: NodeJS.Timeout | null = null;
  let retryAt: number | undefined;
  let attempts = 0;
  let generation = 0;
  let forgetRunFile: (() => void) | null = null;

  const save = () => {
    if (!existsSync(deps.dir)) mkdirSync(deps.dir, { recursive: true });
    writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`);
  };

  const setStatus = (state: RemoteState, message = "") => {
    status = { state, message, url: urlOf(stored) };
  };

  /** Starts again after a wait that grows with each failure (2 s, 4 s, 8 s… up to 30 s). One wait at a time. */
  const scheduleRetry = (mine: number) => {
    if (retry) return;
    const wait = retryMs(attempts);
    attempts += 1;
    retryAt = Date.now() + wait;
    retry = setTimeout(() => {
      retry = null;
      retryAt = undefined;
      if (mine === generation) start();
    }, wait);
  };

  const stop = () => {
    generation += 1;
    if (retry) clearTimeout(retry);
    retry = null;
    retryAt = undefined;
    forgetRunFile?.();
    forgetRunFile = null;
    const running = child;
    child = null;
    try {
      running?.kill();
    } catch {
      /* already gone */
    }
  };

  const frpcBinary = (): string | null => bundledFrpc();

  const missing = (): string => {
    if (stored.tokenDead) return stored.tokenDead;
    if (!stored.sealedToken || !stored.subdomain) {
      if ((stored.applications ?? []).some((record) => record.status === "pending")) return "申请还在审核，通过后会自动绑定并连上。";
      return "还没有绑定地址。用域名标识和连接口令绑定。";
    }
    return "";
  };

  /** The frps to connect to: the one DNSMgr assigned, or the shared one from mirrormix.config.json. */
  const frpsServer = (): RemoteServer => (stored.assigned ? { ...shared, ...stored.assigned } : shared);

  const start = () => {
    stop();
    if (!stored.enabled) {
      setStatus("off");
      return;
    }
    const gap = missing();
    if (gap) {
      setStatus("error", gap);
      return;
    }
    const binary = frpcBinary();
    if (!binary) {
      setStatus("error", "MirrorMix 自带的 frpc.exe 不存在。请重新安装 MirrorMix。");
      return;
    }
    let token: string;
    try {
      token = unseal(stored.sealedToken);
    } catch {
      setStatus("error", "保存的连接口令无法读取，可能是在别的 Windows 账户下保存的。重新填一次口令。");
      return;
    }
    if (!existsSync(deps.dir)) mkdirSync(deps.dir, { recursive: true });
    const mine = ++generation;
    const runFile = path.join(deps.dir, `frpc-run-${process.pid}-${mine}.toml`);
    writeFileSync(runFile, frpcConfig({ ...stored, ...frpsServer() }, deps.localPort, token, deps.previewPort), { mode: 0o600 });
    // frpc reads its config once, before it prints anything. Remove the file at its first line,
    // when it stops, or after a while in case it never says a word.
    let removed = false;
    const forget = () => {
      if (removed) return;
      removed = true;
      clearTimeout(timer);
      removeFile(runFile);
    };
    const timer = setTimeout(forget, 15_000);
    forgetRunFile = forget;
    setStatus("starting");
    let proc: FrpcProcess;
    try {
      proc = spawn(binary, ["-c", runFile], {});
    } catch {
      forget();
      setStatus("error", "frpc 没有启动。");
      return;
    }
    child = proc;
    proc.onLine((line) => {
      forget();
      if (mine !== generation) return;
      const change = readFrpcLine(line);
      if (!change) return;
      if (change.state === "connected") {
        attempts = 0;
        if (retry) clearTimeout(retry);
        retry = null;
        retryAt = undefined;
      }
      // A login success says nothing new while already connected.
      if (change.state === "starting" && status.state === "connected") return;
      setStatus(change.state, change.message);
      if (change.state === "error") scheduleRetry(mine);
      // The token was reset or the address taken back: ask DNSMgr for the current one.
      if (change.state === "error" && /口令/.test(change.message)) tokenRejected();
    });
    proc.onExit(() => {
      forget();
      if (mine !== generation) return;
      child = null;
      if (!stored.enabled) {
        setStatus("off");
        return;
      }
      if (status.state !== "error") setStatus("error", "frpc 退出了，正在重新连接。");
      scheduleRetry(mine);
    });
  };

  const view = (): RemoteView => {
    const { sealedToken, accessHash, wechat, tokenDead, applications, assigned: _a, ...config } = stored;
    const bound = Boolean(sealedToken && stored.subdomain && !tokenDead);
    return {
      ...config,
      ...frpsServer(),
      configFile: deps.configFile ?? "",
      hasToken: Boolean(sealedToken),
      hasAccessPassword: Boolean(accessHash),
      status: { ...status, url: urlOf(stored), ...(retryAt && status.state !== "connected" ? { retryAt } : {}) },
      binding: {
        bound,
        slug: stored.subdomain,
        wechat: Boolean(bound && wechat?.bound),
        nickname: bound ? wechat?.nickname ?? "" : "",
        ...(bound && wechat?.boundAt ? { boundAt: wechat.boundAt } : {}),
        ...(tokenDead || apiError ? { error: tokenDead || apiError } : {}),
      },
      applications: (applications ?? []).map(({ sealedKey: _k, sealedToken: recordToken, ...record }) => {
        const current = bound && record.status === "ready" && record.slug === stored.subdomain;
        return { ...record, current, hasToken: record.status === "ready" && Boolean(recordToken || current) };
      }),
    };
  };

  // ---- Applying for an address and binding this PC to it, with DNSMgr ----

  let apiError = "";
  let poll: NodeJS.Timeout | null = null;
  /** Bumped when remote access is restored to defaults, so a request already in flight cannot write the old address back. */
  let epoch = 0;
  let lastTokenCheck = 0;
  let disposed = false;
  /** One DNSMgr conversation at a time, so a poll cannot undo a binding made a moment later. */
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };
  /** The token in plain text as last sealed or read, so a poll does not unseal it each time. */
  let plainToken: string | null = null;
  const currentToken = (): string | null => {
    if (plainToken !== null) return plainToken;
    if (!stored.sealedToken) return null;
    try {
      plainToken = unseal(stored.sealedToken);
    } catch {
      plainToken = null;
    }
    return plainToken;
  };

  const records = () => stored.applications ?? [];
  const bound = () => Boolean(stored.sealedToken && stored.subdomain && !stored.tokenDead);

  const schedulePoll = () => {
    if (poll) clearTimeout(poll);
    poll = null;
    if (disposed) return;
    const wait = records().some((record) => record.status === "pending") ? pollMs("pending") : bound() ? pollMs("ready") : 0;
    if (wait > 0) poll = setTimeout(() => void refresh().catch(() => undefined), wait);
  };

  const call = async (route: string, body: unknown): Promise<ApiResponse> => {
    let answer: ApiResponse;
    try {
      answer = await post(`${shared.api}${route}`, body);
    } catch {
      apiError = `连不上 ${shared.api}，稍后会再试。`;
      throw new RemoteError("api_unreachable", apiError);
    }
    // nginx sent the request to DNSMgr's admin page, which wants a sign-in: the server's nginx config predates these endpoints.
    if (answer.status === 401 && answer.body.error === "login_required") {
      apiError = `地址服务器还没开放外网访问的接口（${shared.api} 上的 nginx 配置是旧的），请服务器管理员按 DNSMgr 的说明更新 nginx 配置。`;
      throw new RemoteError("api_outdated", apiError);
    }
    return answer;
  };

  const text = (value: unknown) => (typeof value === "string" ? value : "");
  const cleanSlug = (value: string) => {
    const slug = String(value ?? "").trim().toLowerCase();
    if (!SUBDOMAIN.test(slug)) throw new RemoteError("bad_subdomain");
    return slug;
  };
  const cleanToken = (value: string) => {
    const token = String(value ?? "").trim();
    if (!token) throw new RemoteError("bad_token", "请填写连接口令。");
    if (token.length > 512) throw new RemoteError("bad_token");
    return token;
  };
  const opened = (sealed?: string): string | null => {
    if (!sealed) return null;
    try {
      return unseal(sealed);
    } catch {
      return null;
    }
  };

  /** Keeps a record of an application, newest first, one per subdomain, at most 20. */
  const keepRecord = (record: StoredApplication) => {
    const others = records().filter((item) => item.slug !== record.slug);
    stored = { ...stored, applications: [record, ...others].slice(0, 20) };
  };

  const setRecord = (slug: string, change: Partial<StoredApplication>) => {
    stored = {
      ...stored,
      applications: records().map((item) => (item.slug === slug ? { ...item, ...change } : item)),
    };
  };

  /** What DNSMgr says about this PC's address (bind or status): token, server, WeChat. Starts or restarts frpc when it changed. */
  const absorbPc = (body: Record<string, unknown>) => {
    const tunnel = body.tunnel as { user?: unknown; token?: unknown; server?: { host?: unknown; port?: unknown } } | undefined;
    const next: Stored = {
      ...stored,
      tokenDead: undefined,
      wechat: {
        bound: body.bound === true,
        nickname: text(body.nickname),
        ...(typeof body.bound_at === "number" ? { boundAt: body.bound_at } : {}),
      },
    };
    const slug = text(tunnel?.user) || text(body.slug);
    if (SUBDOMAIN.test(slug)) next.subdomain = slug;
    const token = text(tunnel?.token);
    if (token && token !== currentToken()) {
      next.sealedToken = seal(token);
      plainToken = token;
    }
    const host = text(tunnel?.server?.host);
    const port = Number(tunnel?.server?.port);
    if (tunnel) {
      next.assigned = host && HOST.test(host) && Number.isInteger(port) && port > 0 && port < 65536 ? { server: host, serverPort: port } : undefined;
    }
    const restart =
      (["subdomain", "sealedToken"] as const).some((key) => next[key] !== stored[key]) ||
      JSON.stringify(next.assigned) !== JSON.stringify(stored.assigned) ||
      Boolean(stored.tokenDead);
    stored = next;
    apiError = "";
    save();
    if (restart && stored.enabled) {
      attempts = 0;
      start();
    } else {
      status = { ...status, url: urlOf(stored) };
    }
  };

  /** DNSMgr says the token no longer works: stop, keep the subdomain so binding again is one click. */
  const tokenGone = (message: string) => {
    stored = { ...stored, tokenDead: message, sealedToken: "", wechat: undefined };
    plainToken = null;
    save();
    if (stored.enabled) start();
  };

  /** Inside `serial`: binds this PC with a subdomain and token. Returns DNSMgr's refusal, or "" when bound. */
  const bindNow = async (slug: string, token: string, mine: number): Promise<string> => {
    const answer = await call("/api/site/bind", { slug, token });
    if (mine !== epoch) return "";
    if (answer.status !== 200) {
      return text(answer.body.message) || `DNSMgr 返回了 ${answer.status}。`;
    }
    absorbPc(answer.body);
    return "";
  };

  const refresh = (): Promise<RemoteView> =>
    serial(async () => {
      const mine = epoch;
      const dropped = () => mine !== epoch;
      try {
        // Applications under review: ask how they stand, with the key they were sent with. Once approved the token comes
        // back: it is kept in the record for the person to save, and binds this PC at once when it has no address yet.
        for (const record of records().filter((item) => item.status === "pending" || (item.status === "ready" && (item.bindError || !item.sealedToken)))) {
          const key = opened(record.sealedKey);
          const answer = await call("/api/site/apply-status", key ? { slug: record.slug, key } : { slug: record.slug });
          if (dropped()) return view();
          if (answer.status === 404) {
            setRecord(record.slug, { status: "rejected", message: "服务器上没有这条申请了", checkedAt: Date.now() });
            continue;
          }
          if (answer.status !== 200) continue;
          const state = (["pending", "ready", "rejected"] as const).find((value) => value === answer.body.status) ?? "pending";
          const token = text(answer.body.token);
          setRecord(record.slug, {
            status: state,
            message: text(answer.body.message),
            checkedAt: Date.now(),
            ...(token ? { sealedToken: seal(token) } : {}),
            ...(state !== "ready" ? { sealedToken: undefined } : {}),
          });
          const kept = token || opened(records().find((item) => item.slug === record.slug)?.sealedToken);
          if (state === "ready" && kept && !bound()) {
            const refused = await bindNow(record.slug, kept, mine);
            if (dropped()) return view();
            setRecord(record.slug, refused ? { bindError: refused } : { bindError: undefined });
          }
        }
        save();
        // This PC's address: the WeChat account bound to it, and whether the token still works.
        const token = currentToken();
        if (bound() && token) {
          const answer = await call("/api/site/status", { slug: stored.subdomain, token });
          if (dropped()) return view();
          if (answer.status === 401) tokenGone(text(answer.body.message) || "连接口令已经失效。拿到新口令后重新绑定。");
          else if (answer.status === 200) absorbPc(answer.body);
          else apiError = text(answer.body.message) || `DNSMgr 返回了 ${answer.status}。`;
        }
        apiError = dropped() ? "" : apiError;
      } catch (error) {
        if (dropped()) {
          apiError = "";
          return view();
        }
        schedulePoll();
        throw error;
      }
      if (!dropped()) schedulePoll();
      return view();
    });

  const tokenRejected = () => {
    // frpc says so on every try; asking DNSMgr once every 30 s is enough.
    if (!stored.sealedToken || Date.now() - lastTokenCheck < 30_000) return;
    lastTokenCheck = Date.now();
    void refresh().catch(() => undefined);
  };

  const apply = (subdomain: string): Promise<RemoteView> =>
    serial(async () => {
      const mine = epoch;
      const slug = cleanSlug(subdomain);
      // This PC's own key for the application: DNSMgr keeps its hash and gives the token only to whoever shows it.
      const key = randomBytes(24).toString("base64url");
      let answer: ApiResponse;
      try {
        answer = await call("/api/site/apply", { slug, key });
      } catch (error) {
        if (mine !== epoch) {
          apiError = "";
          return view();
        }
        throw error;
      }
      if (mine !== epoch) return view();
      if (answer.status !== 200) {
        throw new RemoteError(text(answer.body.error) || "apply_failed", text(answer.body.message));
      }
      const state = (["pending", "ready", "rejected"] as const).find((value) => value === answer.body.status) ?? "pending";
      keepRecord({ slug, status: state, message: "", submittedAt: Date.now(), checkedAt: Date.now(), sealedKey: seal(key) });
      apiError = "";
      save();
      if (stored.enabled && !bound()) start();
      schedulePoll();
      return view();
    });

  const bind = (subdomain: string, tokenInput: string): Promise<RemoteView> =>
    serial(async () => {
      const mine = epoch;
      const slug = cleanSlug(subdomain);
      const token = cleanToken(tokenInput);
      let refused: string;
      try {
        refused = await bindNow(slug, token, mine);
      } catch (error) {
        if (mine !== epoch) {
          apiError = "";
          return view();
        }
        throw error;
      }
      if (mine !== epoch) return view();
      if (refused) throw new RemoteError("bind_refused", refused);
      if (records().some((item) => item.slug === slug)) {
        setRecord(slug, { status: "ready", bindError: undefined, checkedAt: Date.now(), sealedToken: seal(token) });
        save();
      }
      schedulePoll();
      return view();
    });

  const bindCode = (): Promise<BindCode> =>
    serial(async () => {
      const token = currentToken();
      if (!bound() || !token) throw new RemoteError("not_bound", "先用域名标识和连接口令绑定这台电脑，再绑定微信。");
      const answer = await call("/api/site/bind-code", { slug: stored.subdomain, token });
      if (answer.status === 401) {
        tokenGone(text(answer.body.message) || "连接口令已经失效。拿到新口令后重新绑定。");
        throw new RemoteError("token", stored.tokenDead ?? "");
      }
      if (answer.status !== 200 || typeof answer.body.ticket !== "string") {
        throw new RemoteError(text(answer.body.error) || "bind_failed", text(answer.body.message));
      }
      return {
        image: text(answer.body.image),
        ticket: answer.body.ticket,
        expiresIn: Number(answer.body.expires_in) || 600,
        ...(text(answer.body.image_error) ? { imageError: text(answer.body.image_error) } : {}),
      };
    });

  /** Stops the tunnel and writes remote.json back to a fresh install: off, this PC's name, no token or password. */
  const reset = (): RemoteView => {
    epoch += 1;
    stop();
    if (poll) clearTimeout(poll);
    poll = null;
    stored = { ...defaults(), sealedToken: "" };
    plainToken = null;
    apiError = "";
    save();
    setStatus("off");
    return view();
  };

  /** Tries again right away (the page's 重试 button), with the waits starting over. */
  const retryNow = (): RemoteView => {
    if (stored.enabled) {
      attempts = 0;
      start();
    }
    return view();
  };

  const update = (change: RemoteUpdate): RemoteView => {
    const next: Stored = { ...stored };
    if (change.subdomain !== undefined) {
      const subdomain = String(change.subdomain).trim().toLowerCase();
      if (subdomain && !SUBDOMAIN.test(subdomain)) throw new RemoteError("bad_subdomain");
      next.subdomain = subdomain;
    }
    if (typeof change.token === "string" && change.token.trim()) {
      if (change.token.length > 512) throw new RemoteError("bad_token");
      next.sealedToken = seal(change.token.trim());
      next.tokenDead = undefined;
      plainToken = null;
    }
    if (typeof change.accessPassword === "string" && change.accessPassword) {
      if (change.accessPassword.length < ACCESS_PASSWORD_MIN || change.accessPassword.length > ACCESS_PASSWORD_MAX) throw new RemoteError("bad_access_password");
      next.accessHash = hashAccessPassword(change.accessPassword);
    }
    if (change.enabled !== undefined) next.enabled = Boolean(change.enabled);
    // Switching on puts this PC on the internet: not without an access password to sign in with.
    if (next.enabled && !stored.enabled && !next.accessHash) throw new RemoteError("access_password_required");
    const restart =
      next.enabled !== stored.enabled ||
      (next.enabled &&
        (["subdomain", "sealedToken"] as const).some((key) => next[key] !== stored[key]));
    stored = next;
    save();
    if (restart) {
      attempts = 0;
      start();
    } else {
      status = { ...status, url: urlOf(stored) };
    }
    return view();
  };

  if (stored.enabled) start();
  // Catch up with DNSMgr once at startup: approved while MirrorMix was closed, a token reset, a WeChat account bound.
  if (records().some((record) => record.status === "pending") || (stored.subdomain && stored.sealedToken)) {
    poll = setTimeout(() => void refresh().catch(() => undefined), 1_000);
    poll.unref?.();
  }

  return {
    view,
    update,
    reset,
    retryNow,
    apply,
    bind,
    refresh,
    bindCode,
    origin: () => (stored.enabled ? urlOf(stored) || null : null),
    previewOrigin: () => {
      const name = stored.enabled && deps.previewPort ? previewSubdomain(stored.subdomain) : null;
      return name ? `https://${name}.${shared.domain}` : null;
    },
    hasAccessPassword: () => Boolean(stored.accessHash),
    checkAccess: (password) => accessPasswordMatches(stored.accessHash, password),
    token: (slug?: string) => {
      if (slug) {
        const record = records().find((item) => item.slug === slug && item.status === "ready");
        if (!record) return null;
        return opened(record.sealedToken) ?? (bound() && record.slug === stored.subdomain ? opened(stored.sealedToken) : null);
      }
      return opened(stored.sealedToken);
    },
    dispose: () => {
      disposed = true;
      if (poll) clearTimeout(poll);
      poll = null;
      stop();
    },
  };
}
