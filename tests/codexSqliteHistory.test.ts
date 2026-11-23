import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { indexSessions, readCatalog, readSession } from "../src/catalog/readCatalog";
import { createSupervisor } from "../src/process/supervisor";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require(["node", "sqlite"].join(":"));
function fixture(withProjectList = true) {
  const home = mkdtempSync(path.join(tmpdir(), "mirrormix-codex-sql-"));
  const sessions = path.join(home, "sessions");
  const project = path.join(home, "project");
  mkdirSync(sessions);
  mkdirSync(project);
  if (withProjectList) writeFileSync(path.join(home, ".codex-global-state.json"), JSON.stringify({ "project-order": [project] }));
  const state = new DatabaseSync(path.join(home, "state_5.sqlite"));
  state.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, name TEXT, title TEXT, history_mode TEXT,
    source TEXT, thread_source TEXT, archived INTEGER, updated_at INTEGER, recency_at INTEGER, model TEXT, reasoning_effort TEXT)`);
  const history = new DatabaseSync(path.join(home, "thread_history_1.sqlite"));
  history.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER, status TEXT, started_at INTEGER, completed_at INTEGER);
    CREATE TABLE thread_items (thread_id TEXT, turn_id TEXT, item_id TEXT, rollout_ordinal INTEGER, created_at_ms INTEGER, item_json TEXT)`);
  const thread = (id: string, options: { archived?: number; source?: string; threadSource?: string; name?: string | null } = {}) => {
    state.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      id, project, options.name === undefined ? `Title ${id}` : options.name, "Original prompt", "paginated",
      options.source ?? "vscode", options.threadSource ?? "user", options.archived ?? 0, 200, 200, "gpt-test", "high");
    history.prepare("INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?, ?)").run(id, "turn-1", 1, "completed", 100, 120);
  };
  let ordinal = 2;
  const item = (id: string, value: object | string, turn = "turn-1") => {
    const n = ordinal++;
    history.prepare("INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?)").run(id, turn, `item-${n}`, n, n * 1000,
      typeof value === "string" ? value : JSON.stringify(value));
  };
  const roots = { claudeProjectsDir: "", claudeDataDir: "", codexSessionsDir: sessions };
  return { home, project, sessions, state, history, thread, item, roots, close: () => { state.close(); history.close(); } };
}

