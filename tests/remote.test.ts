import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createSupervisor } from "../src/process/supervisor";
import {
  createTunnel,
  defaultSubdomain,
  frpcConfig,
  loadRemoteServer,
  publicUrl,
  readFrpcLine,
  type FrpcProcess,
  type RemoteConfig,
  type RemoteServer,
} from "../src/remote/tunnel";
import { createApp, listenLocal } from "../src/server/app";

/** A stand-in for frpc that records how it was started and lets a test speak for it. */
function fakeFrpc() {
  const runs: Array<{
    file: string;
    args: string[];
    env: Record<string, string>;
    say: (line: string) => void;
    exit: () => void;
    killed: boolean;
  }> = [];
  const spawn = (file: string, args: string[], env: Record<string, string>): FrpcProcess => {
    const lines: Array<(line: string) => void> = [];
    const exits: Array<(code: number | null) => void> = [];
    const run = {
      file,
      args,
      env,
      killed: false,
      say: (line: string) => lines.forEach((listener) => listener(line)),
      exit: () => exits.forEach((listener) => listener(1)),
    };
    runs.push(run);
    return {
      onLine: (callback) => void lines.push(callback),
      onExit: (callback) => void exits.push(callback),
      kill: () => {
        run.killed = true;
      },
    };
  };
  return { runs, spawn };
}

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "aimiss-remote-"));
  const frpc = path.join(dir, "frpc.exe");
  writeFileSync(frpc, "");
  const fake = fakeFrpc();
  const tunnel = createTunnel({
    dir,
    localPort: 4789,
    spawn: fake.spawn,
    bundledFrpc: frpc,
    seal: (secret) => `sealed:${secret}`,
    unseal: (sealed) => sealed.replace(/^sealed:/, ""),
    retryMs: () => 5,
  });
  return { dir, frpc, tunnel, runs: fake.runs };
}

const filled = () => ({
  subdomain: "office",
  token: "shared-secret",
  accessPassword: "secret1",
});

describe("frpc settings", () => {
  it("does not expose the server and bundled frpc implementation detail in the settings UI", () => {
    const source = readFileSync(path.join(process.cwd(), "client", "src", "Remote.tsx"), "utf8");
    expect(source).not.toContain("由 MirrorMix 内置 frpc.exe 自动连接");
    expect(source).not.toContain("connected by MirrorMix's built-in frpc.exe");
  });

  it("logs in as this PC's own frp user and writes one http proxy under its subdomain", () => {
    const config: RemoteConfig & RemoteServer = {
      enabled: true,
      api: "https://dns.seekmeans.cn",
      server: "1.2.3.4",
      serverPort: 7000,
      domain: "mm.seekmeans.cn",
      subdomain: "office",
    };
    const text = frpcConfig(config, 4789, 'se"cret');
    expect(text).toContain('serverAddr = "1.2.3.4"');
    expect(text).toContain('user = "office"');
    expect(text).toContain('metadatas.token = "se\\"cret"');
    expect(text).not.toContain("auth.token");
    expect(text).toContain('type = "http"');
    expect(text).toContain('localIP = "127.0.0.1"');
    expect(text).toContain("localPort = 4789");
    expect(text).toContain('subdomain = "office"');
    expect(publicUrl("office", "mm.seekmeans.cn")).toBe("https://office.mm.seekmeans.cn");
    expect(defaultSubdomain("CHENG_Song Song")).toBe("cheng-song-song");
  });

  it("takes the server from mirrormix.config.json and falls back to seekmeans.cn:5000", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "aimiss-config-"));
    expect(loadRemoteServer(path.join(dir, "none.json"))).toEqual({
      server: { server: "seekmeans.cn", serverPort: 5000, domain: "mm.seekmeans.cn", api: "https://dns.seekmeans.cn" },
      problems: [],
    });
    const good = path.join(dir, "good.json");
    writeFileSync(good, JSON.stringify({ remote: { server: "1.2.3.4", serverPort: 7000, domain: "mm.example.com", api: "https://dns.example.com/" } }));
    expect(loadRemoteServer(good).server).toEqual({ server: "1.2.3.4", serverPort: 7000, domain: "mm.example.com", api: "https://dns.example.com" });
    const bad = path.join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ remote: { server: 'x"y', serverPort: 70000, api: "ftp://x/y" } }));
    const loaded = loadRemoteServer(bad);
    expect(loaded.server).toEqual({ server: "seekmeans.cn", serverPort: 5000, domain: "mm.seekmeans.cn", api: "https://dns.seekmeans.cn" });
    expect(loaded.problems).toHaveLength(3);
  });

  it("reads frpc's own words into a state", () => {
    expect(readFrpcLine("[I] [proxy_manager.go:144] [mirrormix-office] start proxy success")?.state).toBe("connected");
    expect(readFrpcLine("[E] login to the server failed: authorization failed. With loginFailExit enabled")?.message).toMatch(/口令/);
    expect(readFrpcLine("[W] [mirrormix-office] start error: subdomain [office] is already used")?.message).toMatch(/占用/);
    expect(readFrpcLine("[E] login to the server failed: invalid user or token")?.message).toMatch(/重新取口令/);
    expect(readFrpcLine("[W] [office.mirrormix-home] start error: subdomain not granted to this user")?.message).toMatch(/没有分配/);
    expect(readFrpcLine("[W] connect to server error: dial tcp 1.2.3.4:7000: connectex: No connection could be made")?.message).toMatch(/连不上/);
    // Seen for real: login works, but frps still holds the proxy from another connection.
    expect(
      readFrpcLine("2026-11-21 22:09:13.739 [W] [client/control.go:166] [fb40a2fad6669b94] [chengsongsong.mirrormix-chengsongsong] start error: proxy [chengsongsong.mirrormix-chengsongsong] already exists"),
    ).toMatchObject({ state: "error", message: expect.stringMatching(/另一条连接占用/) });
    expect(readFrpcLine("[I] some unrelated line")).toBeNull();
  });
});

