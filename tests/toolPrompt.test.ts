import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createSupervisor, promptFromAsk, type PtyLike } from "../src/process/supervisor";
import { askOf } from "../src/transcript/claude";
import { asksInTranscript } from "../src/catalog/readCatalog";

const sessionId = "22222222-2222-4222-8222-222222222222";
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

function codexTerminal() {
  const root = mkdtempSync(path.join(tmpdir(), "aimiss-prompt-"));
  const cwd = path.join(root, "work");
  const sessions = path.join(root, "sessions");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(sessions, { recursive: true });
  writeFileSync(
    path.join(sessions, "thread.jsonl"),
    JSON.stringify({ type: "session_meta", payload: { id: sessionId, cwd } }) + "\n" +
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "build it" } }),
  );
  const writes: string[] = [];
  let output: (data: string) => void = () => undefined;
  const pty: PtyLike = {
    pid: 7,
    write: (data) => void writes.push(data),
    resize() {},
    kill() {},
    onData: (callback) => void (output = callback),
    onExit() {},
  };
  const supervisor = createSupervisor({
    bins: { claudeExe: "claude.exe", nodeExe: "node.exe", codexJs: "codex.js" },
    roots: { claudeProjectsDir: path.join(root, "projects"), codexSessionsDir: sessions, claudeDataDir: "" },
    listProcesses: () => [],
    spawn: () => pty,
  });
  return { supervisor, writes, show: (lines: string[]) => output("\u001b[2J\u001b[H" + lines.join("\r\n")) };
}

const approval = [
  "• Running the build",
  "",
  "  Would you like to run the following command?",
  "",
  "  $ npm run build",
  "",
  "› 1. Yes, proceed (y)",
  "  2. Yes, and don't ask again for this command (a)",
  "  3. No, and tell Codex what to do differently (esc)",
  "",
  "  Press enter to confirm or esc to cancel",
];

describe("answering what the tool asks, from the page", () => {
  it("shows a terminal's approval menu and answers it with keys", async () => {
    const { supervisor, writes, show } = codexTerminal();
    supervisor.open("codex", sessionId);
    show(approval);
    await settle();
    const prompt = supervisor.getSession("codex", sessionId).prompt!;
    expect(prompt).toMatchObject({ kind: "permission", title: "Would you like to run the following command?", detail: "$ npm run build", via: "terminal" });
    expect(prompt.options.map((option) => option.label)).toEqual(["Yes, proceed", "Yes, and don't ask again for this command", "No, and tell Codex what to do differently"]);

    writes.length = 0;
    await supervisor.answerPrompt("codex", sessionId, prompt.id, "3");
    expect(writes).toEqual(["\u001b[B\u001b[B\r"]);
    // An answer meant for a question that is no longer on screen is refused, never typed.
    show(["• Done", "", "› "]);
    await settle();
    await expect(supervisor.answerPrompt("codex", sessionId, prompt.id, "1")).rejects.toThrow("no_question");
    expect(supervisor.getSession("codex", sessionId).prompt).toBeUndefined();
    supervisor.dispose();
  });

  it("refuses an answer once the question on screen changed", async () => {
    const { supervisor, writes, show } = codexTerminal();
    supervisor.open("codex", sessionId);
    show(approval);
    await settle();
    const first = supervisor.getSession("codex", sessionId).prompt!;
    show(approval.map((line) => line.replace("npm run build", "rm -rf dist")));
    await settle();
    writes.length = 0;
    await expect(supervisor.answerPrompt("codex", sessionId, first.id, "1")).rejects.toThrow("prompt_changed");
    expect(writes).toEqual([]);
    supervisor.dispose();
  });

  it("reads a desktop app's question by its buttons and clicks the one picked", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "aimiss-prompt-window-"));
    const projects = path.join(root, "projects", "fixture");
    mkdirSync(projects, { recursive: true });
    writeFileSync(
      path.join(projects, "claude-thread.jsonl"),
      [
        { type: "user", sessionId: "claude-thread", cwd: root, message: { role: "user", content: "deploy" } },
        { type: "assistant", sessionId: "claude-thread", cwd: root, message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm run deploy" } }] } },
      ].map((row) => JSON.stringify(row)).join("\n"),
    );
    const answerWindowPrompt = vi.fn(async () => {});
    const supervisor = createSupervisor({
      bins: { claudeExe: "", nodeExe: "", codexJs: "" },
      desktopOnly: true,
      roots: { claudeProjectsDir: path.join(root, "projects"), codexSessionsDir: path.join(root, "none"), claudeDataDir: "" },
      listProcesses: () => [],
      spawn: () => {
        throw new Error("CLI");
      },
      submitDesktop: async () => {},
      readDesktopStream: () => "",
      desktopSession: () => ({ title: "Deploy" }),
      readWindowPrompt: (tool, title) =>
        tool === "claude" && title === "Deploy" ? { title: "Allow Claude to run this command?", detail: "npm run deploy", buttons: ["Allow once", "Always allow", "Deny"] } : null,
      answerWindowPrompt,
    });
    supervisor.open("claude", "claude-thread");
    const prompt = supervisor.getSession("claude", "claude-thread").prompt!;
    expect(prompt).toMatchObject({ kind: "permission", title: "Allow Claude to run this command?", detail: "npm run deploy", via: "window" });
    expect(prompt.options.map((option) => [option.label, option.tone])).toEqual([
      ["Allow once", "yes"],
      ["Always allow", "yes"],
      ["Deny", "no"],
    ]);
    // The list marks it too, so the workbench can say it is waiting on the person.
    const listed = supervisor.catalog().claude.flatMap((group) => group.sessions).find((session) => session.id === "claude-thread");
    expect(listed).toMatchObject({ asking: true, working: true });

    await supervisor.answerPrompt("claude", "claude-thread", prompt.id, "Allow once");
    expect(answerWindowPrompt).toHaveBeenCalledWith("claude", "Deploy", "Allow once", "claude-thread");
    supervisor.dispose();
  });

  it("keeps an AskUserQuestion from the transcript until it is answered", () => {
    const ask = askOf("AskUserQuestion", {
      questions: [{ header: "Scope", question: "Which tools?", options: [{ label: "Terminal", description: "Just terminals" }, { label: "All" }] }],
    });
    expect(ask.ask).toEqual({
      kind: "question",
      questions: [{ header: "Scope", question: "Which tools?", options: [{ label: "Terminal", description: "Just terminals" }, { label: "All" }] }],
    });
    const prompt = promptFromAsk(ask.ask!, true);
    expect(prompt).toMatchObject({ kind: "question", header: "Scope", title: "Which tools?", via: "window" });
    expect(prompt.readOnly).toBeUndefined();
    expect(prompt.options).toEqual([{ id: "Terminal", label: "Terminal", description: "Just terminals" }, { id: "All", label: "All" }]);
    // With nowhere to click it, the card only says what is asked.
    expect(promptFromAsk(ask.ask!, false).readOnly).toBe(true);

    const step = { id: "s", role: "step" as const, text: "", tool: "AskUserQuestion", result: { status: "running" as const }, ...ask };
    expect(asksInTranscript({ turnComplete: false, messages: [{ id: "u", role: "user", text: "go" }, step] })).toBe(true);
    expect(asksInTranscript({ turnComplete: false, messages: [{ ...step, result: { status: "ok" } }] })).toBe(false);
    expect(asksInTranscript({ turnComplete: false, messages: [step, { id: "u2", role: "user", text: "never mind" }] })).toBe(false);
  });
});
