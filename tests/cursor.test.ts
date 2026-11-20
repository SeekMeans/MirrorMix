import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { clearCursorCache, closeCursorDatabase, queueQueries, readCursorBubbles, readCursorQueue } from "../src/catalog/cursor";
import { readCatalog, readSession } from "../src/catalog/readCatalog";
import { resolveCursorAgent } from "../src/process/cursorAgent";
import { createSupervisor, reconcileQueue, shownActivity } from "../src/process/supervisor";
import { cursorTurns, exploringLine, liveTurnBubbles, mergeLiveTurn, parseCursorBubbles, parseCursorJsonl } from "../src/transcript/cursor";

describe("parseCursorJsonl", () => {
  it("uses Cursor's timestamp wrapper as the start of a reply", () => {
    const parsed = parseCursorJsonl(
      "chat-timing",
      [
        JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "<timestamp>Friday, Nov 20, 2026, 1:00 PM (UTC)</timestamp><user_query>hello</user_query>" }] } }),
        JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: "hi" }] } }),
        JSON.stringify({ type: "turn_ended", status: "success" }),
      ].join("\n"),
      "2026-11-20T13:03:00.000Z",
      "E:\\Me",
    );
    expect(parsed.messages.find((message) => message.role === "turn")).toMatchObject({
      startedAt: "2026-11-20T13:00:00.000Z",
      endedAt: "2026-11-20T13:03:00.000Z",
    });
  });

  it("keeps the reply unfinished until turn_ended, then marks an unread-ready transcript complete", () => {
    const open = [
      JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "看一下列表" }] } }),
      JSON.stringify({
        role: "assistant",
        message: { content: [{ type: "text", text: "我先看会话列表。" }, { type: "tool_use", name: "Read", input: { file_path: "src/Sidebar.tsx" } }] },
      }),
    ].join("\n");
    const running = parseCursorJsonl("chat-1", open, "2026-11-11T00:00:00.000Z", "E:\\Me");
    expect(running.turnComplete).toBe(false);
    expect(running.messages.map((message) => message.role)).toEqual(["user", "assistant", "step", "turn"]);
    expect(running.messages.find((message) => message.role === "step")).toMatchObject({ tool: "Read", text: "src/Sidebar.tsx" });

    const done = parseCursorJsonl("chat-1", `${open}\n${JSON.stringify({ type: "turn_ended", status: "success" })}`, "2026-11-11T00:01:00.000Z", "E:\\Me");
    expect(done.turnComplete).toBe(true);
    expect(done.messages.at(-1)).toMatchObject({ role: "turn", endedAt: "2026-11-11T00:01:00.000Z" });
  });

  it("keeps the reply under the question when Cursor writes that question and the answer again", () => {
    const query = "<timestamp>t</timestamp>\n<user_query>优化上面的tab</user_query>";
    const content = [
      JSON.stringify({ role: "user", message: { content: [{ type: "text", text: query }] } }),
      JSON.stringify({
        role: "assistant",
        message: { content: [{ type: "text", text: "先看限额存在哪。" }, { type: "tool_use", name: "Grep", input: { pattern: "quota" } }] },
      }),
      JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "<available_subagent_types>x</available_subagent_types>" }] } }),
      JSON.stringify({ role: "user", message: { content: [{ type: "text", text: query }] } }),
      JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: "三个 tab 下面会多一行。" }] } }),
      JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: "三个 tab 下面会多一行。" }] } }),
    ].join("\n");
    const parsed = parseCursorJsonl("chat-q", content, "2026-11-12T03:00:00.000Z", "E:\\Me");
    expect(parsed.messages.filter((message) => message.role === "user").map((message) => message.text)).toEqual(["优化上面的tab"]);
    expect(parsed.messages.filter((message) => message.role === "assistant").map((message) => message.text)).toEqual([
      "先看限额存在哪。",
      "三个 tab 下面会多一行。",
    ]);
    const turns = cursorTurns(parsed.messages);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.user).toBe("优化上面的tab");
    expect(turns[0]?.parts.map((part) => part.kind)).toEqual(["text", "tools", "text"]);

    const again = [
      JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "再看一次" }] } }),
      JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: "看过了。" }] } }),
      JSON.stringify({ type: "turn_ended", status: "success" }),
      JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "再看一次" }] } }),
      JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: "看过了。" }] } }),
    ].join("\n");
    const second = parseCursorJsonl("chat-q2", again, "2026-11-12T04:00:00.000Z", "E:\\Me");
    expect(second.messages.filter((message) => message.role === "user")).toHaveLength(2);
    expect(cursorTurns(second.messages)).toHaveLength(2);
  });
});

