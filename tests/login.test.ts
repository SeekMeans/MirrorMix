import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createSupervisor } from "../src/process/supervisor";
import { createApp, listenLocal } from "../src/server/app";
import { accessPasswordMatches, hashAccessPassword } from "../src/remote/tunnel";

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function gated(verify: (password: string) => Promise<boolean>, options: { ready?: () => boolean; needsLogin?: () => boolean } = { needsLogin: () => true }) {
  const root = mkdtempSync(path.join(tmpdir(), "aimiss-login-"));
  const supervisor = createSupervisor({
    bins: { claudeExe: "claude.exe", nodeExe: "node.exe", codexJs: "codex.js" },
    roots: { claudeProjectsDir: path.join(root, "projects"), codexSessionsDir: path.join(root, "sessions") },
    listProcesses: () => [],
    spawn: () => {
      throw new Error("not used");
    },
  });
  const server = createApp(supervisor, undefined, { verify, ...options });
  return server;
}

async function start(server: ReturnType<typeof createApp>) {
  await listenLocal(server, 0);
  const address = server.address() as AddressInfo;
  servers.push({
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  });
  return `http://127.0.0.1:${address.port}`;
}

function cookieFrom(response: Response): string {
  const header = response.headers.get("set-cookie") ?? "";
  const match = /mirrormix=([^;]+)/.exec(header);
  if (!match) throw new Error("missing cookie");
  return `mirrormix=${match[1]}`;
}

describe("access password", () => {
  it("keeps the catalog closed until the password checks out", async () => {
    const seen: string[] = [];
    const base = await start(
      gated(async (password) => {
        seen.push(password);
        return password === "right-secret";
      }),
    );

    const closed = await fetch(`${base}/api/catalog`);
    expect(closed.status).toBe(401);

    const anonymous = await fetch(`${base}/api/session`);
    expect(anonymous.status).toBe(200);
    expect(anonymous.headers.get("cache-control")).toBe("no-store");
    expect(await anonymous.json()).toMatchObject({ ok: true, authenticated: false, signedIn: false });

    const health = await fetch(`${base}/api/health`);
    expect(health.status).toBe(200);

    const empty = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "" }),
    });
    expect(empty.status).toBe(401);
    expect(seen).toEqual([]);

    const wrong = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "nope" }),
    });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("set-cookie")).toBeNull();

    const login = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "right-secret" }),
    });
    expect(login.status).toBe(200);
    const cookie = cookieFrom(login);
    expect(cookie).not.toContain("right-secret");
    const loggedIn = await fetch(`${base}/api/session`, { headers: { cookie } });
    expect(loggedIn.status).toBe(200);
    expect(await loggedIn.json()).toEqual({ ok: true, authenticated: true, signedIn: true });

    const opened = await fetch(`${base}/api/catalog`, { headers: { cookie } });
    expect(opened.status).toBe(200);

    const logout = await fetch(`${base}/api/logout`, { method: "POST", headers: { cookie } });
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
    const after = await fetch(`${base}/api/catalog`, { headers: { cookie } });
    expect(after.status).toBe(401);
    const loggedOut = await fetch(`${base}/api/session`, { headers: { cookie } });
    expect(loggedOut.status).toBe(200);
    expect(await loggedOut.json()).toMatchObject({ authenticated: false });

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(`${base.replace("http", "ws")}/api/live?tool=claude&id=missing`);
      socket.on("error", () => resolve());
      socket.on("open", () => reject(new Error("live socket opened without a login")));
    });
  });

  it("stops guessing after repeated failures", async () => {
    let calls = 0;
    const base = await start(
      gated(async () => {
        calls += 1;
        return false;
      }),
    );
    for (let i = 0; i < 8; i += 1) {
      const response = await fetch(`${base}/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "nope" }),
      });
      expect(response.status).toBe(401);
    }
    const blocked = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "nope" }),
    });
    expect(blocked.status).toBe(429);
    expect(calls).toBe(8);
  });

  it("opens on this PC without a password, and asks one through the public address", async () => {
    const base = await start(gated(async () => false, {}));
    const here = await fetch(`${base}/api/catalog`);
    expect(here.status).toBe(200);
    expect(await (await fetch(`${base}/api/session`)).json()).toEqual({ ok: true, authenticated: true });
    const outside = await fetch(`${base}/api/catalog`, { headers: { "x-forwarded-for": "203.0.113.9" } });
    expect(outside.status).toBe(401);
  });

  it("says when no access password is set yet", async () => {
    const base = await start(gated(async () => false, { needsLogin: () => true, ready: () => false }));
    expect(await (await fetch(`${base}/api/session`)).json()).toMatchObject({ authenticated: false, passwordSet: false });
    const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "anything" }) });
    expect(login.status).toBe(409);
  });

  it("keeps only a salted hash of the password", () => {
    const hash = hashAccessPassword("open-sesame");
    expect(hash).not.toContain("open-sesame");
    expect(hashAccessPassword("open-sesame")).not.toBe(hash);
    expect(accessPasswordMatches(hash, "open-sesame")).toBe(true);
    expect(accessPasswordMatches(hash, "open-sesam")).toBe(false);
    expect(accessPasswordMatches(undefined, "open-sesame")).toBe(false);
  });
});
