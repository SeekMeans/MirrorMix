import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSupervisor } from "../src/process/supervisor";
import { createTunnel, type ApiResponse, type FrpcProcess } from "../src/remote/tunnel";
import { createApp, listenLocal } from "../src/server/app";

/**
 * DNSMgr's /api/site/* endpoints, in memory. Apply with a subdomain and a key the PC makes up; once approved the token
 * goes to whoever shows that key. Binding takes the subdomain and token and never changes the token.
 */
function fakeDnsMgr() {
  type App = { slug: string; key: string; status: string; message: string; token: string; wechat: boolean; nickname: string; boundAt?: number };
  const apps: App[] = [];
  const connected = new Set<string>();
  const calls: Array<{ route: string; body: Record<string, unknown> }> = [];
  let down = false;
  let tokens = 0;
  const reply = (status: number, body: Record<string, unknown>): ApiResponse => ({ status, body });
  const pcView = (app: App) => ({
    slug: app.slug,
    status: app.status,
    url: `https://${app.slug}.mm.seekmeans.cn`,
    tunnel: { user: app.slug, token: app.token, server: { host: "hk.example.com", port: 7000 } },
    bound: app.wechat,
    nickname: app.nickname,
    bound_at: app.boundAt ?? null,
  });
  const post = async (url: string, raw: unknown): Promise<ApiResponse> => {
    const route = url.replace("https://dns.test", "");
    const body = raw as Record<string, unknown>;
    calls.push({ route, body });
    if (down) throw new Error("ECONNREFUSED");
    const slug = String(body.slug ?? "");
    const app = apps.find((item) => item.slug === slug);
    if (route === "/api/site/apply") {
      if (app && app.status !== "rejected") return reply(409, { error: "taken", message: `这个标识已被占用（${app.status === "pending" ? "审核中" : "已开通"}）` });
      if (app) Object.assign(app, { status: "pending", message: "", key: String(body.key ?? ""), token: "" });
      else apps.push({ slug, key: String(body.key ?? ""), status: "pending", message: "", token: "", wechat: false, nickname: "" });
      return reply(200, { slug, status: "pending" });
    }
    if (route === "/api/site/apply-status") {
      if (!app) return reply(404, { error: "missing" });
      const withToken = app.status === "ready" && app.key && body.key === app.key ? { token: app.token } : {};
      return reply(200, { slug, status: app.status, message: app.message, ...withToken });
    }
    if (route === "/api/site/bind") {
      if (!app) return reply(404, { error: "missing", message: "没有这个标识的申请" });
      if (app.status === "pending") return reply(409, { error: "pending", message: "这个地址还在审核，通过后再绑定" });
      if (!body.token || body.token !== app.token) return reply(401, { error: "token", message: "域名标识和连接口令对不上。口令被重置过的话，找管理员要新的" });
      if (connected.has(slug)) return reply(409, { error: "connected", message: "这个域名已经有电脑连着。先在那台电脑上关掉外网访问，过一分钟再绑定" });
      return reply(200, pcView(app));
    }
    if (!app || app.status !== "ready" || !app.token || app.token !== body.token) {
      return reply(401, { error: "token", message: "连接口令已经失效（被管理员重置，或地址被收回）。拿到新口令后重新绑定" });
    }
    if (route === "/api/site/status") return reply(200, pcView(app));
    if (route === "/api/site/bind-code") return reply(200, { ticket: "Abcdefgh23456789", expires_in: 600, page: "pages/home/home", image: "iVBORw0KGgo=" });
    return reply(404, { error: "not_found" });
  };
  const approve = (slug: string) => {
    for (const app of apps) if (app.slug === slug) Object.assign(app, { status: "ready", token: `tok-${++tokens}` });
  };
  const reset = (slug: string) => {
    for (const app of apps) if (app.slug === slug) app.token = `tok-${++tokens}`;
  };
  const tokenOf = (slug: string) => apps.find((app) => app.slug === slug)?.token ?? "";
  return { apps, calls, connected, post, approve, reset, tokenOf, setDown: (value: boolean) => void (down = value) };
}

function fakeFrpc() {
  const runs: Array<{ say: (line: string) => void; killed: boolean }> = [];
  const spawn = (): FrpcProcess => {
    const lines: Array<(line: string) => void> = [];
    const run = { killed: false, say: (line: string) => lines.forEach((listener) => listener(line)) };
    runs.push(run);
    return {
      onLine: (callback) => void lines.push(callback),
      onExit: () => undefined,
      kill: () => {
        run.killed = true;
      },
    };
  };
  return { runs, spawn };
}