describe("cursor transcript shape", () => {
  it("shows the typed sentence, not the timestamp wrapper, and folds a live round the way Cursor does", () => {
    const wrapped = [
      "<timestamp>Thursday, Nov 12, 2026, 7:20 AM</timestamp>",
      "<user_query>",
      "把 Cursor 的显示对齐",
      "</user_query>",
    ].join("\n");
    const noise = "<timestamp>Thursday, Nov 12, 2026, 7:20 AM</timestamp>";
    const content = [
      JSON.stringify({ role: "user", message: { content: [{ type: "text", text: wrapped }] } }),
      JSON.stringify({ role: "user", message: { content: [{ type: "text", text: noise }] } }),
      JSON.stringify({
        role: "assistant",
        message: {
          content: [
            { type: "text", text: "先看记录。" },
            { type: "tool_use", name: "Read", input: { path: "E:\\Me\\AIMiss\\src\\transcript\\cursor.ts" } },
            { type: "tool_use", name: "Grep", input: { pattern: "listen", path: "src/server" } },
            { type: "tool_use", name: "Shell", input: { command: "npm test", description: "Run the tests" } },
            {
              type: "tool_use",
              name: "CallDynamicTool",
              input: { namespace: "cursor-computer-use", toolName: "computer_screenshot" },
            },
          ],
        },
      }),
      JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: "记录对上了。" }] } }),
    ].join("\n");
    const running = parseCursorJsonl("chat-3", content, "2026-11-12T00:00:00.000Z", "E:\\Me");
    expect(running.messages.filter((message) => message.role === "user").map((message) => message.text)).toEqual(["把 Cursor 的显示对齐"]);
    expect(running.messages.find((message) => message.tool === "CallDynamicTool")?.text).toBe("Computer Use/computer_screenshot");
    expect(running.messages.find((message) => message.tool === "Shell")?.text).toBe("Run the tests");

    const live = cursorTurns(running.messages);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      user: "把 Cursor 的显示对齐",
      live: true,
      answer: "先看记录。\n\n记录对上了。",
      files: 1,
      searches: 1,
      commands: 1,
      tools: 1,
      running: "Planning next moves",
    });
    expect(exploringLine(live[0], true)).toBe("Exploring 1 file, 1 search, 1 tool, ran 1 command");

    const done = parseCursorJsonl("chat-3", `${content}\n${JSON.stringify({ type: "turn_ended", status: "success" })}`, "2026-11-12T00:00:00.000Z", "E:\\Me");
    const finished = cursorTurns(done.messages);
    expect(finished[0]).toMatchObject({ live: false, answer: "记录对上了。", notes: ["先看记录。"], running: "" });
  });

  it("names the call that is still out, and plans the next move once it has returned", () => {
    const waiting = cursorTurns([
      { id: "u", role: "user", text: "看一下" },
      { id: "a", role: "assistant", text: "我先看文件。" },
      { id: "s", role: "step", tool: "read_file_v2", text: "src/App.tsx", result: { status: "running" } },
      { id: "n", role: "step", tool: "await", text: "", result: { status: "running" } },
      { id: "m", role: "step", tool: "mcp--", text: "", result: { status: "running" } },
      { id: "t", role: "turn", text: "", startedAt: "2026-11-12T00:00:00.000Z" },
    ]);
    expect(waiting[0].running).toBe("Reading App.tsx");
    expect(waiting[0].steps.map((step) => step.label)).toEqual(["Read App.tsx"]);
    expect(waiting[0].answer).toBe("我先看文件。");

    const between = cursorTurns([
      { id: "u", role: "user", text: "看一下" },
      { id: "s", role: "step", tool: "Read", text: "src/App.tsx", result: { status: "ok" } },
      { id: "e", role: "step", tool: "edit_file_v2", text: "src/App.tsx", result: { status: "ok" } },
      { id: "b", role: "step", tool: "mcp-cursor-ide-browser-browser_snapshot", text: "", result: { status: "ok" } },
      { id: "t", role: "turn", text: "", startedAt: "2026-11-12T00:00:00.000Z" },
    ]);
    expect(between[0].running).toBe("Planning next moves");
    expect(exploringLine(between[0], true)).toBe("Editing App.tsx, explored 1 file, 1 browser action");
  });

  it("remembers when a live round started so the page can count seconds", () => {
    const turns = cursorTurns([
      { id: "u", role: "user", text: "看一下" },
      { id: "s", role: "step", tool: "Read", text: "src/App.tsx", result: { status: "running" } },
      { id: "t", role: "turn", text: "", startedAt: "2026-11-12T03:00:00.000Z" },
    ]);
    expect(turns[0]?.live).toBe(true);
    expect(turns[0]?.startedAt).toBe("2026-11-12T03:00:00.000Z");
  });
});

