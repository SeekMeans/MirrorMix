import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createSupervisor } from "../src/process/supervisor";
import { resolveClaudeDataDir } from "../src/catalog/claudeData";
import { detectTools } from "../src/settings/toolSettings";
import type { LaunchRequest } from "../src/shared/types";
import type { AddressInfo } from "node:net";
import { createApp, listenLocal } from "../src/server/app";
import { createSettingsStore } from "../src/settings/toolSettings";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "desktop-connection-"));
  const codexSessionsDir = path.join(root, "sessions");
  const claudeProjectsDir = path.join(root, "projects");
  mkdirSync(codexSessionsDir);
  mkdirSync(claudeProjectsDir);
  const codexFile = path.join(codexSessionsDir, "thread.jsonl");
  const codexRows = [
    { type: "session_meta", payload: { id: "codex-thread", cwd: root } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Codex title" }] } },
  ];
  writeFileSync(codexFile, codexRows.map(row => JSON.stringify(row)).join("\n"));
  const claudeDir = path.join(claudeProjectsDir, "fixture");
  mkdirSync(claudeDir);
  writeFileSync(path.join(claudeDir, "claude-thread.jsonl"), JSON.stringify({ type: "user", sessionId: "claude-thread", cwd: root, message: { role: "user", content: "Claude title" } }));
  return { root, codexFile, codexRows, roots: { codexSessionsDir, claudeProjectsDir, claudeDataDir: "" } };
}

describe("desktop-only messaging", () => {
  it("advertises desktop capabilities and opens CLI-only history with HTTP 200 as read-only", async () => {
    const f = fixture();
    const processes = () => [{ pid: 1, parentPid: 0, commandLine: '"C:\\Program Files\\WindowsApps\\OpenAI.Codex_fixture\\app\\ChatGPT.exe"' }];
    const submitCodex = vi.fn(async () => {});
    const supervisor = createSupervisor({ roots: f.roots, bins: { claudeExe: "", nodeExe: "", codexJs: "" },
      desktopOnly: true, listProcesses: processes, submitCodex, codexDesktopSession: () => null,
      spawn: () => { throw new Error("CLI must never start"); } });
    const server = createApp(supervisor, createSettingsStore(path.join(f.root, "settings.json"), processes));
    await listenLocal(server, 0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const prefs = await (await fetch(`${base}/api/settings`)).json();
      expect(prefs.capabilities.create).toMatchObject({ codex: false, claude: false });
      const opened = await fetch(`${base}/api/sessions/open`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tool: "codex", id: "codex-thread" }) });
      expect(opened.status).toBe(200);
      expect(await opened.json()).toMatchObject({ readOnlyReason: "codex_history_only", sendEnabled: false, messages: [{ role: "user", text: "Codex title" }] });
      expect(submitCodex).not.toHaveBeenCalled();
    } finally {
      supervisor.dispose();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("routes both tools to their native windows and reads replies from the same transcript", async () => {
    const f = fixture();
    const spawn = vi.fn(() => { throw new Error("CLI must never start"); });
    const submitCodex = vi.fn(async () => {});
    const submitDesktop = vi.fn(async () => {});
    const readDesktopStream = vi.fn(() => "");
    const supervisor = createSupervisor({ ...f, bins: { claudeExe: "", nodeExe: "", codexJs: "" }, desktopOnly: true,
      spawn, listProcesses: () => [], submitCodex, submitDesktop, readDesktopStream,
      desktopSession: () => ({ title: "Native Claude title" }),
    });
    try {
      expect(supervisor.open("codex", "codex-thread")).toMatchObject({ attached: "desktop", sendEnabled: true });
      expect(readDesktopStream).not.toHaveBeenCalled();
      await supervisor.send("codex", "codex-thread", "desktop Codex ping");
      expect(submitCodex).toHaveBeenCalledWith("Codex title", "desktop Codex ping", "codex-thread");
      expect(supervisor.getSession("codex", "codex-thread").messages).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "pending-user", role: "user", text: "desktop Codex ping" })]),
      );
      writeFileSync(f.codexFile, [...f.codexRows,
        { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "desktop Codex ping" }] } },
        { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "desktop pong" }] } },
      ].map(row => JSON.stringify(row)).join("\n"));
      expect(supervisor.getSession("codex", "codex-thread").messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "assistant", text: "desktop pong" })]));
      expect(supervisor.open("claude", "claude-thread")).toMatchObject({ attached: "claude", sendEnabled: true });
      await supervisor.send("claude", "claude-thread", "desktop Claude ping");
      expect(submitDesktop).toHaveBeenCalledWith("Native Claude title", "desktop Claude ping");
      expect(spawn).not.toHaveBeenCalled();
    } finally { supervisor.dispose(); }
  });

  it("stops listing a session as running once its reply is in, without the conversation being opened", async () => {
    const f = fixture();
    const claudeFile = path.join(f.roots.claudeProjectsDir, "fixture", "claude-thread.jsonl");
    const supervisor = createSupervisor({ ...f, bins: { claudeExe: "", nodeExe: "", codexJs: "" }, desktopOnly: true,
      spawn: () => { throw new Error("CLI"); }, listProcesses: () => [], submitDesktop: async () => {},
      readDesktopStream: () => "", desktopSession: () => ({ title: "Claude title" }) });
    const listed = () => supervisor.catalog().claude.flatMap((group) => group.sessions).find((session) => session.id === "claude-thread");
    try {
      supervisor.open("claude", "claude-thread");
      await supervisor.send("claude", "claude-thread", "ping from the page");
      expect(listed()?.working).toBe(true);
      writeFileSync(claudeFile, [
        { type: "user", sessionId: "claude-thread", cwd: f.root, message: { role: "user", content: "Claude title" } },
        { type: "user", sessionId: "claude-thread", cwd: f.root, message: { role: "user", content: "ping from the page" } },
        { type: "assistant", sessionId: "claude-thread", cwd: f.root, message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "pong" }] } },
      ].map(row => JSON.stringify(row)).join("\n"));
      // Only the list is read here, as the workbench does; the conversation itself is never asked for.
      expect(listed()?.working).toBe(false);
    } finally { supervisor.dispose(); }
  });

  it("reports missing desktop sessions and rejects CLI creation instead of falling back", async () => {
    const f = fixture();
    const spawn = vi.fn(() => { throw new Error("CLI must never start"); });
    const supervisor = createSupervisor({ roots: f.roots, bins: { claudeExe: "", nodeExe: "", codexJs: "" },
      desktopOnly: true, spawn, listProcesses: () => [], desktopSession: () => null,
      submitCodex: async () => {}, codexDesktopSession: () => null });
    try {
      expect(supervisor.open("claude", "claude-thread")).toMatchObject({ sendEnabled: false, readOnlyReason: "claude_history_only" });
      expect(supervisor.open("codex", "codex-thread")).toMatchObject({ sendEnabled: false, readOnlyReason: "codex_history_only" });
      expect(supervisor.capabilities().create).toEqual({ claude: false, codex: false, cursor: false, deepseek: false });
      await expect(supervisor.create("codex", f.root)).rejects.toThrow("desktop_create_required");
      await expect(supervisor.create("claude", f.root)).rejects.toThrow("desktop_create_required");
      expect(spawn).not.toHaveBeenCalled();
    } finally { supervisor.dispose(); }
  });

  it("keeps an unsent message out of history if the desktop already has a draft", async () => {
    const f = fixture();
    const supervisor = createSupervisor({ roots: f.roots, bins: { claudeExe: "", nodeExe: "", codexJs: "" },
      desktopOnly: true, spawn: () => { throw new Error("CLI"); }, listProcesses: () => [],
      submitCodex: async () => { throw new Error("draft"); } });
    try {
      supervisor.open("codex", "codex-thread");
      await expect(supervisor.send("codex", "codex-thread", "unsent")).rejects.toThrow("desktop_draft");
      expect(supervisor.getSession("codex", "codex-thread").messages.some(m => m.text === "unsent")).toBe(false);
    } finally { supervisor.dispose(); }
  });
});