function setup(dir = mkdtempSync(path.join(tmpdir(), "aimiss-apply-")), dns = fakeDnsMgr()) {
  const frpc = path.join(dir, "frpc.exe");
  writeFileSync(frpc, "");
  const fake = fakeFrpc();
  // frpc's config is removed as soon as frpc speaks; keep a copy of what it was started with.
  const configs: string[] = [];
  const tunnel = createTunnel({
    dir,
    localPort: 4789,
    server: { server: "seekmeans.cn", serverPort: 5000, domain: "mm.seekmeans.cn", api: "https://dns.test" },
    spawn: (_file, args) => {
      configs.push(readFileSync(args[1], "utf8"));
      return fake.spawn();
    },
    bundledFrpc: frpc,
    seal: (secret) => `sealed:${secret}`,
    unseal: (sealed) => sealed.replace(/^sealed:/, ""),
    retryMs: () => 60_000,
    post: dns.post,
    pollMs: () => 0,
  });
  return { dir, tunnel, dns, runs: fake.runs, configs };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("applying for an address", () => {
  it("applies with its own key, gets the token once approved, keeps it in the record and binds by itself", async () => {
    const { dir, tunnel, dns, runs, configs } = setup();
    tunnel.update({ enabled: true, accessPassword: "secret1" });
    expect(tunnel.view().status.message).toBe("还没有绑定地址。用域名标识和连接口令绑定。");

    await expect(tunnel.apply("No Spaces")).rejects.toMatchObject({ code: "bad_subdomain" });
    const applied = await tunnel.apply(" Office ");
    expect(applied.applications).toEqual([expect.objectContaining({ slug: "office", status: "pending", current: false, hasToken: false })]);
    expect(applied.status.message).toBe("申请还在审核，通过后会自动绑定并连上。");
    const sent = dns.calls[0].body;
    expect(sent.slug).toBe("office");
    expect(String(sent.key)).toMatch(/^[A-Za-z0-9_-]{24,}$/);
    // The key is kept sealed on disk and never shown to the page.
    expect(JSON.stringify(applied)).not.toContain(String(sent.key));
    expect(readFileSync(path.join(dir, "remote.json"), "utf8")).toContain(`sealed:${sent.key}`);

    await expect(tunnel.apply("office")).rejects.toMatchObject({ code: "taken", message: "这个标识已被占用（审核中）" });

    // Still under review: nothing to bind.
    expect((await tunnel.refresh()).binding.bound).toBe(false);
    expect(runs).toHaveLength(0);

    // Approved: the key fetches the token, which binds this PC and connects to the assigned server.
    dns.approve("office");
    const ready = await tunnel.refresh();
    expect(ready.binding).toMatchObject({ bound: true, slug: "office", wechat: false });
    expect(ready.applications[0]).toMatchObject({ status: "ready", current: true, hasToken: true });
    expect(ready).toMatchObject({ server: "hk.example.com", serverPort: 7000, subdomain: "office", hasToken: true });
    expect(runs).toHaveLength(1);
    expect(configs[0]).toContain('metadatas.token = "tok-1"');
    expect(dns.calls.find((call) => call.route === "/api/site/bind")?.body).toEqual({ slug: "office", token: "tok-1" });
    // The record's token comes through the eye button, never in the view.
    expect(tunnel.token("office")).toBe("tok-1");
    expect(JSON.stringify(ready)).not.toContain("tok-1");
    tunnel.dispose();
  });

  it("keeps the token in the record even when another computer is connected, so it can bind later", async () => {
    const { tunnel, dns } = setup();
    await tunnel.apply("office");
    dns.approve("office");
    dns.connected.add("office");
    const view = await tunnel.refresh();
    expect(view.binding.bound).toBe(false);
    expect(view.applications[0]).toMatchObject({ status: "ready", current: false, hasToken: true, bindError: expect.stringMatching(/已经有电脑连着/) });
    expect(tunnel.token("office")).toBe("tok-1");
    dns.connected.clear();
    expect((await tunnel.bind("office", tunnel.token("office")!)).binding.bound).toBe(true);
    tunnel.dispose();
  });

  it("shows a turned-down application with its reason, and applies again", async () => {
    const { tunnel, dns } = setup();
    await tunnel.apply("home");
    for (const app of dns.apps) Object.assign(app, { status: "rejected", message: "标识不合适" });
    const view = await tunnel.refresh();
    expect(view.applications[0]).toMatchObject({ status: "rejected", message: "标识不合适", hasToken: false });
    expect((await tunnel.apply("home")).applications[0]).toMatchObject({ slug: "home", status: "pending", message: "" });
    tunnel.dispose();
  });
});

describe("binding this computer", () => {
  it("binds with the subdomain and the token, and says why when DNSMgr refuses", async () => {
    const dns = fakeDnsMgr();
    const other = setup(undefined, dns);
    await other.tunnel.apply("office");
    other.tunnel.dispose();

    const { tunnel, runs } = setup(undefined, dns);
    tunnel.update({ enabled: true, accessPassword: "secret1" });
    await expect(tunnel.bind("office", "")).rejects.toMatchObject({ code: "bad_token", message: "请填写连接口令。" });
    await expect(tunnel.bind("office", "x")).rejects.toMatchObject({ code: "bind_refused", message: "这个地址还在审核，通过后再绑定" });
    dns.approve("office");
    await expect(tunnel.bind("office", "wrong")).rejects.toMatchObject({ message: expect.stringMatching(/对不上/) });
    await expect(tunnel.bind("nobody", "tok-1")).rejects.toMatchObject({ message: "没有这个标识的申请" });
    dns.connected.add("office");
    await expect(tunnel.bind("office", "tok-1")).rejects.toMatchObject({ message: expect.stringMatching(/已经有电脑连着/) });
    dns.connected.clear();

    const bound = await tunnel.bind("Office", " tok-1 ");
    expect(bound.binding).toMatchObject({ bound: true, slug: "office" });
    expect(runs).toHaveLength(1);
    // The token stays the same: the one the person keeps keeps working.
    expect(dns.tokenOf("office")).toBe("tok-1");
    expect(tunnel.token()).toBe("tok-1");
    // Applied from another computer: no record here.
    expect(bound.applications).toEqual([]);
    tunnel.dispose();
  });

  it("asks for the new token after the administrator resets it", async () => {
    const dns = fakeDnsMgr();
    const { tunnel, runs, configs } = setup(undefined, dns);
    tunnel.update({ enabled: true, accessPassword: "secret1" });
    await tunnel.apply("office");
    dns.approve("office");
    await tunnel.refresh();
    expect(runs).toHaveLength(1);

    dns.reset("office");
    runs[0].say("[E] login to the server failed: invalid user or token");
    await tick();
    await tick();
    const view = tunnel.view();
    expect(view.binding).toMatchObject({ bound: false, slug: "office", error: expect.stringMatching(/拿到新口令后重新绑定/) });
    expect(view.status.message).toMatch(/拿到新口令后重新绑定/);

    const again = await tunnel.bind("office", dns.tokenOf("office"));
    expect(again.binding.bound).toBe(true);
    expect(configs.at(-1)).toContain('metadatas.token = "tok-2"');
    tunnel.dispose();
  });

  it("makes a bind code with the token, and notices when a WeChat account binds", async () => {
    const { tunnel, dns } = setup();
    await expect(tunnel.bindCode()).rejects.toMatchObject({ code: "not_bound" });
    await tunnel.apply("office");
    dns.approve("office");
    await tunnel.refresh();
    expect(await tunnel.bindCode()).toEqual({ image: "iVBORw0KGgo=", ticket: "Abcdefgh23456789", expiresIn: 600 });
    expect(dns.calls.at(-1)).toEqual({ route: "/api/site/bind-code", body: { slug: "office", token: "tok-1" } });
    for (const app of dns.apps) Object.assign(app, { wechat: true, nickname: "阿松", boundAt: 1700000000 });
    expect((await tunnel.refresh()).binding).toMatchObject({ wechat: true, nickname: "阿松", boundAt: 1700000000 });
    tunnel.dispose();
  });

  it("works for a computer whose token was typed in by hand, and says when DNSMgr cannot be reached", async () => {
    const dns = fakeDnsMgr();
    const first = setup(undefined, dns);
    await first.tunnel.apply("office");
    dns.approve("office");
    first.tunnel.dispose();

    const dir = mkdtempSync(path.join(tmpdir(), "aimiss-hand-"));
    writeFileSync(path.join(dir, "remote.json"), JSON.stringify({ enabled: false, subdomain: "office", sealedToken: "sealed:tok-1" }));
    const { tunnel } = setup(dir, dns);
    expect(tunnel.view().binding).toMatchObject({ bound: true, slug: "office" });
    expect((await tunnel.bindCode()).ticket).toBe("Abcdefgh23456789");
    dns.setDown(true);
    await expect(tunnel.refresh()).rejects.toMatchObject({ code: "api_unreachable" });
    expect(tunnel.view().binding.error).toBe("连不上 https://dns.test，稍后会再试。");
    tunnel.dispose();
  });
});

describe("a server whose nginx predates these endpoints", () => {
  it("says the server's nginx needs updating instead of asking to sign in", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "aimiss-old-nginx-"));
    writeFileSync(path.join(dir, "frpc.exe"), "");
    const tunnel = createTunnel({
      dir,
      localPort: 4789,
      server: { server: "seekmeans.cn", serverPort: 5000, domain: "mm.seekmeans.cn", api: "https://dns.test" },
      bundledFrpc: path.join(dir, "frpc.exe"),
      seal: (secret) => `sealed:${secret}`,
      unseal: (sealed) => sealed.replace(/^sealed:/, ""),
      post: async () => ({ status: 401, body: { error: "login_required", message: "请先登录" } }),
      pollMs: () => 0,
    });
    await expect(tunnel.apply("office")).rejects.toMatchObject({ code: "api_outdated", message: expect.stringMatching(/nginx 配置是旧的/) });
    await expect(tunnel.bind("office", "tok")).rejects.toMatchObject({ code: "api_outdated" });
    tunnel.dispose();
  });
});