describe("liveTurnBubbles", () => {
  it("keeps the round Cursor is still writing, including a call that has not finished", () => {
    const bubbles = liveTurnBubbles([
      { type: 1, text: "上一句", createdAt: "2026-11-12T01:00:00.000Z", toolName: "", toolInput: "", failed: false },
      { type: 2, text: "上一轮回复", createdAt: "2026-11-12T01:00:01.000Z", toolName: "", toolInput: "", failed: false },
      {
        type: 1,
        text: "<timestamp>t</timestamp>\n<user_query>把显示对齐</user_query>",
        createdAt: "2026-11-12T01:50:16.000Z",
        toolName: "",
        toolInput: "",
        failed: false,
      },
      { type: 2, text: "先看记录。", createdAt: "2026-11-12T01:50:27.000Z", toolName: "", toolInput: "", failed: false },
      {
        type: 2,
        text: "",
        createdAt: "2026-11-12T01:59:49.000Z",
        toolName: "read_file_v2",
        toolInput: { path: "src/App.tsx" },
        failed: false,
        running: true,
      },
      {
        type: 2,
        text: "",
        createdAt: "2026-11-12T01:59:50.000Z",
        toolName: "mcp-Computer Use-computer_screenshot",
        toolInput: "",
        failed: false,
      },
    ]);
    const turns = cursorTurns(parseCursorBubbles("chat-4", bubbles, "2026-11-12T01:59:50.000Z", "E:\\Me", false).messages);
    expect(turns[0]).toMatchObject({
      user: "把显示对齐",
      live: true,
      answer: "先看记录。",
      files: 1,
      tools: 1,
      running: "Reading App.tsx",
    });
    expect(turns[0].steps[1].label).toBe("Computer Use/computer_screenshot");
  });

  it("names a call from the fields Cursor stores, and keeps narration the transcript already wrote", () => {
    const fresh = parseCursorBubbles("chat-5", [
      { type: 1, text: "<user_query>看一下</user_query>", createdAt: "2026-11-12T03:07:39.000Z", toolName: "", toolInput: "", failed: false },
      { type: 2, text: "", createdAt: "2026-11-12T03:07:51.000Z", toolName: "read_file_v2", toolInput: { targetFile: "src/catalog/cursor.ts" }, failed: false },
      { type: 2, text: "", createdAt: "2026-11-12T03:08:00.000Z", toolName: "glob_file_search", toolInput: { globPattern: "**/*.ts", targetDirectory: "src" }, failed: false },
      { type: 2, text: "", createdAt: "2026-11-12T03:08:26.000Z", toolName: "edit_file_v2", toolInput: { relativeWorkspacePath: "src/process/supervisor.ts" }, failed: false, running: true },
      { type: 2, text: "", createdAt: "2026-11-12T03:08:30.000Z", toolName: "run_terminal_command_v2", toolInput: { command: "npx vitest run", commandDescription: "Run the tests" }, failed: false },
    ], "2026-11-12T03:08:30.000Z", "E:\\Me", false);
    const saved = [
      { id: "u", role: "user" as const, text: "看一下" },
      { id: "a", role: "assistant" as const, text: "先看记录。" },
      { id: "s", role: "step" as const, tool: "read_file_v2", text: "src/catalog/cursor.ts", result: { status: "ok" as const } },
      { id: "t", role: "turn" as const, text: "", startedAt: "2026-11-12T03:07:39.000Z" },
    ];
    const merged = mergeLiveTurn(saved, fresh.messages);
    const turn = cursorTurns(merged)[0];
    expect(turn.answer).toBe("先看记录。");
    expect(turn.steps.map((step) => step.label)).toEqual([
      "Read cursor.ts",
      "Glob **/*.ts",
      "Edit supervisor.ts",
      "Shell Run the tests",
    ]);
    expect(turn.steps[2].status).toBe("running");
    expect(turn.live).toBe(true);
    expect(turn.parts.map((part) => part.kind)).toEqual(["text", "tools"]);
  });

  it("leaves earlier rounds where they were when the latest round is still being written", () => {
    const fresh = parseCursorBubbles("chat-6", [
      { type: 1, text: "<user_query>看一下</user_query>", createdAt: "2026-11-12T03:07:39.000Z", toolName: "", toolInput: "", failed: false },
      { type: 2, text: "", createdAt: "2026-11-12T03:07:51.000Z", toolName: "read_file_v2", toolInput: { targetFile: "src/catalog/cursor.ts" }, failed: false, running: true },
    ], "2026-11-12T03:07:51.000Z", "E:\\Me", false);
    const saved = [
      { id: "u0", role: "user" as const, text: "上一问" },
      { id: "a0", role: "assistant" as const, text: "上一轮的回复。" },
      { id: "s0", role: "step" as const, tool: "Read", text: "old.ts", result: { status: "ok" as const } },
      { id: "u1", role: "user" as const, text: "看一下" },
      { id: "a1", role: "assistant" as const, text: "先看记录。" },
      { id: "t1", role: "turn" as const, text: "", startedAt: "2026-11-12T03:07:39.000Z" },
    ];
    const turns = cursorTurns(mergeLiveTurn(saved, fresh.messages));
    expect(turns.map((turn) => turn.user)).toEqual(["上一问", "看一下"]);
    expect(turns[0].answer).toBe("上一轮的回复。");
    expect(turns[0].steps.map((step) => step.label)).toEqual(["Read old.ts"]);
    expect(turns[1].answer).toBe("先看记录。");
    expect(turns[1].parts.map((part) => part.kind)).toEqual(["text", "tools"]);
    expect(turns[1].live).toBe(true);
  });

  it("does not paint an older question again under the reply that followed it", () => {
    const saved = [
      { id: "u0", role: "user" as const, text: "把状态放到名称前面" },
      { id: "a0", role: "assistant" as const, text: "已经放好了。" },
      { id: "t0", role: "turn" as const, text: "", startedAt: "2026-11-14T08:05:35.000Z", endedAt: "2026-11-14T08:06:00.000Z" },
      { id: "u1", role: "user" as const, text: "为什么最下面还有一条旧消息" },
      { id: "a1", role: "assistant" as const, text: "我先看记录。" },
      { id: "t1", role: "turn" as const, text: "", startedAt: "2026-11-14T08:17:41.000Z" },
    ];
    const fresh = parseCursorBubbles(
      "chat-old",
      [
        { type: 1, text: "<user_query>把状态放到名称前面</user_query>", createdAt: "2026-11-14T08:05:35.000Z", toolName: "", toolInput: "", failed: false },
        { type: 2, text: "", createdAt: "2026-11-14T08:05:40.000Z", toolName: "Read", toolInput: { file_path: "src/App.tsx" }, failed: false, running: true },
      ],
      "2026-11-14T08:17:41.000Z",
      "E:\\Me",
      false,
    );
    const merged = mergeLiveTurn(saved, fresh.messages);
    expect(merged.filter((message) => message.role === "user").map((message) => message.text)).toEqual(["把状态放到名称前面", "为什么最下面还有一条旧消息"]);
    expect(merged.at(-1)?.role).toBe("turn");
  });
});

