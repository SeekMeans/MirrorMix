import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { encodeClaudeProject } from "../src/process/launch";
import { createSupervisor } from "../src/process/supervisor";

describe("a session the Claude desktop app lists", () => {
  it("is followed through the app's window instead of getting a separate process", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "aimiss-desktop-"));
    const cwd = path.join(root, "work");
    const project = path.join(root, "projects", encodeClaudeProject(cwd));
    mkdirSync(cwd, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(
      path.join(project, "sess-1.jsonl"),
      [
        JSON.stringify({ type: "user", cwd, message: { role: "user", content: "第一句话，和桌面端的标题不一样" } }),
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "收到" }] } }),
      ].join(String.fromCharCode(10)),
    );
    const typed: Array<[string, string]> = [];
    let listed = true;
    const supervisor = createSupervisor({
      bins: { claudeExe: "claude.exe", nodeExe: "node.exe", codexJs: "codex.js" },
      roots: { claudeProjectsDir: path.join(root, "projects"), codexSessionsDir: path.join(root, "sessions"), claudeDataDir: "" },
      listProcesses: () => [],
      // The app lists the session but is not running it, so there is no inbox to find.
      findClaudeInbox: () => null,
      desktopSession: () => (listed ? { title: "桌面端的标题" } : null),
      submitDesktop: async (title, text) => {
        typed.push([title, text]);
      },
      spawn: () => {
        if (listed) throw new Error("should not start a separate process");
        return { pid: 7, write() {}, resize() {}, kill() {}, onData() {}, onExit() {} };
      },
    });

    const view = supervisor.open("claude", "sess-1");
    expect(view).toMatchObject({ status: "running", attached: "claude", sendEnabled: true });
    await supervisor.send("claude", "sess-1", "从网页发的话");
    // The window is searched by the name the app itself shows, not by the transcript's first line.
    expect(typed).toEqual([["桌面端的标题", "从网页发的话"]]);

    // A session the app does not list still gets its own process, as before.
    listed = false;
    supervisor.close("claude", "sess-1");
    expect(supervisor.open("claude", "sess-1")).toMatchObject({ status: "running", attached: "process" });
    supervisor.dispose();
  });

  it("sends through the running process when the screen is locked", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "aimiss-locked-"));
    const cwd = path.join(root, "work");
    const project = path.join(root, "projects", encodeClaudeProject(cwd));
    mkdirSync(cwd, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(path.join(project, "sess-1.jsonl"), JSON.stringify({ type: "user", cwd, message: { role: "user", content: "已经在跑" } }));
    const injected: string[] = [];
    const supervisor = createSupervisor({
      bins: { claudeExe: "claude.exe", nodeExe: "node.exe", codexJs: "codex.js" },
      roots: { claudeProjectsDir: path.join(root, "projects"), codexSessionsDir: path.join(root, "sessions"), claudeDataDir: "" },
      listProcesses: () => [],
      findClaudeInbox: () => ({ pipe: "\\\\.\\pipe\\claude-lock", token: "tok" }),
      desktopSession: () => ({ title: "已经在跑" }),
      submitDesktop: async () => {
        throw new Error("locked");
      },
      injectClaude: async (_inbox, text) => {
        injected.push(text);
      },
      spawn: () => {
        throw new Error("should not start a separate process");
      },
    });
    supervisor.open("claude", "sess-1");
    await supervisor.send("claude", "sess-1", "锁屏也要发出去");
    expect(injected).toEqual(["锁屏也要发出去"]);
    supervisor.dispose();
  });

  it("sends through the running process when the window takes the words but will not send them", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "aimiss-window-failed-"));
    const cwd = path.join(root, "work");
    const project = path.join(root, "projects", encodeClaudeProject(cwd));
    mkdirSync(cwd, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(path.join(project, "sess-1.jsonl"), JSON.stringify({ type: "user", cwd, message: { role: "user", content: "已经在跑" } }));
    const injected: string[] = [];
    const supervisor = createSupervisor({
      bins: { claudeExe: "claude.exe", nodeExe: "node.exe", codexJs: "codex.js" },
      roots: { claudeProjectsDir: path.join(root, "projects"), codexSessionsDir: path.join(root, "sessions"), claudeDataDir: "" },
      listProcesses: () => [],
      findClaudeInbox: () => ({ pipe: "\\\\.\\pipe\\claude-failed", token: "tok" }),
      desktopSession: () => ({ title: "已经在跑" }),
      // No Send button showed up in the window.
      submitDesktop: async () => {
        throw new Error("failed");
      },
      injectClaude: async (_inbox, text) => {
        injected.push(text);
      },
      spawn: () => {
        throw new Error("should not start a separate process");
      },
    });
    supervisor.open("claude", "sess-1");
    await supervisor.send("claude", "sess-1", "窗口没发出去也要送到");
    expect(injected).toEqual(["窗口没发出去也要送到"]);
    supervisor.dispose();
  });

  it("shows the message as sent at once while the window is still being typed into, and takes it back if refused", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "aimiss-window-early-"));
    const cwd = path.join(root, "work");
    const project = path.join(root, "projects", encodeClaudeProject(cwd));
    mkdirSync(cwd, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(
      path.join(project, "sess-1.jsonl"),
      [
        { type: "user", cwd, message: { role: "user", content: "之前的话" } },
        { type: "assistant", cwd, message: { id: "m1", role: "assistant", content: [{ type: "text", text: "好的" }] } },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n"),
    );
    let finish: (error?: Error) => void = () => {};
    const supervisor = createSupervisor({
      bins: { claudeExe: "claude.exe", nodeExe: "node.exe", codexJs: "codex.js" },
      roots: { claudeProjectsDir: path.join(root, "projects"), codexSessionsDir: path.join(root, "sessions"), claudeDataDir: "" },
      listProcesses: () => [],
      findClaudeInbox: () => null,
      desktopSession: () => ({ title: "之前的话" }),
      // Typing into the window takes its time; the test decides when it ends and how.
      submitDesktop: () => new Promise<void>((resolve, reject) => (finish = (error) => (error ? reject(error) : resolve()))),
      spawn: () => {
        throw new Error("should not start a separate process");
      },
    });
    supervisor.open("claude", "sess-1");
    const sending = supervisor.send("claude", "sess-1", "马上就显示");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const during = supervisor.getSession("claude", "sess-1").messages;
    expect(during.some((message) => message.role === "user" && message.text === "马上就显示")).toBe(true);
    // The round is under way already: its clock started when Send was pressed.
    expect(during.at(-1)).toMatchObject({ role: "turn" });
    expect(during.at(-1)?.endedAt).toBeUndefined();
    finish();
    await sending;

    // Refused by the window (busy), with no pipe to fall back on: the message is taken back.
    const refused = supervisor.send("claude", "sess-1", "这条会被撤回");
    await new Promise((resolve) => setTimeout(resolve, 10));
    finish(new Error("busy"));
    await expect(refused).rejects.toThrow("not_idle");
    expect(supervisor.getSession("claude", "sess-1").messages.some((message) => message.text === "这条会被撤回")).toBe(false);
    supervisor.dispose();
  });

  it("still says so when neither the window nor the pipe takes the message", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "aimiss-window-pipe-failed-"));
    const cwd = path.join(root, "work");
    const project = path.join(root, "projects", encodeClaudeProject(cwd));
    mkdirSync(cwd, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(path.join(project, "sess-1.jsonl"), JSON.stringify({ type: "user", cwd, message: { role: "user", content: "已经在跑" } }));
    const supervisor = createSupervisor({
      bins: { claudeExe: "claude.exe", nodeExe: "node.exe", codexJs: "codex.js" },
      roots: { claudeProjectsDir: path.join(root, "projects"), codexSessionsDir: path.join(root, "sessions"), claudeDataDir: "" },
      listProcesses: () => [],
      findClaudeInbox: () => ({ pipe: "\\\\.\\pipe\\claude-both-failed", token: "tok" }),
      desktopSession: () => ({ title: "已经在跑" }),
      submitDesktop: async () => {
        throw new Error("failed");
      },
      injectClaude: async () => {
        throw new Error("pipe closed");
      },
      spawn: () => {
        throw new Error("should not start a separate process");
      },
    });
    supervisor.open("claude", "sess-1");
    await expect(supervisor.send("claude", "sess-1", "两边都不收")).rejects.toThrow("inbox_failed");
    supervisor.dispose();
  });

  it("takes the session over in its own Claude Code when the screen is locked and nothing is running", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "aimiss-locked-idle-"));
    const cwd = path.join(root, "work");
    const project = path.join(root, "projects", encodeClaudeProject(cwd));
    mkdirSync(cwd, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(path.join(project, "sess-1.jsonl"), JSON.stringify({ type: "user", cwd, message: { role: "user", content: "只是列在列表里" } }));
    const written: string[] = [];
    const launched: string[][] = [];
    let windowCalls = 0;
    const supervisor = createSupervisor({
      bins: { claudeExe: "claude.exe", nodeExe: "node.exe", codexJs: "codex.js" },
      roots: { claudeProjectsDir: path.join(root, "projects"), codexSessionsDir: path.join(root, "sessions"), claudeDataDir: "" },
      listProcesses: () => [],
      findClaudeInbox: () => null,
      desktopSession: () => ({ title: "只是列在列表里" }),
      submitDesktop: async () => {
        windowCalls += 1;
        throw new Error("locked");
      },
      spawn: (request) => {
        launched.push(request.args);
        let onData: (data: string) => void = () => {};
        setTimeout(() => onData("> " + String.fromCharCode(13, 10) + "? for shortcuts"), 20);
        return {
          pid: 9,
          write: (data: string) => void written.push(data),
          resize() {},
          kill() {},
          onData: (callback: (data: string) => void) => {
            onData = callback;
          },
          onExit() {},
        };
      },
    });
    supervisor.open("claude", "sess-1");
    await supervisor.send("claude", "sess-1", "锁屏也要发出去");
    expect(launched).toEqual([["--resume", "sess-1", "锁屏也要发出去"]]);
    expect(written).toEqual([]);
    expect(supervisor.open("claude", "sess-1")).toMatchObject({ attached: "process", takenOver: true });
    // Later messages go straight to that process, not back to the window.
    await supervisor.send("claude", "sess-1", "第二句");
    expect(written).toEqual(["第二句\r"]);
    expect(windowCalls).toBe(1);
    supervisor.dispose();
  });

  it("takes the session over when the app's window does not list it, instead of asking to open it there", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "aimiss-not-listed-"));
    const cwd = path.join(root, "work");
    const project = path.join(root, "projects", encodeClaudeProject(cwd));
    mkdirSync(cwd, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(path.join(project, "sess-2.jsonl"), JSON.stringify({ type: "user", cwd, message: { role: "user", content: "很早以前的会话" } }));
    const written: string[] = [];
    const launched: string[][] = [];
    const supervisor = createSupervisor({
      bins: { claudeExe: "claude.exe", nodeExe: "node.exe", codexJs: "codex.js" },
      roots: { claudeProjectsDir: path.join(root, "projects"), codexSessionsDir: path.join(root, "sessions"), claudeDataDir: "" },
      listProcesses: () => [],
      findClaudeInbox: () => null,
      desktopSession: () => ({ title: "很早以前的会话" }),
      submitDesktop: async () => {
        throw new Error("missing");
      },
      spawn: (request) => {
        launched.push(request.args);
        let onData: (data: string) => void = () => {};
        setTimeout(() => onData("> " + String.fromCharCode(13, 10) + "? for shortcuts"), 20);
        return {
          pid: 10,
          write: (data: string) => void written.push(data),
          resize() {},
          kill() {},
          onData: (callback: (data: string) => void) => {
            onData = callback;
          },
          onExit() {},
        };
      },
    });
    supervisor.open("claude", "sess-2");
    await supervisor.send("claude", "sess-2", "从手机发的");
    expect(launched).toEqual([["--resume", "sess-2"]]);
    expect(written).toEqual(["从手机发的\r"]);
    expect(supervisor.open("claude", "sess-2")).toMatchObject({ takenOver: true });
    supervisor.dispose();
  });

  it("says so when the screen is locked and Claude Code cannot be started here either", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "aimiss-locked-nostart-"));
    const cwd = path.join(root, "work");
    const project = path.join(root, "projects", encodeClaudeProject(cwd));
    mkdirSync(cwd, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(path.join(project, "sess-1.jsonl"), JSON.stringify({ type: "user", cwd, message: { role: "user", content: "只是列在列表里" } }));
    const supervisor = createSupervisor({
      bins: { claudeExe: "claude.exe", nodeExe: "node.exe", codexJs: "codex.js" },
      roots: { claudeProjectsDir: path.join(root, "projects"), codexSessionsDir: path.join(root, "sessions"), claudeDataDir: "" },
      listProcesses: () => [],
      findClaudeInbox: () => null,
      desktopSession: () => ({ title: "只是列在列表里" }),
      submitDesktop: async () => {
        throw new Error("locked");
      },
      spawn: () => {
        throw new Error("no claude here");
      },
    });
    supervisor.open("claude", "sess-1");
    await expect(supervisor.send("claude", "sess-1", "发不出去")).rejects.toMatchObject({ code: "desktop_locked" });
    supervisor.dispose();
  });
});