describe("original transports", () => {
  it("still resumes Codex via PTY and attaches Claude's existing inbox without desktop mode", async () => {
    const f = fixture();
    const spawn = vi.fn((_spec: LaunchRequest) => ({ pid: 123, write() {}, resize() {}, kill() {}, onData() {}, onExit() {} }));
    const inbox = { pipe: "\\\\.\\pipe\\fixture", token: "fixture" };
    const injectClaude = vi.fn(async () => {});
    const supervisor = createSupervisor({ roots: f.roots, bins: { claudeExe: "claude.exe", nodeExe: "node.exe", codexJs: "codex.js" },
      spawn, listProcesses: () => [], findClaudeInbox: () => inbox, injectClaude });
    try {
      expect(supervisor.capabilities().create).toMatchObject({ codex: true, claude: true });
      expect(supervisor.open("codex", "codex-thread")).toMatchObject({ attached: "process", sendEnabled: true });
      expect(spawn.mock.calls[0][0]).toMatchObject({ file: "node.exe", args: ["codex.js", "resume", "codex-thread"] });
      expect(supervisor.open("claude", "claude-thread")).toMatchObject({ attached: "claude", sendEnabled: true });
      await supervisor.send("claude", "claude-thread", "existing inbox");
      expect(injectClaude).toHaveBeenCalledWith(inbox, "existing inbox");
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally { supervisor.dispose(); }
  });

  it("writes a Codex thread that is open in the Codex app into its window", async () => {
    const f = fixture();
    const spawn = vi.fn((_spec: LaunchRequest) => ({ pid: 123, write() {}, resize() {}, kill() {}, onData() {}, onExit() {} }));
    const submitCodex = vi.fn(async () => {});
    const supervisor = createSupervisor({ roots: f.roots, bins: { claudeExe: "claude.exe", nodeExe: "node.exe", codexJs: "codex.js" },
      spawn, listProcesses: () => [], submitCodex, codexDesktopSession: () => ({ title: "Codex title" }) });
    try {
      expect(supervisor.open("codex", "codex-thread")).toMatchObject({ attached: "desktop", sendEnabled: true });
      await supervisor.send("codex", "codex-thread", "to the window");
      expect(submitCodex).toHaveBeenCalledWith("Codex title", "to the window", "codex-thread");
      expect(spawn).not.toHaveBeenCalled();
    } finally { supervisor.dispose(); }
  });

  it("runs the thread in MirrorMix's own Codex when the Codex window cannot take the message", async () => {
    const f = fixture();
    const writes: string[] = [];
    const spawn = vi.fn((_spec: LaunchRequest) => {
      let output: (data: string) => void = () => {};
      setTimeout(() => output("› Ask Codex to do anything"), 20);
      return { pid: 124, write: (data: string) => { writes.push(data); }, resize() {}, kill() {}, onData: (cb: (data: string) => void) => { output = cb; }, onExit() {} };
    });
    const supervisor = createSupervisor({ roots: f.roots, bins: { claudeExe: "claude.exe", nodeExe: "node.exe", codexJs: "codex.js" },
      spawn, listProcesses: () => [], submitCodex: async () => { throw new Error("missing"); },
      codexDesktopSession: () => ({ title: "Codex title" }) });
    try {
      supervisor.open("codex", "codex-thread");
      const frames: Array<{ messages: Array<{ role: string; text: string }> }> = [];
      const stop = supervisor.subscribe("codex", "codex-thread", (view) => frames.push(view));
      await supervisor.send("codex", "codex-thread", "app is closed");
      stop();
      expect(spawn.mock.calls[0][0]).toMatchObject({ file: "node.exe", args: ["codex.js", "resume", "codex-thread"] });
      expect(writes).toEqual(["\u001b[200~app is closed\u001b[201~", "\r"]);
      expect(supervisor.getSession("codex", "codex-thread")).toMatchObject({ takenOver: true });
      const firstEcho = frames.findIndex((frame) => frame.messages.some((message) => message.role === "user" && message.text === "app is closed"));
      expect(firstEcho).toBeGreaterThan(-1);
      expect(frames.slice(firstEcho).every((frame) => frame.messages.some((message) => message.role === "user" && message.text === "app is closed"))).toBe(true);
    } finally { supervisor.dispose(); }
  });

  it("queues a Codex message with the background service while the screen is locked", async () => {
    const f = fixture();
    const spawn = vi.fn((_spec: LaunchRequest) => ({ pid: 125, write() {}, resize() {}, kill() {}, onData() {}, onExit() {} }));
    const queueCodex = vi.fn(async () => {});
    const supervisor = createSupervisor({ roots: f.roots, bins: { claudeExe: "claude.exe", nodeExe: "node.exe", codexJs: "codex.js" },
      spawn, listProcesses: () => [], submitCodex: async () => { throw new Error("locked"); }, queueCodex,
      codexDesktopSession: () => ({ title: "Codex title" }) });
    try {
      supervisor.open("codex", "codex-thread");
      await supervisor.send("codex", "codex-thread", "while locked");
      expect(queueCodex).toHaveBeenCalledWith("codex-thread", f.root, "while locked");
      expect(spawn).not.toHaveBeenCalled();
    } finally { supervisor.dispose(); }
  });
});

describe("Windows desktop discovery", () => {
  it("uses roaming Claude session metadata and preserves explicit directory overrides", () => {
    const root = mkdtempSync(path.join(tmpdir(), "claude-path-"));
    const roaming = path.join(root, "roaming");
    const local = path.join(root, "local");
    const sessions = path.join(roaming, "Claude", "claude-code-sessions", "account");
    mkdirSync(sessions, { recursive: true });
    mkdirSync(path.join(local, "Claude-Data"), { recursive: true });
    writeFileSync(path.join(sessions, "local_fixture.json"), "{}");
    expect(resolveClaudeDataDir({ APPDATA: roaming, LOCALAPPDATA: local })).toBe(path.dirname(sessions));
    expect(resolveClaudeDataDir({ APPDATA: roaming, AIMISS_CLAUDE_DATA: "override" })).toBe("override");
    expect(resolveClaudeDataDir({ APPDATA: roaming, AIMISS_CLAUDE_DATA: "" })).toBe("");
  });

  it("recognizes Claude MSIX windows without a visible command line, and excludes a CLI alone", () => {
    expect(detectTools([{ pid: 10, parentPid: 1, commandLine: "", name: "claude.exe", windowTitle: "Claude" }]).claude.running).toBe(true);
    expect(detectTools([{ pid: 10, parentPid: 1, commandLine: "claude.exe --resume thread", name: "claude.exe", windowTitle: "" }]).claude.running).toBe(false);
  });
});