describe("parseCursorBubbles", () => {
  it("keeps a separate timed round for each user message", () => {
    const parsed = parseCursorBubbles(
      "chat-timing",
      [
        { type: 1, text: "first", createdAt: "2026-11-20T09:00:00.000Z", toolName: "", toolInput: null, failed: false },
        { type: 2, text: "first reply", createdAt: "2026-11-20T09:02:00.000Z", toolName: "", toolInput: null, failed: false },
        { type: 1, text: "second", createdAt: "2026-11-20T10:00:00.000Z", toolName: "", toolInput: null, failed: false },
        { type: 2, text: "second reply", createdAt: "2026-11-20T10:03:00.000Z", toolName: "", toolInput: null, failed: false },
      ],
      "2026-11-20T10:03:00.000Z",
      "E:\\Me",
      true,
    );
    expect(parsed.messages.filter((message) => message.role === "turn")).toMatchObject([
      { startedAt: "2026-11-20T09:00:00.000Z", endedAt: "2026-11-20T09:02:00.000Z" },
      { startedAt: "2026-11-20T10:00:00.000Z", endedAt: "2026-11-20T10:03:00.000Z" },
    ]);
  });

  it("reads a composer chat that never wrote an agent transcript", () => {
    const parsed = parseCursorBubbles(
      "chat-2",
      [
        { type: 1, text: "你好", createdAt: "2026-11-07T12:43:20.000Z", toolName: "", toolInput: "", failed: false },
        {
          type: 2,
          text: "",
          createdAt: "2026-11-07T12:43:45.000Z",
          toolName: "Read",
          toolInput: JSON.stringify({ file_path: "src/App.tsx" }),
          failed: true,
        },
        { type: 2, text: "文件在这里。", createdAt: "2026-11-07T12:44:00.000Z", toolName: "", toolInput: "", failed: false },
      ],
      "2026-11-07T12:44:01.000Z",
      "E:\\Me",
      true,
    );
    expect(parsed.turnComplete).toBe(true);
    expect(parsed.messages.map((message) => message.role)).toEqual(["user", "step", "assistant", "turn"]);
    expect(parsed.messages[1]).toMatchObject({ tool: "Read", text: "src/App.tsx", result: { status: "error" } });
  });
});

describe("shownActivity", () => {
  it("calls an unfinished reply running and a finished unseen reply unseen, without an occupancy input", () => {
    expect(shownActivity({ working: true, unseen: true }, false, false)).toEqual({ working: true, unseen: false });
    expect(shownActivity({ working: false, unseen: true }, false, false)).toEqual({ working: false, unseen: true });
    expect(shownActivity({ working: false, unseen: false }, true, false)).toEqual({ working: true, unseen: false });
  });
});