describe("Codex paginated SQLite history", () => {
  it("does not start a second writer if the paginated desktop thread cannot be opened", async () => {
    const f = fixture();
    f.thread("chat");
    const spawn = vi.fn(() => { throw new Error("Unexpected CLI fallback"); });
    const supervisor = createSupervisor({ roots: f.roots, bins: { claudeExe: "", nodeExe: "", codexJs: "codex.js" }, listProcesses: () => [],
      spawn, submitCodex: async () => { throw new Error("missing"); }, codexDesktopSession: () => ({ title: "Title chat" }) });
    try {
      supervisor.open("codex", "chat");
      await expect(supervisor.send("codex", "chat", "unsent")).rejects.toMatchObject({ code: "codex_unavailable" });
      expect(spawn).not.toHaveBeenCalled();
      expect(supervisor.getSession("codex", "chat").messages.some(message => message.id === "pending-user")).toBe(false);
    } finally { supervisor.dispose(); f.close(); }
  });

  it("restores retry after an unconfirmed send and sends normally after a real interrupt", async () => {
    const f = fixture();
    f.thread("chat");
    f.item("chat", { type: "userMessage", content: [{ type: "text", text: "same text" }] });
    const submit = vi.fn(async (_title: string, text: string) => {
      f.item("chat", { type: "userMessage", content: [{ type: "text", text }] }, "turn-2");
    });
    submit.mockImplementationOnce(async () => {});
    const stop = vi.fn(async () => {
      f.history.prepare("UPDATE thread_turns SET status='interrupted', completed_at=210 WHERE turn_id='turn-2'").run();
    });
    const supervisor = createSupervisor({ roots: f.roots, bins: { claudeExe: "", nodeExe: "", codexJs: "" }, listProcesses: () => [],
      spawn: () => { throw new Error("Unexpected CLI"); }, submitCodex: submit, stopCodex: stop,
      codexDesktopSession: () => ({ title: "Title chat" }), codexReceiptMs: 30, pollMs: 5 });
    try {
      supervisor.open("codex", "chat");
      const unconfirmed = supervisor.send("codex", "chat", "same text");
      expect(supervisor.getSession("codex", "chat").messages.some(message => message.id === "pending-turn")).toBe(false);
      await expect(unconfirmed).rejects.toMatchObject({ code: "codex_delivery_unconfirmed" });
      expect(supervisor.getSession("codex", "chat")).toMatchObject({ sendEnabled: true });
      submit.mockImplementationOnce(async (_title, text) => {
        f.history.prepare("INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?, ?)").run("chat", "turn-2", 20, "inProgress", 200, null);
        f.item("chat", { type: "userMessage", content: [{ type: "text", text }] }, "turn-2");
      });
      await supervisor.send("codex", "chat", "next");
      expect(supervisor.getSession("codex", "chat").messages.some(message => message.role === "turn" && !message.endedAt)).toBe(true);
      await supervisor.interrupt("codex", "chat");
      expect(stop).toHaveBeenCalledWith("Title chat", "chat");
      await supervisor.send("codex", "chat", "after stop");
      expect(supervisor.getSession("codex", "chat").messages.some(message => message.id.startsWith("queued-"))).toBe(false);
    } finally { supervisor.dispose(); f.close(); }
  });

  it("finds database-only chats even without the desktop project list", () => {
    const f = fixture(false);
    try {
      f.thread("chat");
      f.item("chat", { type: "agentMessage", text: "Recovered answer" });
      const [session] = indexSessions(f.roots).codex;
      expect(session.cwd).toBe(f.project);
      expect(readSession("codex", session.filePath)?.messages[0].text).toBe("Recovered answer");
    } finally { f.close(); }
  });

  it("lists migrated chats without rollout files and opens their messages through the supervisor", () => {
    const f = fixture();
    try {
      f.thread("chat");
      f.item("chat", { type: "userMessage", content: [{ type: "text", text: "Question" }, { type: "localImage", path: "image.png" }] });
      f.item("chat", { type: "agentMessage", text: "Answer", phase: "final_answer" });
      const catalog = readCatalog(f.roots).codex;
      expect(catalog[0].sessions).toMatchObject([{ id: "chat", title: "Title chat", working: false }]);
      const summary = indexSessions(f.roots).codex[0];
      expect(summary.messages).toEqual([]); // Listing never loads all chat bodies.
      expect(summary.filePath).toMatch(/^codex-history:/);
      const supervisor = createSupervisor({ roots: f.roots, bins: { claudeExe: "", nodeExe: "", codexJs: "" }, listProcesses: () => [],
        spawn: () => { throw new Error("Reading a migrated chat must not launch a CLI"); } });
      try {
        const view = supervisor.getSession("codex", "chat");
        expect(view.messages.filter(m => m.role !== "turn").map(m => [m.role, m.text])).toEqual([
          ["user", "Question\n[图片]"], ["assistant", "Answer"],
        ]);
        expect(view.model).toBe("gpt-test");
      } finally { supervisor.dispose(); }
    } finally { f.close(); }
  });

  it("prefers full projected history over a surviving rollout tail and filters archived/subagent/CLI rows", () => {
    const f = fixture();
    try {
      f.thread("chat");
      f.thread("archived", { archived: 1 });
      f.thread("sub", { threadSource: "subagent" });
      f.thread("cli", { source: "cli", name: null });
      f.item("chat", { type: "userMessage", content: [{ type: "text", text: "Full earlier question" }] });
      writeFileSync(path.join(f.sessions, "tail.jsonl"), [
        JSON.stringify({ type: "session_meta", payload: { id: "chat", cwd: f.project } }),
        JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "Tail only" } }),
      ].join("\n"));
      const sessions = indexSessions(f.roots).codex;
      expect(sessions.map(s => s.id)).toEqual(["chat"]);
      expect(readSession("codex", sessions[0].filePath)?.messages[0].text).toBe("Full earlier question");
    } finally { f.close(); }
  });

  it("refreshes WAL changes, preserves turn order and tools, and skips corrupt items", () => {
    const f = fixture();
    try {
      f.thread("chat");
      f.item("chat", { type: "userMessage", content: [{ type: "text", text: "First" }] });
      f.item("chat", "{broken");
      f.item("chat", { type: "commandExecution", command: "example", status: "completed", exitCode: 1, aggregatedOutput: "failed" });
      f.item("chat", { type: "agentMessage", text: "First answer" });
      const ref = indexSessions(f.roots).codex[0].filePath;
      expect(readSession("codex", ref)?.messages.find(m => m.role === "step")?.result?.status).toBe("error");
      f.history.prepare("INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?, ?)").run("chat", "turn-2", 20, "inProgress", 200, null);
      f.item("chat", { type: "userMessage", content: [{ type: "text", text: "Second" }] }, "turn-2");
      expect(readCatalog(f.roots).codex[0].sessions[0].working).toBe(true);
      const live = readSession("codex", ref)!;
      expect(live.messages.filter(m => m.role === "user").map(m => m.text)).toEqual(["First", "Second"]);
      expect(live.messages.at(-1)?.role).toBe("turn");
      expect(live.messages.at(-1)?.endedAt).toBeUndefined();
      expect(live.turnComplete).toBe(false);
      f.history.prepare("UPDATE thread_turns SET status='interrupted', completed_at=210 WHERE turn_id='turn-2'").run();
      f.history.prepare("UPDATE thread_turns SET status='inProgress', completed_at=NULL WHERE turn_id='turn-1'").run();
      expect(readSession("codex", ref)).toMatchObject({ turnComplete: true, interruptedAt: expect.any(Number) });
      expect(readSession("codex", ref)?.messages.filter(m => m.role === "turn" && !m.endedAt)).toEqual([]);
      expect(readCatalog(f.roots).codex[0].sessions[0].working).toBe(false);
    } finally { f.close(); }
  });
});
