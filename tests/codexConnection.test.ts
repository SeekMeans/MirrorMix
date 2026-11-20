import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createSupervisor } from "../src/process/supervisor";
import { createApp, listenLocal } from "../src/server/app";
import type { LaunchRequest } from "../src/shared/types";

describe("authenticated Codex connection", () => {
  it("lets a lazy Codex TUI receive its first message before binding the resulting rollout", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "codex-lazy-"));
    const sessions = path.join(root, "sessions");
    mkdirSync(sessions);
    const transcript = (id: string, text: string) => [
      JSON.stringify({ type: "session_meta", payload: { id, cwd: root } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } }),
    ].join("\n");
    writeFileSync(path.join(sessions, "existing.jsonl"), transcript("existing", "old"));
    let output!: (data: string) => void;
    const writes: string[] = [];
    const supervisor = createSupervisor({
      roots: { claudeProjectsDir: "", claudeDataDir: "", codexSessionsDir: sessions },
      bins: { claudeExe: "", nodeExe: "", codexJs: "", codexExe: "codex.exe" },
      listProcesses: () => [], pollMs: 10,
      spawn: () => ({ pid: 123, write: (text) => { writes.push(text); }, resize() {}, kill() {}, onData: (cb) => { output = cb; }, onExit() {} }),
    });
    try {
      const creating = supervisor.create("codex", root);
      output("› Ask Codex to do anything");
      const pending = await creating;
      expect(pending).toMatchObject({ id: "pending-123", status: "running", sendEnabled: true });
      writeFileSync(path.join(sessions, "unrelated.jsonl"), transcript("unrelated", "someone else's message"));
      await new Promise((resolve) => setTimeout(resolve, 35));
      expect(supervisor.getSession("codex", pending.id).id).toBe(pending.id);
      await supervisor.send("codex", pending.id, "first message");
      writeFileSync(path.join(sessions, "created.jsonl"), transcript("created", "first message"));
      await vi.waitFor(() => expect(supervisor.getSession("codex", pending.id).id).toBe("created"));
      expect(supervisor.getSession("codex", "created").messages[0].text).toBe("first message");
      await supervisor.send("codex", pending.id, "second message");
      expect(writes).toEqual(["\u001b[200~first message\u001b[201~", "\r", "\u001b[200~second message\u001b[201~", "\r"]);
      expect(supervisor.open("codex", pending.id).id).toBe("created");
    } finally { supervisor.dispose(); }
  });

  it("opens a native CLI session, streams its snapshot and writes a sent message to its terminal", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "codex-connection-"));
    const sessions = path.join(root, "sessions");
    mkdirSync(sessions);
    writeFileSync(path.join(sessions, "thread.jsonl"), [
      JSON.stringify({ type: "session_meta", payload: { id: "thread", cwd: root } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "历史问题" }] } }),
    ].join("\n"));
    const launches: LaunchRequest[] = [], writes: string[] = [];
    const supervisor = createSupervisor({
      roots: { claudeProjectsDir: "", claudeDataDir: "", codexSessionsDir: sessions },
      bins: { claudeExe: "claude.exe", nodeExe: "node.exe", codexJs: "", codexExe: "codex.exe" },
      listProcesses: () => [],
      spawn(spec) {
        launches.push(spec);
        return { pid: 100, write: (text) => { writes.push(text); }, resize() {}, kill() {}, onData() {}, onExit() {} };
      },
    });
    const server = createApp(supervisor, undefined, { verify: async (u, p) => u === "fixture" && p === "test" });
    await listenLocal(server, 0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    let socket: WebSocket | undefined;
    try {
      const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ username: "fixture", password: "test" }) });
      const cookie = login.headers.get("set-cookie")!.split(";")[0];
      const headers = { "content-type": "application/json", cookie, origin: base };
      const opened = await fetch(`${base}/api/sessions/open`, { method: "POST", headers, body: JSON.stringify({ tool: "codex", id: "thread" }) });
      expect(opened.status).toBe(200);
      expect(await opened.json()).toMatchObject({ status: "running", sendEnabled: true });
      expect(launches[0]).toMatchObject({ file: "codex.exe", args: ["resume", "thread"] });
      const first = await new Promise<Record<string, unknown>>((resolve, reject) => {
        socket = new WebSocket(`${base.replace("http", "ws")}/api/live?tool=codex&id=thread`, { headers: { cookie, origin: base } });
        socket.once("message", (data) => resolve(JSON.parse(String(data))));
        socket.once("error", reject);
      });
      expect(first).toMatchObject({ type: "snapshot", status: "running", messages: [{ role: "user", text: "历史问题" }] });
      const patch = new Promise<Record<string, unknown>>((resolve) => socket!.once("message", (data) => resolve(JSON.parse(String(data)))));
      const sent = await fetch(`${base}/api/sessions/send`, { method: "POST", headers, body: JSON.stringify({ tool: "codex", id: "thread", text: "连接测试" }) });
      expect(sent.status).toBe(200);
      expect(writes).toEqual(["\u001b[200~连接测试\u001b[201~", "\r"]);
      expect(await patch).toMatchObject({ type: "patch", messages: expect.arrayContaining([expect.objectContaining({ role: "user", text: "连接测试" })]) });
    } finally {
      socket?.terminate();
      supervisor.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
