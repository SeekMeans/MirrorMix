import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { parseCodexJsonl } from "../src/transcript/codex";
import { indexSessions, readSession } from "../src/catalog/readCatalog";
import { createSupervisor } from "../src/process/supervisor";
import { createApp, listenLocal } from "../src/server/app";

const record = (type: string, payload: Record<string, unknown>, ordinal?: number) => JSON.stringify({ type, payload, ordinal });
const meta = record("session_meta", { id: "thread", cwd: tmpdir() });
const item = (role: string, text: string, extra = {}) => record("response_item", {
  type: "message", role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text }], ...extra,
});

describe("desktop Codex transcripts", () => {
  it("finishes a paginated turn when its completed final item is persisted without task_complete", () => {
    const parsed = parseCodexJsonl([
      meta, record("event_msg", { type: "task_started" }), item("user", "ping"),
      item("assistant", "pong", { phase: "final_answer", status: "completed" }),
    ].join("\n"), "2026-11-16");
    expect(parsed?.turnComplete).toBe(true);
    const next = parseCodexJsonl([
      meta, record("event_msg", { type: "task_started" }),
      item("assistant", "pong", { phase: "final_answer", status: "completed" }),
      record("event_msg", { type: "task_started" }), item("user", "again"),
    ].join("\n"), "2026-11-16");
    expect(next?.turnComplete).toBe(false);
  });
  it("reads message items without exposing developer instructions or injected user context", () => {
    const parsed = parseCodexJsonl([
      meta,
      item("developer", "internal instructions"),
      item("system", "system context"),
      item("user", "environment context", { internal_chat_message_metadata_passthrough: { content_item_kinds: ["environments.environment_context"] } }),
      record("response_item", { type: "message", role: "user", content: [
        { type: "input_text", text: "AGENTS.md" }, { type: "input_text", text: "我的问题" },
        { type: "input_image", image_url: "data:image/png;base64,private" },
      ], internal_chat_message_metadata_passthrough: { content_item_kinds: ["agents_md.instructions", "user.text", "user.image"] } }),
      item("assistant", "我先检查", { phase: "commentary" }),
      item("assistant", "hidden analysis", { phase: "analysis" }),
      item("assistant", "结果如下", { phase: "final_answer" }),
    ].join("\n"), "2026-11-16");
    expect(parsed?.messages.map(({ role, text }) => [role, text])).toEqual([
      ["user", "我的问题\n[图片]"], ["assistant", "我先检查"], ["assistant", "结果如下"],
    ]);
    expect(parsed?.title).toBe("我的问题 [图片]");
  });

  it("pairs dual-format copies in either order while preserving intentional repetitions and tools", () => {
    const parsed = parseCodexJsonl([
      meta, record("event_msg", { type: "task_started" }),
      record("event_msg", { type: "user_message", message: "继续" }), item("user", "继续"),
      item("user", "继续"), record("event_msg", { type: "user_message", message: "继续" }),
      record("response_item", { type: "function_call", name: "shell", call_id: "c1", arguments: '{"command":["pwd"]}' }),
      item("assistant", "好了"), record("event_msg", { type: "agent_message", message: "好了" }),
      record("event_msg", { type: "task_complete" }),
      record("event_msg", { type: "task_started" }), item("user", "继续"), item("assistant", "好了"),
      record("event_msg", { type: "task_complete" }),
    ].join("\n"), "2026-11-16");
    expect(parsed?.messages.map(({ role, text }) => [role, text])).toEqual([
      ["user", "继续"], ["user", "继续"], ["step", "pwd"], ["assistant", "好了"], ["user", "继续"], ["assistant", "好了"],
    ]);
  });

  it("joins a resumed rollout's historical prefix and invalidates the cache when its source changes", () => {
    const root = mkdtempSync(path.join(tmpdir(), "codex-history-"));
    const sessions = path.join(root, "sessions");
    mkdirSync(sessions);
    const original = path.join(sessions, "a-thread.jsonl");
    const resumed = path.join(sessions, "b-thread.jsonl");
    const originalRows = [
      record("session_meta", { id: "thread", cwd: root }, 0),
      record("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "早期问题" }] }, 1),
      record("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "早期回复" }] }, 2),
      record("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "旧分支尾部" }] }, 3),
    ];
    writeFileSync(resumed, [
      record("session_meta", { id: "thread", cwd: root, history_base: { thread_id: "thread", end_ordinal_exclusive: 3 } }, 3),
      record("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "后续问题" }] }, 4),
      record("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "后续回复" }] }, 5),
    ].join("\n"));
    const roots = { claudeProjectsDir: "", claudeDataDir: "", codexSessionsDir: sessions };
    indexSessions(roots);
    expect(readSession("codex", resumed)?.messages.map((m) => m.text)).toEqual(["后续问题", "后续回复"]);
    // A desktop may materialize the historical source after the tail has already been read.
    writeFileSync(original, originalRows.join("\n"));
    indexSessions(roots);
    expect(readSession("codex", resumed)?.messages.map((m) => m.text)).toEqual(["早期问题", "早期回复", "后续问题", "后续回复"]);
    writeFileSync(original, originalRows.join("\n").replace("早期回复", "更新后的早期回复"));
    expect(readSession("codex", resumed)?.messages[1].text).toBe("更新后的早期回复");
    const latest = path.join(sessions, "c-thread.jsonl");
    writeFileSync(latest, [
      record("session_meta", { id: "thread", cwd: root, history_base: { thread_id: "thread", end_ordinal_exclusive: 6 } }, 6),
      record("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "第三段" }] }, 7),
    ].join("\n"));
    indexSessions(roots);
    expect(readSession("codex", latest)?.messages.map((m) => m.text)).toEqual(["早期问题", "更新后的早期回复", "后续问题", "后续回复", "第三段"]);
  });

  it("returns historical message pages through the authenticated API", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "codex-pages-"));
    const sessions = path.join(root, "sessions");
    mkdirSync(sessions);
    const lines = [record("session_meta", { id: "thread", cwd: root })];
    for (let i = 0; i < 70; i++) lines.push(item("user", `问题 ${i}`), item("assistant", `回复 ${i}`));
    writeFileSync(path.join(sessions, "thread.jsonl"), lines.join("\n"));
    const supervisor = createSupervisor({
      roots: { claudeProjectsDir: "", claudeDataDir: "", codexSessionsDir: sessions },
      bins: { claudeExe: "", nodeExe: "", codexJs: "" }, listProcesses: () => [],
      spawn() { throw new Error("history reads must not start a process"); },
    });
    const server = createApp(supervisor, undefined, { verify: async (u, p) => u === "test" && p === "fixture" });
    await listenLocal(server, 0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect((await fetch(`${base}/api/sessions/codex/thread`)).status).toBe(401);
      const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "test", password: "fixture" }) });
      const cookie = login.headers.get("set-cookie")!.split(";")[0];
      const pages = [];
      for (const query of ["", "?before=80&limit=60", "?before=20&limit=60"]) {
        const response = await fetch(`${base}/api/sessions/codex/thread${query}`, { headers: { cookie } });
        expect(response.status).toBe(200);
        pages.push(await response.json());
      }
      expect(pages.map((page) => [page.total, page.offset, page.messages.length])).toEqual([[140, 80, 60], [140, 20, 60], [140, 0, 20]]);
      expect(pages[2].messages[0].text).toBe("问题 0");
      expect(pages[0].messages.at(-1).text).toBe("回复 69");
    } finally {
      supervisor.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