describe("tunnel", () => {
  it("starts the bundled frpc without asking the user for a path", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "aimiss-bundled-run-"));
    const bundled = path.join(dir, "frpc.exe");
    writeFileSync(bundled, "MZ-fake-frpc");
    const fake = fakeFrpc();
    const tunnel = createTunnel({
      dir,
      localPort: 4789,
      bundledFrpc: bundled,
      spawn: fake.spawn,
      seal: (secret) => `sealed:${secret}`,
      unseal: (sealed) => sealed.replace(/^sealed:/, ""),
    });

    tunnel.update({ enabled: true, subdomain: "office", token: "shared-secret", accessPassword: "secret1" });

    expect(fake.runs).toHaveLength(1);
    expect(fake.runs[0].file).toBe(bundled);
    expect(tunnel.view()).not.toHaveProperty("frpcPath");
    tunnel.dispose();
  });

  it("starts frpc when switched on, removes its config with the token once frpc has read it, and stops it when switched off", () => {
    const { dir, frpc, tunnel, runs } = setup();
    expect(tunnel.view()).toMatchObject({ server: "seekmeans.cn", serverPort: 5000, status: { state: "off" } });
    expect(tunnel.token()).toBeNull();

    tunnel.update(filled());
    expect(runs).toHaveLength(0);
    const saved = readFileSync(path.join(dir, "remote.json"), "utf8");
    expect(saved).not.toContain('"shared-secret"');
    expect(saved).toContain("sealed:shared-secret");
    expect(tunnel.view()).toMatchObject({ hasToken: true, domain: "mm.seekmeans.cn", status: { url: "https://office.mm.seekmeans.cn" } });
    expect(JSON.stringify(tunnel.view())).not.toContain("shared-secret");
    expect(tunnel.token()).toBe("shared-secret");

    tunnel.update({ enabled: true, accessPassword: "secret1" });
    expect(runs).toHaveLength(1);
    expect(runs[0].file).toBe(frpc);
    expect(runs[0].env).toEqual({});
    const runFile = runs[0].args[1];
    const written = readFileSync(runFile, "utf8");
    expect(written).toContain('metadatas.token = "shared-secret"');
    expect(written).toContain('user = "office"');
    expect(written).toContain('serverAddr = "seekmeans.cn"');
    expect(written).toContain("serverPort = 5000");
    expect(tunnel.view().status.state).toBe("starting");
    expect(tunnel.origin()).toBe("https://office.mm.seekmeans.cn");

    runs[0].say("[I] [mirrormix-office] start proxy success");
    expect(tunnel.view().status.state).toBe("connected");
    expect(existsSync(runFile)).toBe(false);
    expect(readdirSync(dir).filter((name) => name.endsWith(".toml"))).toEqual([]);

    tunnel.update({ enabled: false });
    expect(runs[0].killed).toBe(true);
    expect(tunnel.view().status.state).toBe("off");
    expect(tunnel.origin()).toBeNull();
    tunnel.dispose();
  });

  it("restores remote access to a fresh install and ignores a reply already on the way", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "aimiss-remote-reset-"));
    const frpc = path.join(dir, "frpc.exe");
    writeFileSync(frpc, "");
    writeFileSync(
      path.join(dir, "remote.json"),
      JSON.stringify({
        enabled: true,
        subdomain: "office",
        sealedToken: "sealed:shared-secret",
        accessHash: "scrypt:salt:hash",
        wechat: { bound: true, nickname: "me" },
        applications: [{ slug: "office", status: "ready", message: "", submittedAt: 1 }],
      }),
    );
    let release: (value: { status: number; body: Record<string, unknown> }) => void = () => undefined;
    const pending = new Promise<{ status: number; body: Record<string, unknown> }>((resolve) => {
      release = resolve;
    });
    const fake = fakeFrpc();
    const tunnel = createTunnel({
      dir,
      localPort: 4789,
      bundledFrpc: frpc,
      spawn: fake.spawn,
      seal: (secret) => `sealed:${secret}`,
      unseal: (sealed) => sealed.replace(/^sealed:/, ""),
      post: () => pending,
    });
    expect(tunnel.view()).toMatchObject({ enabled: true, hasToken: true, hasAccessPassword: true, subdomain: "office" });
    const refresh = tunnel.refresh();
    const restored = tunnel.reset();
    release({
      status: 200,
      body: { status: "ready", slug: "office", tunnel: { user: "office", token: "shared-secret" } },
    });
    await refresh;

    expect(restored).toMatchObject({
      enabled: false,
      subdomain: defaultSubdomain(),
      hasToken: false,
      hasAccessPassword: false,
      status: { state: "off" },
      binding: { bound: false, wechat: false },
      applications: [],
    });
    expect(tunnel.token()).toBeNull();
    expect(tunnel.checkAccess("secret1")).toBe(false);
    expect(tunnel.origin()).toBeNull();
    expect(fake.runs.map((run) => run.killed)).toEqual([true]);
    expect(JSON.parse(readFileSync(path.join(dir, "remote.json"), "utf8"))).toEqual({
      enabled: false,
      subdomain: defaultSubdomain(),
      sealedToken: "",
    });
    expect(tunnel.view().hasToken).toBe(false);
    tunnel.dispose();
  });

  it("says what is missing instead of starting, and starts again after frpc stops", async () => {
    const { tunnel, runs } = setup();
    tunnel.update({ enabled: true, accessPassword: "secret1" });
    expect(runs).toHaveLength(0);
    expect(tunnel.view().status).toMatchObject({ state: "error", message: "还没有绑定地址。用域名标识和连接口令绑定。" });

    tunnel.update(filled());
    expect(runs).toHaveLength(1);
    runs[0].exit();
    expect(tunnel.view().status.state).toBe("error");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(runs).toHaveLength(2);
    tunnel.dispose();
  });

  it("starts frpc afresh when it keeps running but is stuck on an error, and says when it will", async () => {
    const { tunnel, runs } = setup();
    tunnel.update({ ...filled(), enabled: true });
    expect(runs).toHaveLength(1);
    // frpc stays up but its proxy was refused; it will not register again by itself.
    runs[0].say("[W] [mirrormix-office] start error: subdomain [office] is already used");
    const stuck = tunnel.view().status;
    expect(stuck.state).toBe("error");
    expect(stuck.retryAt).toBeGreaterThan(Date.now() - 1);
    // More error lines while waiting do not stack up more retries.
    runs[0].say("[W] connect to server error: dial tcp: connectex");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(runs).toHaveLength(2);
    expect(runs[0].killed).toBe(true);
    // Once connected there is nothing to retry.
    runs[1].say("[I] [mirrormix-office] start proxy success");
    expect(tunnel.view().status).toMatchObject({ state: "connected" });
    expect(tunnel.view().status.retryAt).toBeUndefined();
    tunnel.dispose();
  });

  it("connects again at once when asked, instead of waiting for the next try", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "aimiss-remote-retry-"));
    const frpc = path.join(dir, "frpc.exe");
    writeFileSync(frpc, "");
    const fake = fakeFrpc();
    const tunnel = createTunnel({
      dir,
      localPort: 4789,
      spawn: fake.spawn,
      bundledFrpc: frpc,
      seal: (secret) => `sealed:${secret}`,
      unseal: (sealed) => sealed.replace(/^sealed:/, ""),
      // A long wait, so only the button can bring the next try.
      retryMs: () => 60_000,
    });
    tunnel.update({ ...filled(), enabled: true });
    fake.runs[0].say("[W] connect to server error: dial tcp 1.2.3.4:7000: connectex: No connection could be made");
    expect(tunnel.view().status.retryAt).toBeGreaterThan(Date.now() + 30_000);
    const view = tunnel.retryNow();
    expect(fake.runs).toHaveLength(2);
    expect(fake.runs[0].killed).toBe(true);
    expect(view.status.state).toBe("starting");
    expect(view.status.retryAt).toBeUndefined();
    tunnel.dispose();
  });

  it("refuses values that would make a broken config", () => {
    const { tunnel } = setup();
    expect(() => tunnel.update({ subdomain: "Office PC" })).toThrow("bad_subdomain");
    tunnel.dispose();
  });
});

