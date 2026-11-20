import { execFileSync, spawn as spawnProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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
}

export type RemoteState = "off" | "starting" | "connected" | "error";

export interface RemoteStatus {
  state: RemoteState;
  /** Why it is not connected, in plain words. */
  message: string;
  /** The address to open from outside, once a domain and subdomain are set. */
  url: string;
}

export interface RemoteView extends RemoteConfig, RemoteServer {
  /** Where the server settings come from, for the page to point at. */
  configFile: string;
  /** A connection token is saved. It is only sent to the page when asked for (the eye button). */
  hasToken: boolean;
  status: RemoteStatus;
}

/** What the page may send. The token is only written when a new one is given. */
export interface RemoteUpdate extends Partial<RemoteConfig> {
  token?: string;
}

interface Stored extends RemoteConfig {
  /** The token, encrypted for this Windows account. */
  sealedToken: string;
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
}

export class RemoteError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

export const DEFAULT_SERVER: RemoteServer = { server: "seekmeans.cn", serverPort: 5000, domain: "mm.seekmeans.cn" };
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
 * and the token is the one issued for it when the address was approved in the MirrorMix mini program.
 * The server's auth plugin checks the pair and only lets this user register <subdomain> and
 * <subdomain>-preview. frpc 0.61 sent a wrong token when it was given as an {{ .Envs.X }} template,
 * so the token is written in plain; the file only lives until frpc has read it.
 */
export function frpcConfig(config: RemoteConfig & RemoteServer, localPort: number, token: string, previewPort?: number): string {
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
    return { state: "error", message: "这个子域名没有分配给你的连接口令。子域名要和小程序里开通的地址一致。" };
  }
  if (/token|authorization/i.test(text) && /(fail|invalid|mismatch|error)/i.test(text)) {
    return { state: "error", message: "服务器拒绝了连接口令。检查子域名和连接口令是否和 MirrorMix 小程序里显示的一致。" };
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
  /** The public address this PC answers under while the tunnel is on, so the page served there is let in. */
  origin(): string | null;
  /** Where local pages are shown through the tunnel, while it is on. */
  previewOrigin(): string | null;
  /** The saved connection token in plain text, or null when none is saved or it cannot be read. */
  token(): string | null;
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

  const stop = () => {
    generation += 1;
    if (retry) clearTimeout(retry);
    retry = null;
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
    if (!stored.subdomain) return "还没有填子域名。";
    if (!stored.sealedToken) return "还没有填连接口令。";
    return "";
  };

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
    writeFileSync(runFile, frpcConfig({ ...stored, ...shared }, deps.localPort, token, deps.previewPort), { mode: 0o600 });
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
      if (change.state === "connected") attempts = 0;
      // A login success says nothing new while already connected.
      if (change.state === "starting" && status.state === "connected") return;
      setStatus(change.state, change.message);
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
      const wait = retryMs(attempts);
      attempts += 1;
      retry = setTimeout(() => {
        if (mine === generation) start();
      }, wait);
    });
  };

  const view = (): RemoteView => {
    const { sealedToken, ...config } = stored;
    return {
      ...config,
      ...shared,
      configFile: deps.configFile ?? "",
      hasToken: Boolean(sealedToken),
      status: { ...status, url: urlOf(stored) },
    };
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
    }
    if (change.enabled !== undefined) next.enabled = Boolean(change.enabled);
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

  return {
    view,
    update,
    origin: () => (stored.enabled ? urlOf(stored) || null : null),
    previewOrigin: () => {
      const name = stored.enabled && deps.previewPort ? previewSubdomain(stored.subdomain) : null;
      return name ? `https://${name}.${shared.domain}` : null;
    },
    token: () => {
      if (!stored.sealedToken) return null;
      try {
        return unseal(stored.sealedToken);
      } catch {
        return null;
      }
    },
    dispose: () => {
      stop();
    },
  };
}
