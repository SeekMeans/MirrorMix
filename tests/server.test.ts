import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { encodeClaudeProject } from "../src/process/launch";
import { createSupervisor, type PtyLike } from "../src/process/supervisor";
import { createApp, listenLocal } from "../src/server/app";

class FakePty implements PtyLike {
  writes: string[] = [];
  killed = false;
  cols = 0;
  rows = 0;
  private dataHandlers: Array<(data: string) => void> = [];
  private exitHandlers: Array<(code: number) => void> = [];

  constructor(readonly pid: number) {}

  write(data: string) {
    this.writes.push(data);
  }

  resize(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
  }

  kill() {
    this.killed = true;
    for (const handler of this.exitHandlers) handler(0);
  }

  onData(callback: (data: string) => void) {
    this.dataHandlers.push(callback);
  }

  onExit(callback: (code: number) => void) {
    this.exitHandlers.push(callback);
  }

  emit(data: string) {
    for (const handler of this.dataHandlers) handler(data);
  }
}

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "aimiss-server-"));
  const cwd = path.join(root, "work");
  mkdirSync(cwd, { recursive: true });
  const projects = path.join(root, "projects");
  const project = path.join(projects, encodeClaudeProject(cwd));
  mkdirSync(project, { recursive: true });
  writeFileSync(
    path.join(project, "sess-1.jsonl"),
    [
      JSON.stringify({ type: "user", cwd, message: { role: "user", content: "你好" } }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "收到" }] },
      }),
    ].join("\n"),
  );
  const ptys: FakePty[] = [];
  let nextPid = 40;
  const supervisor = createSupervisor({
    bins: { claudeExe: "claude.exe", nodeExe: "node.exe", codexJs: "codex.js" },
    roots: { claudeProjectsDir: projects, codexSessionsDir: path.join(root, "sessions") },
    pollMs: 30,
    listProcesses: () => [],
    spawn: () => {
      const pty = new FakePty(nextPid++);
      ptys.push(pty);
      return pty;
    },
  });
  const server = createApp(supervisor);
  return { root, cwd, project, supervisor, server, ptys };
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
  return address;
}