describe("cursor catalog", () => {
  it("lists the same chats Cursor keeps, with a running reply and a finished unseen one", () => {
    const root = mkdtempSync(path.join(tmpdir(), "aimiss-cursor-"));
    const dbPath = path.join(root, "state.vscdb");
    const projects = path.join(root, "projects", "aime", "agent-transcripts", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    mkdirSync(projects, { recursive: true });
    writeFileSync(
      path.join(projects, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl"),
      JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "你好" }] } }),
    );
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require(["node", "sqlite"].join(":")) as {
      DatabaseSync: new (location: string) => {
        exec(sql: string): void;
        prepare(sql: string): { run(...args: unknown[]): unknown };
        close(): void;
      };
    };
    const db = new DatabaseSync(dbPath);
    db.exec(
      "CREATE TABLE composerHeaders (composerId TEXT, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER, recency INTEGER, checkpointAt INTEGER, value TEXT, subagentTypeName TEXT)",
    );
    db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)");
    const insert = db.prepare(
      "INSERT INTO composerHeaders (composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, value) VALUES (?, '', 0, ?, ?, ?, ?)",
    );
    const workspace = path.join(root, "workspace");
    const header = (name: string, updatedAt: number, extra: Record<string, unknown>) =>
      JSON.stringify({
        name,
        lastUpdatedAt: updatedAt,
        workspaceIdentifier: { uri: { fsPath: workspace } },
        ...extra,
      });
    insert.run("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 1_700_000_000_000, 0, 0, header("正在写", 1_700_000_000_000, { unfinishedRunAt: 1_700_000_000_000, hasUnreadMessages: true }));
    insert.run("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", 1_600_000_000_000, 0, 0, header("写完了", 1_600_000_000_000, { hasUnreadMessages: true }));
    insert.run("ffffffff-ffff-4fff-8fff-ffffffffffff", 1_650_000_000_000, 0, 0, header("停了", 1_650_000_000_000, { unfinishedRunAt: 1_650_000_000_000, hasUnreadMessages: true }));
    insert.run("cccccccc-cccc-4ccc-8ccc-cccccccccccc", 1_500_000_000_000, 1, 0, header("归档", 1_500_000_000_000, {}));
    insert.run("dddddddd-dddd-4ddd-8ddd-dddddddddddd", 1_500_000_000_000, 0, 1, header("子任务", 1_500_000_000_000, {}));
    const bubble = db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
    const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    bubble.run(
      `bubbleId:${id}:11111111-1111-4111-8111-111111111111`,
      JSON.stringify({ type: 1, text: "你好", createdAt: "2026-11-01T00:00:00.000Z" }),
    );
    bubble.run(
      `bubbleId:${id}:22222222-2222-4222-8222-222222222222`,
      JSON.stringify({ type: 2, text: "你好，我在。", createdAt: "2026-11-01T00:00:01.000Z" }),
    );
    bubble.run(
      `bubbleId:${id}:22222222-2222-4222-8222-222222222222/s:sub`,
      JSON.stringify({ type: 1, text: "子任务不该出现", createdAt: "2026-11-01T00:00:02.000Z" }),
    );
    bubble.run(
      "composerData:ffffffff-ffff-4fff-8fff-ffffffffffff",
      JSON.stringify({ status: "aborted", conversationCheckpointLastUpdatedAt: 1_650_000_000_000, lastUpdatedAt: 1_650_000_000_000 }),
    );
    db.close();
    clearCursorCache();

    const catalog = readCatalog({
      claudeProjectsDir: path.join(root, "missing-claude"),
      codexSessionsDir: path.join(root, "missing-codex"),
      claudeDataDir: "",
      cursorStateDb: dbPath,
      cursorProjectsDir: path.join(root, "projects"),
    });
    expect(catalog.cursor).toEqual([
      {
        path: workspace,
        missing: true,
        sessions: [
          expect.objectContaining({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", title: "正在写", working: true, unseen: false }),
          expect.objectContaining({ id: "ffffffff-ffff-4fff-8fff-ffffffffffff", title: "停了", working: false, unseen: true }),
          expect.objectContaining({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", title: "写完了", working: false, unseen: true }),
        ],
      },
    ]);
    const opened = readSession("cursor", "cursor:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", dbPath);
    expect(opened?.messages.map((message) => message.role)).toEqual(["user", "assistant", "turn"]);
    expect(opened?.messages[0]).toMatchObject({ text: "你好" });
    expect(opened?.messages[1]).toMatchObject({ text: "你好，我在。" });
  });
});

describe("readCursorBubbles", () => {
  it("picks up a later bubble whose id sorts before the ones already read", () => {
    const root = mkdtempSync(path.join(tmpdir(), "aimiss-cursor-bubbles-"));
    const dbPath = path.join(root, "state.vscdb");
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require(["node", "sqlite"].join(":")) as {
      DatabaseSync: new (location: string) => {
        exec(sql: string): void;
        prepare(sql: string): { run(...args: unknown[]): unknown };
        close(): void;
      };
    };
    const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const open = () => {
      const db = new DatabaseSync(dbPath);
      db.exec("CREATE TABLE IF NOT EXISTS cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)");
      return db;
    };
    const first = open();
    first.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
      `bubbleId:${id}:ffffffff-ffff-4fff-8fff-ffffffffffff`,
      JSON.stringify({ type: 1, text: "上一句", createdAt: "2026-11-14T08:00:00.000Z" }),
    );
    first.close();
    clearCursorCache();
    expect(readCursorBubbles(dbPath, id).map((bubble) => bubble.text)).toEqual(["上一句"]);
    closeCursorDatabase();

    const second = open();
    const insert = second.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
    insert.run(
      `bubbleId:${id}:00000000-0000-4000-8000-000000000001`,
      JSON.stringify({ type: 1, text: "<user_query>新的一句</user_query>", createdAt: "2026-11-14T08:10:00.000Z" }),
    );
    insert.run(
      `bubbleId:${id}:00000000-0000-4000-8000-000000000002`,
      JSON.stringify({ type: 2, text: "", createdAt: "2026-11-14T08:10:05.000Z", toolFormerData: { name: "Read", params: JSON.stringify({ file_path: "src/App.tsx" }), status: "loading" } }),
    );
    second.close();
    const later = new Date(Date.now() + 5_000);
    utimesSync(dbPath, later, later);
    for (const suffix of ["-wal", "-shm"]) {
      const side = `${dbPath}${suffix}`;
      if (existsSync(side)) utimesSync(side, later, later);
    }
    const bubbles = readCursorBubbles(dbPath, id);
    expect(bubbles.filter((bubble) => bubble.type === 1).map((bubble) => bubble.text).sort()).toEqual([
      "<user_query>新的一句</user_query>",
      "上一句",
    ]);
    expect(bubbles.some((bubble) => bubble.toolName === "Read" && bubble.running)).toBe(true);
    clearCursorCache();
  });
});

