import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { browserCookie, createDeepseekApp, deepseekHostPid, listeningPort, readBrowserSecret } from "../src/process/deepseekApp";

const b64u = (bytes: Buffer) => bytes.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
const SECRET = Buffer.alloc(32, 7);

function credentials(): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "aimiss-dsh-app-")), ".credentials.yaml");
  writeFileSync(
    file,
    [
      "version: 1",
      "refs:",
      "  DEEPSEEK_API_KEY: sk-test",
      "records:",
      "  client-connection/browser-session:",
      "    kind: grant",
      "    payload:",
      "      version: 1",
      `      secret: ${b64u(SECRET)}`,
      "  deepseek-account-platform/device:",
      "    kind: grant",
      "    payload:",
      "      secret: not-this-one",
      "",
    ].join("\n"),
  );
  return file;
}

const host = { pid: 42, parentPid: 1, commandLine: `"D:\\DeepSeek Harness\\DeepSeek Harness.exe" --expose-internals "D:\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\index.js" D:\\dsh` };
const cli = { pid: 43, parentPid: 1, commandLine: `"D:\\DeepSeek Harness\\DeepSeek Harness.exe" --expose-internals "D:\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js" headless` };
const NETSTAT = ["  TCP    0.0.0.0:135     0.0.0.0:0   LISTENING   1100", "  TCP    127.0.0.1:61411  0.0.0.0:0  LISTENING   42", "  TCP    127.0.0.1:5000  127.0.0.1:61411  ESTABLISHED  42"].join("\r\n");

describe("the DeepSeek Harness app's own server", () => {
  it("reads the browser-session secret, not another record's", () => {
    expect(readBrowserSecret(credentials())?.equals(SECRET)).toBe(true);
    expect(readBrowserSecret(path.join(tmpdir(), "no-such-file.yaml"))).toBeNull();
  });

  it("signs the cookie the way the app checks it", () => {
    const authority = "127.0.0.1:61411";
    const cookie = browserCookie(SECRET, authority, 1_000_000);
    const [name, value] = cookie.split("=");
    expect(name).toBe(`dsh-auth-${b64u(createHash("sha256").update(authority).digest())}`);
    const [version, body, signature] = value.split(".");
    expect(version).toBe("v1");
    expect(signature).toBe(b64u(createHmac("sha256", SECRET).update(body).digest()));
    const payload = JSON.parse(Buffer.from(body.replaceAll("-", "+").replaceAll("_", "/"), "base64").toString("utf8"));
    expect(payload).toMatchObject({ version: 1, authority });
    expect(payload.expiresAt).toBeGreaterThan(payload.issuedAt);
  });

  it("finds the host process and the loopback port it listens on", () => {
    expect(deepseekHostPid([cli, host])).toBe(42);
    expect(deepseekHostPid([cli])).toBeNull();
    expect(listeningPort(NETSTAT, 42)).toBe(61411);
    expect(listeningPort(NETSTAT, 7)).toBeNull();
  });

  it("sends a message as the app's page does", async () => {
    const calls: Array<{ url: string; body: any; cookie: string }> = [];
    const app = createDeepseekApp({
      credentialsFile: credentials(),
      listProcesses: () => [host],
      netstat: async () => NETSTAT,
      fetch: (async (url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        calls.push({ url, body, cookie: (init.headers as Record<string, string>).cookie });
        const value = body.method === "session/create" ? { sessionId: "session-new" } : { accepted: true };
        return new Response(JSON.stringify({ type: "server-response", rpcId: body.rpcId, result: { ok: true, value } }), { status: 200 });
      }) as typeof fetch,
    });
    expect(app.available()).toBe(true);
    await app.prompt("session-abc", "你好", "queue");
    expect(calls[0].url).toBe("http://127.0.0.1:61411/api/session/prompt");
    expect(calls[0].body).toMatchObject({
      type: "client-request",
      method: "session/prompt",
      payload: { args: { request: { sessionId: "session-abc", mode: "queue", content: [{ type: "text", text: "你好" }] } } },
    });
    expect(calls[0].cookie.startsWith("dsh-auth-")).toBe(true);
    await expect(app.create("E:\\work")).resolves.toBe("session-new");
    expect(calls[1].body.payload).toEqual({ args: { request: { cwd: "E:\\work" } } });
  });

  it("says when the app is closed, and passes on its refusals", async () => {
    const closed = createDeepseekApp({ credentialsFile: credentials(), listProcesses: () => [cli], netstat: async () => NETSTAT });
    expect(closed.available()).toBe(false);
    await expect(closed.cancel("session-abc")).rejects.toMatchObject({ reason: "unavailable" });
    const refusing = createDeepseekApp({
      credentialsFile: credentials(),
      listProcesses: () => [host],
      netstat: async () => NETSTAT,
      fetch: (async () => new Response(JSON.stringify({ result: { ok: false, error: { code: "session/not-found", message: "no such session" } } }), { status: 200 })) as unknown as typeof fetch,
    });
    await expect(refusing.cancel("session-abc")).rejects.toMatchObject({ reason: "refused", code: "session/not-found" });
  });
});
