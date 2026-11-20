import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createSupervisor } from "../src/process/supervisor";
import { createApp, listenLocal, type CommandShell } from "../src/server/app";
import { createTerminalHub, replayTerminalOutput } from "../src/server/terminals";
import { workspaceTerminalKey } from "../src/shared/terminalScope";

describe("project terminal identity", () => {
  it("replays display state without asking a new screen to repeat old device handshakes", () => {
    expect(replayTerminalOutput('hello\x1b[c\x1b[0c\x1b[>0c\x1b[32mgreen\x1b[0m')).toBe('hello\x1b[32mgreen\x1b[0m');
  });
  it("normalizes Windows drive, separators, case and extended paths without merging worktrees", () => {
    expect(workspaceTerminalKey('C:\\Work\\App\\')).toBe(workspaceTerminalKey('c:/work/app'));
    expect(workspaceTerminalKey('\\\\?\\C:\\Work\\App')).toBe('c:/work/app');
    expect(workspaceTerminalKey('\\\\?\\UNC\\server\\share\\app')).toBe('//server/share/app');
    expect(workspaceTerminalKey('C:\\Work\\App-worktree')).not.toBe(workspaceTerminalKey('C:\\Work\\App'));
    expect(workspaceTerminalKey('/Work/App')).not.toBe(workspaceTerminalKey('/work/app'));
  });

  it("replays shared output exactly once while another viewer has a pending output batch", async () => {
    let emit!: (text: string) => void;
    const hub = createTerminalHub(() => ({ write() {}, resize() {}, kill() {}, onExit() {}, onData: cb => { emit = cb; } }));
    const terminal = hub.ensure("project", "cwd");
    expect(hub.ensure("project", "cwd").tid).toBe(terminal.tid);
    const first: string[] = [], second: string[] = [];
    hub.attach("project", terminal.tid, { send: text => { first.push(text); }, close() {} });
    emit("shared output");
    hub.attach("project", terminal.tid, { send: text => { second.push(text); }, close() {} });
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(first).toEqual(["shared output"]);
    expect(second).toEqual(["shared output"]);
    hub.dispose();
  });

  it("limits the whole project to eight tabs and keeps an explicitly closed pool empty", () => {
    const hub = createTerminalHub(() => ({ write() {}, resize() {}, kill() {}, onData() {}, onExit() {} }));
    for (let index = 0; index < 8; index += 1) hub.create("project", "cwd");
    expect(() => hub.create("project", "cwd")).toThrow("too_many");
    expect(hub.ensure("project", "cwd").label).toBe("1");
    expect(hub.create("other", "other").label).toBe("1");
    for (const terminal of hub.list("project")) hub.close("project", terminal.tid);
    expect(hub.list("project")).toEqual([]);
    hub.dispose();
  });
});

describe("project terminal API", () => {
  it("shares three terminals across conversations and tools, isolates other projects, and stops them on service shutdown", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "project-terminals-"));
    const workspace = path.join(root, "app"), other = path.join(root, "other"), projects = path.join(root, "claude"), codex = path.join(root, "codex");
    for (const dir of [workspace, other, projects, codex]) mkdirSync(dir);
    const claudeFiles = path.join(projects, "fixture");
    mkdirSync(claudeFiles);
    for (const [id, cwd] of [["one", workspace], ["two", workspace], ["other", other]]) writeFileSync(path.join(claudeFiles, `${id}.jsonl`), JSON.stringify({ type: "user", cwd, message: { role: "user", content: id } }));
    writeFileSync(path.join(codex, "codex.jsonl"), [JSON.stringify({ type: "session_meta", payload: { id: "codex", cwd: workspace } }), JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "codex" } })].join("\n"));
    const supervisor = createSupervisor({ roots: { claudeProjectsDir: projects, codexSessionsDir: codex, claudeDataDir: "" }, bins: { claudeExe: "", codexJs: "", nodeExe: "" }, listProcesses: () => [], spawn: () => { throw new Error("not used"); } });
    const opened: string[] = [], outputs: Array<(text: string) => void> = [], writes: string[] = [], killed: number[] = [];
    const shells: CommandShell = { elevated: false, windowsPty: { backend: "conpty", buildNumber: 26200 }, open(cwd) {
      const index = opened.push(cwd) - 1;
      return { write: text => { writes.push(text); }, resize() {}, kill: () => { killed.push(index); }, onData: cb => { outputs[index] = cb; }, onExit() {} };
    } };
    const server = createApp(supervisor, undefined, undefined, shells);
    await listenLocal(server, 0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = async (route: string, body: unknown) => {
      const response = await fetch(base + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      expect(response.status).toBe(200); return response.json();
    };
    const list = async (id: string, tool = "claude") => (await fetch(`${base}/api/cmd/list?tool=${tool}&id=${id}`)).json();
    const sockets: WebSocket[] = [];
    try {
      const [first, simultaneous] = await Promise.all([
        post("/api/cmd/new", { tool: "claude", id: "one", ensure: true }),
        post("/api/cmd/new", { tool: "claude", id: "two", ensure: true }),
      ]);
      expect(first.terminal.tid).toBe(simultaneous.terminal.tid);
      expect(opened).toEqual([workspace]);
      await post("/api/cmd/new", { tool: "claude", id: "one" });
      await post("/api/cmd/new", { tool: "codex", id: "codex" });
      const shared = await list("two");
      expect(shared.terminals).toHaveLength(3);
      expect(shared.project).toMatchObject({ root: workspace, elevated: false, survivesRestart: false, windowsPty: shells.windowsPty });
      expect((await list("codex", "codex")).terminals).toEqual(shared.terminals);
      expect((await list("other")).terminals).toEqual([]);

      const socket = new WebSocket(`${base.replace("http", "ws")}/api/cmd?tool=codex&id=codex&tid=${first.terminal.tid}`);
      sockets.push(socket);
      outputs[0]("output from first conversation");
      const replay = await new Promise<string>((resolve, reject) => { socket.once("message", value => resolve(String(value))); socket.once("error", reject); });
      expect(replay).toBe("output from first conversation");
      socket.send("echo shared\r");
      await vi.waitFor(() => expect(writes).toContain("echo shared\r"));

      const wrong = new WebSocket(`${base.replace("http", "ws")}/api/cmd?tool=claude&id=other&tid=${first.terminal.tid}`);
      sockets.push(wrong);
      const code = await new Promise<number>((resolve, reject) => { wrong.once("close", resolve); wrong.once("error", reject); });
      expect(code).toBe(4404);

      const closed = new Promise(resolve => socket.once("close", resolve));
      await post("/api/cmd/close", { tool: "claude", id: "two", tid: first.terminal.tid });
      await closed;
      expect(killed).toEqual([0]);
      expect((await list("one")).terminals).toHaveLength(2);
    } finally {
      sockets.forEach(socket => socket.terminate());
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    expect(killed.sort()).toEqual([0, 1, 2]);
    const restarted = createApp(supervisor, undefined, undefined, shells);
    await listenLocal(restarted, 0);
    try {
      const address = restarted.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${address.port}/api/cmd/list?tool=claude&id=one`);
      expect((await response.json()).terminals).toEqual([]);
    } finally { supervisor.dispose(); await new Promise<void>(resolve => restarted.close(() => resolve())); }
  });
});