describe("cursor send", () => {
  it("hands the text to the Cursor window instead of the command-line agent", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "aimiss-cursor-send-"));
    const dbPath = path.join(root, "state.vscdb");
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require(["node", "sqlite"].join(":")) as {
      DatabaseSync: new (location: string) => {
        exec(sql: string): void;
        prepare(sql: string): { run(...args: unknown[]): unknown };
        close(): void;
      };
    };
    const db = new DatabaseSync(dbPath);
    db.exec(
      "CREATE TABLE composerHeaders (composerId TEXT, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER, recency INTEGER, checkpointAt INTEGER, value TEXT, subagentTypeName TEXT)",
    );
    db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)");
    const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    db.prepare(
      "INSERT INTO composerHeaders (composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, value) VALUES (?, '', 0, ?, 0, 0, ?)",
    ).run(
      id,
      1_600_000_000_000,
      JSON.stringify({ name: "写完了", lastUpdatedAt: 1_600_000_000_000, workspaceIdentifier: { uri: { fsPath: workspace } } }),
    );
    db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
      `bubbleId:${id}:11111111-1111-4111-8111-111111111111`,
      JSON.stringify({ type: 2, text: "上一句", createdAt: "2026-11-01T00:00:00.000Z" }),
    );
    db.close();
    clearCursorCache();

    const submitted: Array<{ title: string; text: string }> = [];
    let commandLine = false;
    const supervisor = createSupervisor({
      bins: { claudeExe: "claude.exe", nodeExe: "node.exe", codexJs: "codex.js" },
      roots: {
        claudeProjectsDir: path.join(root, "missing-claude"),
        codexSessionsDir: path.join(root, "missing-codex"),
        claudeDataDir: "",
        cursorStateDb: dbPath,
        cursorProjectsDir: path.join(root, "projects"),
      },
      listProcesses: () => [],
      spawn: () => {
        commandLine = true;
        throw new Error("spawn");
      },
      startCursor: () => {
        commandLine = true;
        return { kill() {} };
      },
      submitCursor: async (title, text) => {
        submitted.push({ title, text });
      },
    });
    supervisor.open("cursor", id);
    await supervisor.send("cursor", id, "下一句");
    expect(submitted).toEqual([{ title: "写完了", text: "下一句" }]);
    expect(commandLine).toBe(false);
    expect(supervisor.getSession("cursor", id).messages.some((message) => message.role === "user" && message.text === "下一句")).toBe(true);

    const busy = createSupervisor({
      bins: { claudeExe: "claude.exe", nodeExe: "node.exe", codexJs: "codex.js" },
      roots: {
        claudeProjectsDir: path.join(root, "missing-claude"),
        codexSessionsDir: path.join(root, "missing-codex"),
        claudeDataDir: "",
        cursorStateDb: dbPath,
        cursorProjectsDir: path.join(root, "projects"),
      },
      listProcesses: () => [],
      spawn: () => {
        throw new Error("spawn");
      },
      submitCursor: async () => {
        throw new Error("busy");
      },
    });
    busy.open("cursor", id);
    await expect(busy.send("cursor", id, "还在写")).rejects.toMatchObject({ status: 409, code: "not_idle" });
    expect(busy.getSession("cursor", id).messages.some((message) => message.text === "还在写")).toBe(false);

    // The window is tried first. Only when it reports that it cannot take the text does the command-line agent run.
    const runs: Array<{ id: string; text: string }> = [];
    let triedWindow = false;
    const locked = createSupervisor({
      bins: { claudeExe: "claude.exe", nodeExe: "node.exe", codexJs: "codex.js" },
      roots: {
        claudeProjectsDir: path.join(root, "missing-claude"),
        codexSessionsDir: path.join(root, "missing-codex"),
        claudeDataDir: "",
        cursorStateDb: dbPath,
        cursorProjectsDir: path.join(root, "projects"),
      },
      listProcesses: () => [],
      spawn: () => {
        throw new Error("spawn");
      },
      cursorStartWaitMs: 30,
      startCursor: (runId, _cwd, text) => {
        runs.push({ id: runId, text });
        return { kill() {} };
      },
      workstationLocked: () => true,
      submitCursor: async () => {
        triedWindow = true;
        throw new Error("locked");
      },
    });
    locked.open("cursor", id);
    await locked.send("cursor", id, "锁屏时发的");
    expect(triedWindow).toBe(true);
    expect(runs).toEqual([{ id, text: "锁屏时发的" }]);
    expect(locked.getSession("cursor", id)).toMatchObject({ takenOver: true });

    // The command-line agent is not signed in: it stops at once, and the page is told why.
    const signedOut = createSupervisor({
      bins: { claudeExe: "claude.exe", nodeExe: "node.exe", codexJs: "codex.js" },
      roots: {
        claudeProjectsDir: path.join(root, "missing-claude"),
        codexSessionsDir: path.join(root, "missing-codex"),
        claudeDataDir: "",
        cursorStateDb: dbPath,
        cursorProjectsDir: path.join(root, "projects"),
      },
      listProcesses: () => [],
      spawn: () => {
        throw new Error("spawn");
      },
      cursorStartWaitMs: 500,
      startCursor: (_runId, _cwd, _text, onExit) => {
        setTimeout(() => onExit(1, "Error: Authentication required. Please run 'agent login' first"), 5);
        return { kill() {} };
      },
      submitCursor: async () => {
        throw new Error("locked");
      },
    });
    signedOut.open("cursor", id);
    await expect(signedOut.send("cursor", id, "发不出去")).rejects.toMatchObject({ code: "cursor_login" });
    expect(signedOut.getSession("cursor", id).messages.some((message) => message.text === "发不出去")).toBe(false);
    signedOut.dispose();
    supervisor.dispose();
    busy.dispose();
    locked.dispose();
  });
});

