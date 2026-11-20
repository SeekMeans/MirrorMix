import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { encodeClaudeProject } from "../src/process/launch";
import { createSupervisor } from "../src/process/supervisor";
import { createHiddenSessions } from "../src/settings/hiddenSessions";

function setup(options: { desktop?: boolean; madeHere?: boolean } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "aimiss-delete-"));
  const cwd = path.join(root, "work");
  const project = path.join(root, "projects", encodeClaudeProject(cwd));
  mkdirSync(cwd, { recursive: true });
  mkdirSync(path.join(project, "sess-1", "subagents"), { recursive: true });
  const file = path.join(project, "sess-1.jsonl");
  writeFileSync(file, JSON.stringify({ type: "user", sessionId: "sess-1", cwd, message: { role: "user", content: "要删掉的会话" } }));
  const trashed: string[][] = [];
  const hidden = createHiddenSessions(path.join(root, "hidden.json"));
  // Sessions created from the page; only these can be deleted from it.
  const madeHere = createHiddenSessions(path.join(root, "created.json"));
  if (options.madeHere !== false) madeHere.add("claude", "sess-1");
  let running = false;
  const supervisor = createSupervisor({
    bins: { claudeExe: "claude.exe", nodeExe: "node.exe", codexJs: "codex.js" },
    roots: { claudeProjectsDir: path.join(root, "projects"), codexSessionsDir: path.join(root, "sessions"), claudeDataDir: "" },
    listProcesses: () => [],
    hidden,
    madeHere,
    trash: async (paths) => void trashed.push(paths),
    desktopSession: options.desktop ? () => ({ title: "要删掉的会话" }) : undefined,
    spawn: () => {
      running = true;
      return { pid: 7, write() {}, resize() {}, kill() {}, onData() {}, onExit() {} };
    },
  });
  const listed = () => supervisor.catalog().claude.flatMap((group) => group.sessions.map((session) => session.id));
  return { root, file, project, supervisor, trashed, listed, isRunning: () => running };
}