describe("remote endpoint", () => {
  const servers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((close) => close()));
  });

  it("serves the settings without the token, and lets the public address open live connections once on", async () => {
    const { tunnel } = setup();
    const root = mkdtempSync(path.join(tmpdir(), "aimiss-remote-app-"));
    const supervisor = createSupervisor({
      bins: { claudeExe: "claude.exe", nodeExe: "node.exe", codexJs: "codex.js" },
      roots: { claudeProjectsDir: path.join(root, "projects"), codexSessionsDir: path.join(root, "sessions") },
      listProcesses: () => [],
      spawn: () => {
        throw new Error("not used");
      },
    });
    const server = createApp(supervisor, undefined, undefined, undefined, tunnel);
    await listenLocal(server, 0);
    servers.push(() => new Promise((resolve) => server.close(() => resolve())));
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    const put = (body: unknown, origin = base) =>
      fetch(`${base}/api/remote`, {
        method: "PUT",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify(body),
      });

    const bad = await put({ subdomain: "No Spaces" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "bad_subdomain" });
    expect((await put({ enabled: true }, "https://evil.example")).status).toBe(403);

    const saved = (await (await put({ ...filled(), enabled: true })).json()) as Record<string, unknown>;
    expect(saved).toMatchObject({ enabled: true, hasToken: true, subdomain: "office" });
    expect(JSON.stringify(saved)).not.toContain("shared-secret");
    expect(JSON.stringify(await (await fetch(`${base}/api/remote`)).json())).not.toContain("shared-secret");
    // Only the eye button asks for it.
    const revealed = await fetch(`${base}/api/remote/token`);
    expect(revealed.headers.get("cache-control")).toBe("no-store");
    expect(await revealed.json()).toEqual({ token: "shared-secret" });

    // The public page reaches this server through nginx and frp; its address is accepted while the tunnel is on.
    const opened = await new Promise<number>((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/api/live?tool=claude&id=none`, {
        headers: { origin: "https://office.mm.seekmeans.cn" },
      });
      socket.on("open", () => {
        socket.close();
        resolve(101);
      });
      socket.on("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
    });
    expect(opened).toBe(101);
    // No frpc.exe shipped with this tunnel: nothing to download.
    expect((await fetch(`${base}/api/remote/frpc`)).status).toBe(404);
    tunnel.dispose();
    supervisor.dispose();
  });

});
