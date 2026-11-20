import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { deepseekSessionFile, indexSessions, readSession } from "../src/catalog/readCatalog";
import { decodeFrames, parseDeepseekEvents, readDshEvents } from "../src/transcript/deepseek";
import { readDeepseekKey } from "../src/process/deepseekAgent";

describe("the API key DeepSeek Harness saved", () => {
  it("reads refs.DEEPSEEK_API_KEY, and nothing else of the file", () => {
    const root = mkdtempSync(path.join(tmpdir(), "aimiss-dsh-key-"));
    const file = path.join(root, ".credentials.yaml");
    writeFileSync(
      file,
      ["version: 1", "refs:", "  DEEPSEEK_API_KEY: sk-test0000", "records:", "  client-connection/browser-session:", "    kind: plain", "    payload:", "      secret: not-this-one", ""].join("\n"),
    );
    expect(readDeepseekKey(file)).toBe("sk-test0000");
    writeFileSync(file, "refs:\n  DEEPSEEK_API_KEY: \"sk-quoted\"\n");
    expect(readDeepseekKey(file)).toBe("sk-quoted");
    // A key of the same name elsewhere in the file is not the saved one.
    writeFileSync(file, "records:\n  DEEPSEEK_API_KEY: sk-wrong\n");
    expect(readDeepseekKey(file)).toBe("");
    expect(readDeepseekKey(path.join(root, "missing.yaml"))).toBe("");
  });
});

const t0 = Date.parse("2026-11-18T08:00:00.000Z");
const line = (value: unknown) => `${JSON.stringify(value)}\n`;

/** The app appends one zstd frame per write. */
function frames(...chunks: unknown[][]): Buffer {
  return Buffer.concat(chunks.map((events) => zstdCompressSync(Buffer.from(events.map(line).join("")))));
}

const header = { type: "session", version: 4, id: "session-abc", createdAt: t0, cwd: "E:\\work" };
const firstRound = [
  { type: "user/message", seq: 1, time: t0, data: { role: "user", id: "u1", source: { kind: "user" }, content: [{ type: "text", text: "读一下 README" }] } },
  { type: "user/message", seq: 2, time: t0, data: { role: "user", id: "s1", source: { kind: "runtime-context" }, content: [{ type: "text", text: "Current runtime context" }] } },
  { type: "turn/start", seq: 3, time: t0, data: { turn: 1 } },
  { type: "request/context", seq: 4, time: t0, data: { model: "deepseek-v4-pro" } },
  { type: "session/title", seq: 5, time: t0, data: { title: "读 README" } },
  {
    type: "assistant/message",
    seq: 6,
    time: t0 + 1_000,
    data: {
      usage: { outputTokens: 12 },
      message: {
        role: "assistant",
        content: [
          { type: "reasoning", text: "先读文件" },
          { type: "text", text: "我来读。" },
          { type: "tool-call", id: "c1", name: "read", arguments: JSON.stringify({ file_path: "E:\\work\\README.md" }) },
        ],
      },
    },
  },
];
const firstResult = [
  { type: "tool/result", seq: 7, time: t0 + 2_000, data: { message: { role: "tool", toolCallId: "c1", isError: false, content: [{ type: "text", text: "line one\nline two" }] } } },
  { type: "assistant/message", seq: 8, time: t0 + 3_000, data: { message: { role: "assistant", content: [{ type: "text", text: "读完了。" }] } } },
  { type: "turn/end", seq: 9, time: t0 + 3_000, data: { turn: 1, reason: { kind: "completed" } } },
];

