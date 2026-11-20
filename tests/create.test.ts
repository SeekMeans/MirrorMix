import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { encodeClaudeProject } from "../src/process/launch";
import { createSupervisor } from "../src/process/supervisor";
import { asksForTrust, trustKeys } from "../src/transcript/screen";

const NL = String.fromCharCode(13, 10);

const CLAUDE_TRUST = [
  " Accessing workspace:",
  " E:\\work",
  " Quick safety check: Is this a project you created or one you trust?",
  " ❯ No, exit",
  "   Yes, I trust this folder",
  " Enter to confirm · Esc to cancel",
];
const CODEX_TRUST = [
  "  Trust this folder? Codex can read, edit, and run files here.",
  "› 1. Trust and continue",
  "  2. Back to Agent Command Center",
  "  enter continue · esc back",
];

describe("the folder-trust question", () => {
  it("is recognised on both CLIs' screens and answered with the right keys", () => {
    expect(asksForTrust(CLAUDE_TRUST)).toBe(true);
    expect(trustKeys(CLAUDE_TRUST, "trust")).toBe("\u001b[B\r");
    expect(trustKeys(CLAUDE_TRUST, "cancel")).toBe("\r");
    expect(asksForTrust(CODEX_TRUST)).toBe(true);
    expect(trustKeys(CODEX_TRUST, "trust")).toBe("\r");
    expect(trustKeys(CODEX_TRUST, "cancel")).toBe("\u001b[B\r");
    expect(asksForTrust(["> ", "? for shortcuts"])).toBe(false);
    expect(trustKeys(["> "], "trust")).toBeNull();
  });
});

describe("creating a session from the page", () => {
  it("starts Claude Code under a chosen id, asks about trust, then takes messages", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "aimiss-create-"));
    const cwd = path.join(root, "work");
    const project = path.join(root, "projects", encodeClaudeProject(cwd));
    mkdirSync(cwd, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(path.join(project, "old.jsonl"), JSON.stringify({ type: "user", cwd, message: { role: "user", content: "以前的会话" } }));
    const launched: string[][] = [];
    const written: string[] = [];
    let emit: (data: string) => void = () => {};
    const supervisor = createSupervisor({
      bins: { claudeExe: "claude.exe", nodeExe: "node.exe", codexJs: "codex.js" },
      roots: { claudeProjectsDir: path.join(root, "projects"), codexSessionsDir: path.join(root, "sessions"), claudeDataDir: "" },
      listProcesses: () => [],
      pollMs: 20,
      spawn: (request) => {
        launched.push(request.args);
        setTimeout(() => emit(CLAUDE_TRUST.join(NL)), 10);
        return {
          pid: 41,
          write: (data: string) => {
            written.push(data);
            // Trusted: the menu goes away and the input line shows.
            if (data.endsWith("\r") && data.includes("\u001b[B")) emit("\u001b[2J\u001b[H> " + NL + "? for shortcuts");
          },
          resize() {},
          kill() {},
          onData: (callback: (data: string) => void) => {
            emit = callback;
          },
          onExit() {},
        };
      },
    });

    const view = await supervisor.create("claude", cwd);
    expect(launched[0]?.[0]).toBe("--session-id");
    expect(view.id).toBe(launched[0]?.[1]);
    expect(view).toMatchObject({ status: "running", question: "trust", sendEnabled: false });

    supervisor.answer("claude", view.id, "trust");
    expect(written).toEqual(["\u001b[B\r"]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const after = supervisor.getSession("claude", view.id);
    expect(after.question).toBeUndefined();
    expect(after.sendEnabled).toBe(true);

    await supervisor.send("claude", view.id, "你好");
    expect(written.at(-1)).toBe("你好\r");
    supervisor.dispose();
  });
});

describe("creating a Claude session through the desktop app", () => {
  const setup = (createDesktop: (folder: string, text: string) => Promise<void>, canCreate = true) => {
    const root = mkdtempSync(path.join(tmpdir(), "aimiss-desk-create-"));
    const cwd = path.join(root, "work");
    const projects = path.join(root, "projects");
    const project = path.join(projects, encodeClaudeProject(cwd));
    mkdirSync(cwd, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(path.join(project, "old.jsonl"), JSON.stringify({ type: "user", cwd, message: { role: "user", content: "以前的会话" } }));
    const launched: string[][] = [];
    const written: string[] = [];
    const supervisor = createSupervisor({
      bins: { claudeExe: "claude.exe", nodeExe: "node.exe", codexJs: "codex.js" },
      roots: { claudeProjectsDir: projects, codexSessionsDir: path.join(root, "sessions"), claudeDataDir: "" },
      listProcesses: () => [],
      pollMs: 20,
      createDesktop,
      desktopCanCreate: () => canCreate,
      spawn: (request) => {
        launched.push(request.args);
        let emit: (data: string) => void = () => {};
        setTimeout(() => emit("> " + NL + "? for shortcuts"), 10);
        return {
          pid: 42,
          write: (data: string) => { written.push(data); },
          resize() {},
          kill() {},
          onData: (callback: (data: string) => void) => { emit = callback; },
          onExit() {},
        };
      },
    });
    return { supervisor, cwd, project, launched, written };
  };

  it("waits for the first message, starts the session in the app and follows the file it writes", async () => {
    const asked: Array<[string, string]> = [];
    const { supervisor, cwd, project, launched } = setup(async (folder, text) => { asked.push([folder, text]); });
    const draft = await supervisor.create("claude", cwd);
    expect(draft).toMatchObject({ status: "running", sendEnabled: true });
    expect(launched).toEqual([]);

    await supervisor.send("claude", draft.id, "桌面版里新建");
    expect(asked).toEqual([[cwd, "桌面版里新建"]]);
    expect(supervisor.getSession("claude", draft.id).sendEnabled).toBe(false);

    writeFileSync(path.join(project, "desk-made.jsonl"), JSON.stringify({ type: "user", sessionId: "desk-made", cwd, message: { role: "user", content: "桌面版里新建" } }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(supervisor.getSession("claude", draft.id)).toMatchObject({ id: "desk-made", attached: "claude", sendEnabled: true });
    expect(launched).toEqual([]);
    supervisor.dispose();
  });

  it("starts the session in its own Claude Code under the same id when the app cannot", async () => {
    const { supervisor, cwd, launched, written } = setup(async () => { throw new Error("missing"); });
    const draft = await supervisor.create("claude", cwd);
    await supervisor.send("claude", draft.id, "命令行里新建");
    expect(launched[0]).toEqual(expect.arrayContaining(["--session-id", draft.id]));
    expect(written).toEqual(["命令行里新建\r"]);
    expect(supervisor.getSession("claude", draft.id)).toMatchObject({ id: draft.id, attached: "process" });
    supervisor.dispose();
  });

  it("starts at once in its own Claude Code when the app cannot take a new session now", async () => {
    const { supervisor, cwd, launched } = setup(async () => { throw new Error("must not be asked"); }, false);
    const view = await supervisor.create("claude", cwd);
    expect(launched[0]).toEqual(expect.arrayContaining(["--session-id", view.id]));
    supervisor.dispose();
  });
});