describe("deleting a session from the page", () => {
  it("moves a command-line session's transcript and its folder to the Recycle Bin", async () => {
    const { supervisor, trashed, file, project } = setup();
    await expect(supervisor.remove("claude", "sess-1")).resolves.toEqual({ removed: "trash" });
    expect(trashed).toEqual([[file, path.join(project, "sess-1")]]);
    supervisor.dispose();
  });

  it("only takes a session the desktop app keeps off the list, and the list stays without it", async () => {
    const { supervisor, trashed, listed, root } = setup({ desktop: true });
    expect(listed()).toContain("sess-1");
    await expect(supervisor.remove("claude", "sess-1")).resolves.toEqual({ removed: "hidden" });
    expect(trashed).toEqual([]);
    expect(listed()).not.toContain("sess-1");
    // Remembered across a restart.
    expect(createHiddenSessions(path.join(root, "hidden.json")).has("claude", "SESS-1")).toBe(true);
    supervisor.dispose();
  });

  it("refuses while a reply is under way here", async () => {
    const { supervisor, trashed, file } = setup();
    // The person spoke after the process started, and no reply has come yet.
    writeFileSync(file, JSON.stringify({ type: "user", sessionId: "sess-1", cwd: path.join(path.dirname(path.dirname(path.dirname(file))), "work"), timestamp: new Date(Date.now() + 5_000).toISOString(), message: { role: "user", content: "要删掉的会话" } }));
    supervisor.open("claude", "sess-1");
    await expect(supervisor.remove("claude", "sess-1")).rejects.toThrow("session_running");
    expect(trashed).toEqual([]);
    supervisor.dispose();
  });

  it("closes the process MirrorMix holds open for an idle session, then deletes it", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "aimiss-delete-idle-"));
    const cwd = path.join(root, "work");
    const project = path.join(root, "projects", encodeClaudeProject(cwd));
    mkdirSync(cwd, { recursive: true });
    mkdirSync(project, { recursive: true });
    const file = path.join(project, "sess-2.jsonl");
    writeFileSync(
      file,
      [
        { type: "user", sessionId: "sess-2", cwd, message: { role: "user", content: "做完了吗" } },
        { type: "assistant", sessionId: "sess-2", cwd, message: { id: "m1", role: "assistant", content: [{ type: "text", text: "做完了" }] } },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n"),
    );
    const trashed: string[][] = [];
    let killed = false;
    let started = false;
    let exited: () => void = () => {};
    const supervisor = createSupervisor({
      bins: { claudeExe: "claude.exe", nodeExe: "node.exe", codexJs: "codex.js" },
      roots: { claudeProjectsDir: path.join(root, "projects"), codexSessionsDir: path.join(root, "sessions"), claudeDataDir: "" },
      // The closed process is still listed for a moment, as on a real PC: it must not count as another program.
      listProcesses: () => (started ? [{ pid: 9, parentPid: 1, commandLine: "claude.exe --resume sess-2", name: "claude.exe" }] : []),
      hidden: createHiddenSessions(path.join(root, "hidden.json")),
      madeHere: { has: (tool, id) => tool === "claude" && id === "sess-2", add() {} },
      trash: async (paths) => void trashed.push(paths),
      spawn: () => ({
        ...((started = true), {}),
        pid: 9,
        write() {},
        resize() {},
        kill() {
          killed = true;
          setTimeout(() => exited(), 10);
        },
        onData() {},
        onExit(callback) {
          exited = () => callback(0);
        },
      }),
    });
    supervisor.open("claude", "sess-2");
    await expect(supervisor.remove("claude", "sess-2")).resolves.toEqual({ removed: "trash" });
    expect(killed).toBe(true);
    expect(trashed).toEqual([[file]]);
    supervisor.dispose();
  });

  it("leaves a session the AI tool made itself alone, and does not offer to delete it", async () => {
    const { supervisor, trashed, listed } = setup({ madeHere: false });
    expect(supervisor.getSession("claude", "sess-1").deletable).toBeUndefined();
    await expect(supervisor.remove("claude", "sess-1")).rejects.toThrow("not_made_here");
    expect(trashed).toEqual([]);
    expect(listed()).toContain("sess-1");
    supervisor.dispose();
  });

  it("offers to delete a session created from the page", () => {
    const { supervisor } = setup();
    expect(supervisor.getSession("claude", "sess-1").deletable).toBe(true);
    supervisor.dispose();
  });

  it("remembers a session the page creates, so it can be deleted later", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "aimiss-delete-new-"));
    const cwd = path.join(root, "work");
    const project = path.join(root, "projects", encodeClaudeProject(cwd));
    mkdirSync(cwd, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(path.join(project, "old.jsonl"), JSON.stringify({ type: "user", sessionId: "old", cwd, message: { role: "user", content: "已有的会话" } }));
    const madeHere = createHiddenSessions(path.join(root, "created.json"));
    let output: (data: string) => void = () => {};
    const supervisor = createSupervisor({
      bins: { claudeExe: "claude.exe", nodeExe: "node.exe", codexJs: "codex.js" },
      roots: { claudeProjectsDir: path.join(root, "projects"), codexSessionsDir: path.join(root, "sessions"), claudeDataDir: "" },
      listProcesses: () => [],
      madeHere,
      spawn: () => {
        setTimeout(() => output("? for shortcuts"), 10);
        return { pid: 11, write() {}, resize() {}, kill() {}, onData(callback) { output = callback; }, onExit() {} };
      },
    });
    const view = await supervisor.create("claude", cwd);
    expect(view.deletable).toBe(true);
    // Remembered across a restart.
    expect(createHiddenSessions(path.join(root, "created.json")).has("claude", view.id)).toBe(true);
    expect(madeHere.has("claude", "old")).toBe(false);
    supervisor.dispose();
  });

  it("says when the session does not exist", async () => {
    const { supervisor } = setup();
    await expect(supervisor.remove("claude", "nope")).rejects.toThrow("unknown_session");
    supervisor.dispose();
  });
});