describe("DeepSeek Harness sessions", () => {
  it("decodes every frame the app appended, not just the first", () => {
    const buffer = frames([header], firstRound, firstResult);
    expect(decodeFrames(buffer).split("\n").filter(Boolean)).toHaveLength(1 + firstRound.length + firstResult.length);
    expect(readDshEvents(buffer).at(-1)?.type).toBe("turn/end");
  });

  it("lays a finished round out like the other tools: the person's words, thinking, steps, reply, round end", () => {
    const parsed = parseDeepseekEvents(readDshEvents(frames([header], firstRound, firstResult)), new Date(t0).toISOString())!;
    expect(parsed).toMatchObject({ id: "session-abc", cwd: "E:\\work", title: "读 README", model: "deepseek-v4-pro", turnComplete: true });
    expect(parsed.messages.map((message) => message.role)).toEqual(["user", "thinking", "assistant", "step", "assistant", "turn"]);
    // Only what the person typed: the runtime context the app adds is not a message.
    expect(parsed.messages[0].text).toBe("读一下 README");
    expect(parsed.messages[3]).toMatchObject({ tool: "Read", text: "README.md", result: { status: "ok", lines: ["line one", "line two"] } });
    expect(parsed.messages[5]).toMatchObject({ role: "turn", tokens: 12, endedAt: new Date(t0 + 3_000).toISOString() });
  });

  it("keeps a round open while it runs, with its tool still running", () => {
    const parsed = parseDeepseekEvents(readDshEvents(frames([header], firstRound)), new Date(t0).toISOString())!;
    expect(parsed.turnComplete).toBe(false);
    expect(parsed.messages.find((message) => message.role === "step")?.result?.status).toBe("running");
    expect(parsed.messages.at(-1)).toMatchObject({ role: "turn", id: "d-running" });
  });

  it("knows a session the desktop app made by its agent preset, which the command line cannot continue", () => {
    const own = parseDeepseekEvents(readDshEvents(frames([header], firstRound)), new Date(t0).toISOString())!;
    expect(own.agentPreset).toBeUndefined();
    const app = parseDeepseekEvents(readDshEvents(frames([{ ...header, agentPreset: "standard" }], firstRound)), new Date(t0).toISOString())!;
    expect(app.agentPreset).toBe("standard");
    const switched = parseDeepseekEvents(
      readDshEvents(frames([{ ...header, agentPreset: "standard" }], [{ type: "agent-preset/selected", seq: 1, time: t0, data: { agentPreset: "cordis" } }], firstRound)),
      new Date(t0).toISOString(),
    )!;
    expect(switched.agentPreset).toBe("cordis");
  });

  it("shows why a round failed", () => {
    const failed = [
      firstRound[0],
      { type: "turn/start", seq: 3, time: t0, data: { turn: 1 } },
      { type: "turn/end", seq: 4, time: t0 + 500, data: { turn: 1, reason: { kind: "error", error: { message: "Authentication Fails", code: "AUTH" } } } },
    ];
    const parsed = parseDeepseekEvents(readDshEvents(frames([header], failed)), new Date(t0).toISOString())!;
    expect(parsed.turnComplete).toBe(true);
    expect(parsed.messages.some((message) => message.role === "assistant" && message.text.includes("Authentication Fails"))).toBe(true);
  });

  it("lists sessions from the sessions folder, finds one by id, and leaves out ones nobody wrote in", () => {
    const root = mkdtempSync(path.join(tmpdir(), "aimiss-dsh-"));
    const dir = path.join(root, "--E-work--");
    mkdirSync(path.join(dir, "session-abc"), { recursive: true });
    mkdirSync(path.join(dir, "session-empty"), { recursive: true });
    writeFileSync(path.join(dir, "session-abc", "session.v4.jsonl.zstd"), frames([header], firstRound, firstResult));
    writeFileSync(path.join(dir, "session-empty", "session.v4.jsonl.zstd"), frames([{ ...header, id: "session-empty" }]));
    const roots = { claudeProjectsDir: path.join(root, "none"), codexSessionsDir: path.join(root, "none"), claudeDataDir: "", deepseekSessionsDir: root };
    expect(indexSessions(roots).deepseek.map((session) => session.id)).toEqual(["session-abc"]);
    const file = deepseekSessionFile(root, "session-abc");
    expect(file).toBe(path.join(dir, "session-abc", "session.v4.jsonl.zstd"));
    expect(readSession("deepseek", file!)?.title).toBe("读 README");
  });
});