describe("remote access endpoints", () => {
  const servers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((close) => close()));
  });

  it("applies, binds, shows a record's token, and makes bind codes for the page, only from this desk", async () => {
    const { tunnel, dns } = setup();
    const root = mkdtempSync(path.join(tmpdir(), "aimiss-apply-app-"));
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
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (route: string, body?: unknown, origin = base) =>
      fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json", origin }, body: body === undefined ? undefined : JSON.stringify(body) });

    expect((await post("/api/remote/apply", { subdomain: "office" }, "https://evil.example")).status).toBe(403);
    const bad = await post("/api/remote/apply", { subdomain: "No Spaces" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "bad_subdomain" });

    const applied = (await (await post("/api/remote/apply", { subdomain: "office" })).json()) as { applications: unknown[] };
    expect(applied.applications).toHaveLength(1);
    const early = await post("/api/remote/bind", { subdomain: "office", token: "x" });
    expect(early.status).toBe(400);
    expect(await early.json()).toEqual({ error: "bind_refused", message: "这个地址还在审核，通过后再绑定" });

    dns.approve("office");
    const refreshed = (await (await post("/api/remote/refresh")).json()) as { binding: { bound: boolean }; applications: Array<{ hasToken: boolean }> };
    expect(refreshed.binding.bound).toBe(true);
    expect(refreshed.applications[0].hasToken).toBe(true);
    expect(JSON.stringify(refreshed)).not.toContain("tok-1");
    const shown = await fetch(`${base}/api/remote/token?slug=office`);
    expect(shown.headers.get("cache-control")).toBe("no-store");
    expect(await shown.json()).toEqual({ token: "tok-1" });

    const code = await post("/api/remote/bind-code");
    expect(code.headers.get("cache-control")).toBe("no-store");
    expect(await code.json()).toMatchObject({ ticket: "Abcdefgh23456789" });

    dns.setDown(true);
    expect((await post("/api/remote/refresh")).status).toBe(502);
    tunnel.dispose();
    supervisor.dispose();
  });
});

describe("switching on", () => {
  it("needs an access password, set before or in the same step", () => {
    const { tunnel, runs } = setup();
    expect(() => tunnel.update({ enabled: true })).toThrow(expect.objectContaining({ code: "access_password_required" }));
    expect(tunnel.view().enabled).toBe(false);
    expect(() => tunnel.update({ enabled: true, accessPassword: "short" })).toThrow(expect.objectContaining({ code: "bad_access_password" }));
    expect(tunnel.update({ enabled: true, accessPassword: "secret1" })).toMatchObject({ enabled: true, hasAccessPassword: true });
    // Off and on again: the password set before is enough.
    tunnel.update({ enabled: false });
    expect(tunnel.update({ enabled: true }).enabled).toBe(true);
    expect(runs).toHaveLength(0);
    tunnel.dispose();
  });
});