describe("session API", () => {
  it("opens a session, sends while it is running, and streams the terminal", async () => {
    const { server, ptys, supervisor } = fixture();
    const address = await start(server);
    expect(address.address).toBe("127.0.0.1");

    const health = await fetch(`http://127.0.0.1:${address.port}/api/health`);
    expect(await health.json()).toEqual({ ok: true });

    const opened = await fetch(`http://127.0.0.1:${address.port}/api/sessions/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: "claude", id: "sess-1" }),
    });
    expect(opened.status).toBe(200);
    expect(ptys[0]?.writes).toEqual([]);

    const sent = await fetch(`http://127.0.0.1:${address.port}/api/sessions/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: "claude", id: "sess-1", text: "继续看" }),
    });
    expect(sent.status).toBe(200);
    expect(ptys[0]?.writes).toEqual(["继续看\r"]);

    ptys[0]?.emit("\r\n❯ 1. Yes\r\n");
    await new Promise((resolve) => setTimeout(resolve, 30));
    const blocked = await fetch(`http://127.0.0.1:${address.port}/api/sessions/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: "claude", id: "sess-1", text: "不要写进去" }),
    });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toEqual({ error: "not_idle" });
    expect(ptys[0]?.writes).toEqual(["继续看\r"]);

    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/terminal?tool=claude&id=sess-1`);
    const received = new Promise<string>((resolve) => {
      const chunks: string[] = [];
      socket.on("message", (data) => {
        chunks.push(String(data));
        if (chunks.join("").includes("画面")) resolve(chunks.join(""));
      });
    });
    await new Promise((resolve) => socket.once("open", resolve));
    ptys[0]?.emit("画面");
    expect(await received).toContain("画面");
    socket.send("k");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ptys[0]?.writes).toContain("k");
    socket.close();

    const closed = await fetch(`http://127.0.0.1:${address.port}/api/sessions/close`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: "claude", id: "sess-1" }),
    });
    expect(closed.status).toBe(200);
    expect(ptys[0]?.killed).toBe(true);
    supervisor.dispose();
  });

  it("refuses an occupied session and binds a newly created one", async () => {
    const { server, cwd, project, ptys } = fixture();
    const address = await start(server);
    const occupied = createSupervisor({
      bins: { claudeExe: "claude.exe", nodeExe: "node.exe", codexJs: "codex.js" },
      roots: { claudeProjectsDir: path.dirname(project), codexSessionsDir: path.join(path.dirname(project), "none") },
      listProcesses: () => [{ pid: 9, parentPid: 1, commandLine: "claude.exe --resume sess-1" }],
      spawn: () => {
        throw new Error("should not spawn");
      },
    });
    expect(() => occupied.open("claude", "sess-1")).toThrowError(expect.objectContaining({ code: "occupied" }));
    occupied.dispose();

    const creating = fetch(`http://127.0.0.1:${address.port}/api/sessions/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: "claude", workspacePath: cwd }),
    });
    // Claude Code is started under an id chosen here, so the session is known before its transcript exists.
    const created = await creating;
    expect(created.status).toBe(200);
    const body = (await created.json()) as { id: string; status: string };
    expect(body).toMatchObject({ status: "running" });
    expect(body.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(ptys.at(-1)?.killed).toBe(false);

    const missing = await fetch(`http://127.0.0.1:${address.port}/api/sessions/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: "claude", workspacePath: "Z:\\not-a-workspace" }),
    });
    expect(missing.status).toBe(404);
  });

  it("sends into an already open Claude session and streams the transcript", async () => {
    const { project, cwd } = fixture();
    const submitted: string[] = [];
    const supervisor = createSupervisor({
      bins: { claudeExe: "claude.exe", nodeExe: "node.exe", codexJs: "codex.js" },
      roots: { claudeProjectsDir: path.dirname(project), codexSessionsDir: path.join(path.dirname(project), "none") },
      listProcesses: () => [{ pid: 9, parentPid: 1, commandLine: "claude.exe --resume=sess-1" }],
      findClaudeInbox: () => ({ pipe: "\\\\.\\pipe\\claude-test", token: "token" }),
      submitDesktop: async (_title, text) => {
        submitted.push(text);
      },
      spawn: () => {
        throw new Error("should not spawn");
      },
    });
    const server = createApp(supervisor);
    const address = await start(server);
    const opened = await fetch(`http://127.0.0.1:${address.port}/api/sessions/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: "claude", id: "sess-1" }),
    });
    expect(opened.status).toBe(200);
    expect(await opened.json()).toMatchObject({ attached: "claude", status: "running" });

    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/live?tool=claude&id=sess-1`);
    const first = new Promise<string>((resolve) => socket.once("message", (data) => resolve(String(data))));
    await new Promise((resolve) => socket.once("open", resolve));
    expect(JSON.parse(await first).messages.at(-1).text).toBe("收到");

    const echoed = new Promise<string>((resolve) => {
      socket.on("message", (data) => {
        const view = JSON.parse(String(data)) as { messages: Array<{ text: string }> };
        if (view.messages.some((message) => message.text === "同步这句话")) resolve(String(data));
      });
    });
    const sent = await fetch(`http://127.0.0.1:${address.port}/api/sessions/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: "claude", id: "sess-1", text: "同步这句话" }),
    });
    expect(sent.status).toBe(200);
    expect(submitted).toEqual(["同步这句话"]);
    // The sent message shows at once, followed by the clock of the round it starts.
    const tail = JSON.parse(await echoed).messages.slice(-2) as Array<{ role: string; text: string; startedAt?: string }>;
    expect(tail[0]).toMatchObject({ role: "user", text: "同步这句话" });
    expect(tail[1]).toMatchObject({ role: "turn" });
    expect(tail[1].startedAt).toBeTruthy();
    expect(supervisor.getSession("claude", "sess-1").sendEnabled).toBe(true);

    // The person stops the round inside Claude Code: no reply will come, and the web side must accept input again.
    appendFileSync(
      path.join(project, "sess-1.jsonl"),
      [
        "",
        JSON.stringify({ type: "user", cwd, message: { role: "user", content: "同步这句话" } }),
        JSON.stringify({ type: "user", cwd, message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } }),
      ].join(String.fromCharCode(10)),
    );
    const stopped = supervisor.getSession("claude", "sess-1");
    expect(stopped.sendEnabled).toBe(true);
    expect(stopped.messages.some((message) => message.text.includes("Request interrupted"))).toBe(false);
    socket.close();
    supervisor.dispose();
    expect(cwd).toBeTruthy();
  });

  it("serves a long transcript a page at a time and pushes only what changed", async () => {
    const { server, project, cwd, supervisor } = fixture();
    const NL = String.fromCharCode(10);
    const lines: string[] = [];
    for (let turn = 0; turn < 150; turn += 1) {
      lines.push(JSON.stringify({ type: "user", cwd, message: { role: "user", content: `问 ${turn}` } }));
      lines.push(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `答 ${turn}` }] } }));
    }
    const file = path.join(project, "long.jsonl");
    writeFileSync(file, lines.join(NL));
    const address = await start(server);
    const base = `http://127.0.0.1:${address.port}/api/sessions/claude/long`;

    const newest = (await (await fetch(base)).json()) as { total: number; offset: number; messages: Array<{ text: string }> };
    expect(newest.total).toBe(300);
    expect(newest.offset).toBe(240);
    expect(newest.messages).toHaveLength(60);
    expect(newest.messages.at(-1)?.text).toBe("答 149");

    const older = (await (await fetch(`${base}?before=240&limit=40`)).json()) as typeof newest;
    expect(older.offset).toBe(200);
    expect(older.messages).toHaveLength(40);
    expect(older.messages.at(-1)?.text).toBe("答 119");

    const first = (await (await fetch(`${base}?before=10&limit=60`)).json()) as typeof newest;
    expect(first.offset).toBe(0);
    expect(first.messages).toHaveLength(10);

    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/live?tool=claude&id=long`);
    const frames: Array<{ type: string; offset: number; total: number; messages: Array<{ text: string }> }> = [];
    const second = new Promise<void>((resolve) => {
      socket.on("message", (data) => {
        frames.push(JSON.parse(String(data)));
        if (frames.length === 1) {
          writeFileSync(file, [...lines, JSON.stringify({ type: "user", cwd, message: { role: "user", content: "新的一句" } })].join(NL));
        }
        if (frames.length === 2) resolve();
      });
    });
    await second;
    expect(frames[0]).toMatchObject({ type: "snapshot", total: 300, offset: 240 });
    expect(frames[0]?.messages).toHaveLength(60);
    expect(frames[1]).toMatchObject({ type: "patch", total: 301, offset: 300 });
    expect(frames[1]?.messages.map((message) => message.text)).toEqual(["新的一句"]);
    socket.close();
    supervisor.dispose();
  });

  it("keeps command prompts running for a session, several at once, until each is closed", async () => {
    const { supervisor, cwd } = fixture();
    const writes: string[] = [];
    const opened: string[] = [];
    const emits: Array<(data: string) => void> = [];
    const killed: number[] = [];
    const server = createApp(supervisor, undefined, undefined, {
      open(dir) {
        const index = opened.length;
        opened.push(dir);
        return {
          write(data) {
            writes.push(data);
          },
          resize() {},
          kill() {
            killed.push(index);
          },
          onData(callback) {
            emits[index] = callback;
          },
          onExit() {},
        };
      },
    });
    const address = await start(server);
    const base = `http://127.0.0.1:${address.port}`;
    const post = (route: string, body: unknown) =>
      fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const connect = (tid: string) =>
      new Promise<{ socket: WebSocket; first: Promise<string> }>((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/cmd?tool=claude&id=sess-1&tid=${tid}`);
        const first = new Promise<string>((done) => socket.once("message", (data) => done(String(data))));
        socket.once("open", () => resolve({ socket, first }));
        socket.once("error", reject);
      });

    const one = (await (await post("/api/cmd/new", { tool: "claude", id: "sess-1" })).json()) as { terminal: { tid: string; label: string } };
    const two = (await (await post("/api/cmd/new", { tool: "claude", id: "sess-1" })).json()) as { terminal: { tid: string; label: string } };
    expect([one.terminal.label, two.terminal.label]).toEqual(["1", "2"]);
    expect(opened.map((dir) => path.resolve(dir))).toEqual([path.resolve(cwd), path.resolve(cwd)]);

    const first = await connect(one.terminal.tid);
    emits[0]?.("hello");
    expect(await first.first).toBe("hello");
    first.socket.send("dir\r");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(writes).toContain("dir\r");

    // Leaving (switching session, closing the panel) does not stop it, and what it printed is shown again.
    first.socket.close();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(killed).toEqual([]);
    emits[0]?.(" while away");
    const again = await connect(one.terminal.tid);
    expect(await again.first).toBe("hello while away");
    again.socket.close();

    const listed = (await (await fetch(`${base}/api/cmd/list?tool=claude&id=sess-1`)).json()) as { terminals: unknown[] };
    expect(listed.terminals).toHaveLength(2);

    const closed = await post("/api/cmd/close", { tool: "claude", id: "sess-1", tid: one.terminal.tid });
    expect(((await closed.json()) as { terminals: Array<{ tid: string }> }).terminals.map((item) => item.tid)).toEqual([two.terminal.tid]);
    expect(killed).toEqual([0]);
    server.close();
    supervisor.dispose();
  });

  it("stops the web process and uses the Claude Code session when that side is open", () => {
    const root = mkdtempSync(path.join(tmpdir(), "aimiss-server-"));
    const cwd = path.join(root, "work");
    mkdirSync(cwd, { recursive: true });
    const project = path.join(root, "projects", encodeClaudeProject(cwd));
    mkdirSync(project, { recursive: true });
    writeFileSync(
      path.join(project, "sess-1.jsonl"),
      JSON.stringify({ type: "user", cwd, message: { role: "user", content: "你好" } }),
    );
    let inbox: { pipe: string; token: string } | null = null;
    const ptys: FakePty[] = [];
    const supervisor = createSupervisor({
      bins: { claudeExe: "claude.exe", nodeExe: "node.exe", codexJs: "codex.js" },
      roots: { claudeProjectsDir: path.join(root, "projects"), codexSessionsDir: path.join(root, "sessions") },
      listProcesses: () => [],
      findClaudeInbox: () => inbox,
      spawn: () => {
        const pty = new FakePty(70);
        ptys.push(pty);
        return pty;
      },
    });
    expect(supervisor.open("claude", "sess-1").attached).toBe("process");
    inbox = { pipe: "\\\\.\\pipe\\claude-test", token: "token" };
    expect(supervisor.open("claude", "sess-1")).toMatchObject({ attached: "claude", status: "running" });
    expect(ptys[0]?.killed).toBe(true);
    supervisor.dispose();
  });
});