describe("resolveCursorAgent", () => {
  it("picks the newest installed agent build", () => {
    const root = mkdtempSync(path.join(tmpdir(), "aimiss-agent-"));
    const older = path.join(root, "versions", "2026.1.1-aaaaaaa");
    const newer = path.join(root, "versions", "2026.11.2-00-00-00-bbbbbbb");
    mkdirSync(older, { recursive: true });
    mkdirSync(newer, { recursive: true });
    writeFileSync(path.join(older, "node.exe"), "");
    writeFileSync(path.join(older, "index.js"), "");
    writeFileSync(path.join(newer, "node.exe"), "");
    writeFileSync(path.join(newer, "index.js"), "");
    expect(resolveCursorAgent(root)).toEqual({ node: path.join(newer, "node.exe"), js: path.join(newer, "index.js") });
    expect(resolveCursorAgent(path.join(root, "missing"))).toBeNull();
  });
});

describe("Cursor list", () => {
  it("follows Cursor's sidebar: no removed workspaces, no chats that were never used, pins marked", () => {
    clearCursorCache();
    const root = mkdtempSync(path.join(tmpdir(), "aimiss-cursor-list-"));
    const user = path.join(root, "User");
    const dbPath = path.join(user, "globalStorage", "state.vscdb");
    const pinsPath = path.join(user, "workspaceStorage", "empty-window", "state.vscdb");
    const kept = path.join(root, "kept");
    const removed = path.join(root, "removed");
    for (const dir of [path.dirname(dbPath), path.dirname(pinsPath), kept, removed]) mkdirSync(dir, { recursive: true });

    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require(["node", "sqlite"].join(":")) as {
      DatabaseSync: new (location: string) => {
        exec(sql: string): void;
        prepare(sql: string): { run(...args: unknown[]): unknown };
        close(): void;
      };
    };
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE composerHeaders (composerId TEXT, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER, recency INTEGER, checkpointAt INTEGER, value TEXT, subagentTypeName TEXT)");
    db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)");
    db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
    const insert = db.prepare("INSERT INTO composerHeaders (composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, value) VALUES (?, '', 0, 0, 0, 0, ?)");
    const header = (folder: string, fields: Record<string, unknown>) =>
      JSON.stringify({ createdAt: 1_600_000_000_000, workspaceIdentifier: { uri: { fsPath: folder } }, ...fields });
    const pinned = "11111111-1111-4111-8111-111111111111";
    insert.run(pinned, header(kept, { name: "置顶的会话", lastUpdatedAt: 1_700_000_000_000 }));
    insert.run("22222222-2222-4222-8222-222222222222", header(kept, { name: "普通会话", lastUpdatedAt: 1_690_000_000_000 }));
    insert.run("33333333-3333-4333-8333-333333333333", header(kept, {}));
    insert.run("44444444-4444-4444-8444-444444444444", header(removed, { name: "被移除工作区里的会话", lastUpdatedAt: 1_695_000_000_000 }));
    db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(
      "cursor/glass.removedProjects",
      JSON.stringify([{ type: "workspace", name: "removed", workspaceIdentifier: { uri: { fsPath: removed.toUpperCase() } } }]),
    );
    db.close();

    const pins = new DatabaseSync(pinsPath);
    pins.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
    pins.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run("cursor/pinnedComposers", JSON.stringify([pinned]));
    pins.close();

    const groups = readCatalog({
      claudeProjectsDir: path.join(root, "none"),
      codexSessionsDir: path.join(root, "none-sessions"),
      claudeDataDir: "",
      cursorStateDb: dbPath,
      cursorProjectsDir: path.join(root, "projects"),
    }).cursor;
    expect(groups.map((group) => [path.basename(group.path), group.sessions.map((session) => [session.title, session.pinned])])).toEqual([
      ["kept", [["置顶的会话", true], ["普通会话", false]]],
    ]);
    expect(groups[0].pinned).toBe(true);
    clearCursorCache();
  });
});

