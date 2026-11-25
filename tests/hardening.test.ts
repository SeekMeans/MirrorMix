import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createSupervisor } from "../src/process/supervisor";
import { createApp, listenLocal } from "../src/server/app";

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  delete process.env.MIRRORMIX_ALLOWED_ORIGINS;
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

/** A desk behind a login that accepts one test account. */
async function desk() {
  const root = mkdtempSync(path.join(tmpdir(), "aimiss-harden-"));
  const supervisor = createSupervisor({
    bins: { claudeExe: "claude.exe", nodeExe: "node.exe", codexJs: "codex.js" },
    roots: { claudeProjectsDir: path.join(root, "projects"), codexSessionsDir: path.join(root, "sessions") },
    listProcesses: () => [],
    spawn: () => {
      throw new Error("not used");
    },
  });
  const server = createApp(supervisor, undefined, { verify: async (pass) => pass === "test-pass", needsLogin: () => true });
  await listenLocal(server, 0);
  servers.push({ close: () => new Promise((resolve) => server.close(() => resolve())) });
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, port };
}

const login = (base: string, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ password: "test-pass" }),
  });

function cookieOf(response: Response): string {
  const match = /mirrormix=([^;]+)/.exec(response.headers.get("set-cookie") ?? "");
  if (!match) throw new Error("missing cookie");
  return `mirrormix=${match[1]}`;
}

/** Resolves with the HTTP status the upgrade got: 101 when the socket opened. */
function upgrade(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/live?tool=claude&id=none`, { headers });
    socket.on("open", () => {
      socket.close();
      resolve(101);
    });
    socket.on("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
    socket.on("error", () => resolve(0));
  });
}

describe("login cookie", () => {
  it("is marked Secure only when the browser came in over HTTPS", async () => {
    const { base, host } = await desk();
    const plain = await login(base, { origin: `http://${host}` });
    expect(plain.status).toBe(200);
    expect(plain.headers.get("set-cookie")).not.toMatch(/Secure/);

    // Behind nginx, Caddy, cloudflared or tailscale serve the proxy says the browser used HTTPS.
    const proxied = await login(base, { "x-forwarded-proto": "https", "x-forwarded-host": "mm.example.com", origin: "https://mm.example.com" });
    expect(proxied.status).toBe(200);
    expect(proxied.headers.get("set-cookie")).toMatch(/HttpOnly; SameSite=Lax; Path=\/; Secure/);

    const out = await fetch(`${base}/api/logout`, {
      method: "POST",
      headers: { cookie: cookieOf(proxied), "x-forwarded-proto": "https", origin: `http://${host}` },
    });
    expect(out.headers.get("set-cookie")).toMatch(/Secure; Max-Age=0/);
  });
});

describe("request origin", () => {
  it("refuses changes and live connections started by another site's page", async () => {
    const { base, host, port } = await desk();
    const cookie = cookieOf(await login(base, { origin: `http://${host}` }));

    // Another site cannot log in, or act with the cookie the browser holds.
    expect((await login(base, { origin: "https://evil.example" })).status).toBe(403);
    const forged = await fetch(`${base}/api/sessions/close`, {
      method: "POST",
      headers: { cookie, origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ tool: "claude", id: "x" }),
    });
    expect(forged.status).toBe(403);
    expect(await forged.json()).toEqual({ error: "bad_origin" });

    // Reading is unaffected, and the desk's own page still works.
    expect((await fetch(`${base}/api/catalog`, { headers: { cookie, origin: "https://evil.example" } })).status).toBe(200);
    const own = await fetch(`${base}/api/sessions/close`, {
      method: "POST",
      headers: { cookie, origin: `http://${host}`, "content-type": "application/json" },
      body: JSON.stringify({ tool: "claude", id: "x" }),
    });
    expect(own.status).not.toBe(403);

    expect(await upgrade(port, { cookie, origin: "https://evil.example" })).toBe(403);
    expect(await upgrade(port, { cookie, origin: "null" })).toBe(403);
    expect(await upgrade(port, { cookie, origin: `http://${host}` })).toBe(101);
    // Not a browser page at all: nothing to forge, the cookie still decides.
    expect(await upgrade(port, { cookie })).toBe(101);
    expect(await upgrade(port, {})).toBe(401);
  });

  it("accepts the public address a proxy forwards, and one listed by hand", async () => {
    const { base, port } = await desk();
    expect((await login(base, { origin: "https://mm.example.com", "x-forwarded-host": "mm.example.com" })).status).toBe(200);
    expect((await login(base, { origin: "https://mm.example.com" })).status).toBe(403);
    process.env.MIRRORMIX_ALLOWED_ORIGINS = "https://mm.example.com/, https://other.example";
    const listed = await login(base, { origin: "https://mm.example.com" });
    expect(listed.status).toBe(200);
    expect(await upgrade(port, { cookie: cookieOf(listed), origin: "https://other.example" })).toBe(101);
  });
});
