import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSupervisor, type PtyLike } from "../src/process/supervisor";

const sessionId = "11111111-1111-4111-8111-111111111111";

function codexFixture(locked: boolean) {
  const root = mkdtempSync(path.join(tmpdir(), "aimiss-codex-lock-"));
  const cwd = path.join(root, "work");
  const sessions = path.join(root, "sessions");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(sessions, { recursive: true });
  writeFileSync(
    path.join(sessions, "thread.jsonl"),
    JSON.stringify({ type: "session_meta", payload: { id: sessionId, cwd } }) + "\n" +
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "你好" } }),
  );
  const writes: string[] = [];
  const queued: string[] = [];
  const pty: PtyLike = {
    pid: 4,
    write(data) {
      writes.push(data);
    },
    resize() {},
    kill() {},
    onData() {},
    onExit() {},
  };
  const supervisor = createSupervisor({
    bins: { claudeExe: "claude.exe", nodeExe: "node.exe", codexJs: "codex.js" },
    roots: { claudeProjectsDir: path.join(root, "projects"), codexSessionsDir: sessions, claudeDataDir: "" },
    listProcesses: () => [],
    workstationLocked: () => locked,
    queueCodex: async (_id, _cwd, text) => {
      queued.push(text);
    },
    spawn: () => pty,
  });
  return { supervisor, writes, queued };
}

describe("Codex while the screen is locked", () => {
  it("queues the message with the daemon instead of typing into the frozen terminal", async () => {
    const { supervisor, writes, queued } = codexFixture(true);
    supervisor.open("codex", sessionId);
    await supervisor.send("codex", sessionId, "锁屏也要发出去");
    expect(queued).toEqual(["锁屏也要发出去"]);
    expect(writes).toEqual([]);
    supervisor.dispose();
  });

  it("still types into the terminal when the screen is unlocked", async () => {
    const { supervisor, writes, queued } = codexFixture(false);
    supervisor.open("codex", sessionId);
    await supervisor.send("codex", sessionId, "正常发送");
    // Codex takes the text as a bracketed paste, then Enter on its own.
    expect(writes).toEqual(["\u001b[200~正常发送\u001b[201~", "\r"]);
    expect(queued).toEqual([]);
    supervisor.dispose();
  });
});