describe("cursor queue", () => {
  it("drops a follow-up once Cursor has started it, and keeps one that is still queued there", () => {
    const now = 10_000;
    const started = reconcileQueue(
      [{ text: "已经开始了", seen: 0, at: now - 5_000 }],
      [],
      [],
      now,
    );
    expect(started).toEqual([]);

    const waiting = reconcileQueue(
      [{ text: "还在排队", seen: 0, at: now - 5_000 }],
      ["还在排队"],
      [],
      now,
    );
    expect(waiting.map((item) => item.text)).toEqual(["还在排队"]);

    const fresh = reconcileQueue([{ text: "刚发出", seen: 0, at: now - 200 }], [], [], now);
    expect(fresh.map((item) => item.text)).toEqual(["刚发出"]);

    const arrived = reconcileQueue([{ text: "刚发出", seen: 0, at: now - 200 }], [], ["刚发出"], now);
    expect(arrived).toEqual([]);
  });

  it("reads the queries Cursor still has queued", () => {
    expect(queueQueries([{ query: "第一条" }, { query: "  " }, { query: "第二条" }])).toEqual(["第一条", "第二条"]);

    const root = mkdtempSync(path.join(tmpdir(), "aimiss-queue-"));
    const dbPath = path.join(root, "state.vscdb");
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require(["node", "sqlite"].join(":")) as {
      DatabaseSync: new (location: string) => {
        exec(sql: string): void;
        prepare(sql: string): { run(...args: unknown[]): unknown };
        close(): void;
      };
    };
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)");
    db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
      "composerData:chat-1",
      JSON.stringify({ queueItems: [{ query: "还在排队" }], status: "generating" }),
    );
    db.close();
    expect(readCursorQueue(dbPath, "chat-1")).toEqual(["还在排队"]);
    expect(readCursorQueue(dbPath, "missing")).toBeNull();
    clearCursorCache();
  });
});

describe("a Cursor reply that is still being written", () => {
  it("keeps the sentences from its live store between the calls they were written between", () => {
    const step = (id: string, tool: string) => ({ id, role: "step" as const, tool, text: "", result: { status: "ok" as const } });
    const says = (id: string, text: string) => ({ id, role: "assistant" as const, text });
    const question = { id: "u", role: "user" as const, text: "把功能条挪上去" };
    // The saved transcript lags behind: it has the question and the first sentence only.
    const saved = [question, says("s1", "先看一下现在的布局。")];
    const fresh = [
      question,
      says("f1", "先看一下现在的布局。"),
      step("f2", "read_file_v2"),
      says("f3", "功能条压在黑框里面，"),
      step("f4", "edit_file_v2"),
      says("f5", "已经挪到黑框上面。"),
      { id: "t", role: "turn" as const, text: "", startedAt: "2026-11-14T00:00:00.000Z" },
    ];
    const merged = mergeLiveTurn(saved, fresh);
    expect(merged.map((message) => (message.role === "step" ? message.tool : message.role === "assistant" ? message.text : message.role))).toEqual([
      "user",
      "先看一下现在的布局。",
      "read_file_v2",
      "功能条压在黑框里面，",
      "edit_file_v2",
      "已经挪到黑框上面。",
      "turn",
    ]);

    // A sentence that was half written a moment ago is replaced by its longer form, not shown twice.
    const later = mergeLiveTurn(merged, [...fresh.slice(0, 3), says("f3", "功能条压在黑框里面，上面还空着一行。"), ...fresh.slice(4)]);
    expect(later.filter((message) => message.role === "assistant").map((message) => message.text)).toEqual([
      "先看一下现在的布局。",
      "功能条压在黑框里面，上面还空着一行。",
      "已经挪到黑框上面。",
    ]);
  });
});
