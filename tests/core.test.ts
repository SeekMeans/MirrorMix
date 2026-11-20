import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readCatalog } from "../src/catalog/readCatalog";
import { describeRrule, readSchedules } from "../src/schedule/readSchedules";
import { encodeClaudeProject } from "../src/process/launch";
import { parseClaudeJsonl } from "../src/transcript/claude";
import { parseCodexJsonl } from "../src/transcript/codex";
import { screenAllowsInput } from "../src/transcript/screen";

describe("parseClaudeJsonl", () => {
  it("leaves out the summary Claude Code writes when the context is compacted", () => {
    const content = [
      JSON.stringify({ type: "user", cwd: "D:\\AutoWork", message: { role: "user", content: "第一句" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "好的" }] } }),
      JSON.stringify({
        type: "user",
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
        message: { role: "user", content: "This session is being continued from a previous conversation that ran out of context." },
      }),
      JSON.stringify({ type: "user", message: { role: "user", content: "接着做" } }),
    ].join("\n");
    const parsed = parseClaudeJsonl("sess-1.jsonl", content, "2026-11-11T00:00:00.000Z");
    const users = parsed?.messages.filter((message) => message.role === "user").map((message) => message.text);
    expect(users).toEqual(["第一句", "接着做"]);
  });

  it("keeps user and assistant text and shows tool calls as steps", () => {
    const content = [
      JSON.stringify({
        type: "user",
        cwd: "D:\\AutoWork",
        message: { role: "user", content: "看一下发布脚本" },
      }),
      "{not json",
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "thinking", thinking: "hidden" }] },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "cat scripts/publish.js", description: "读发布脚本" } }],
        },
      }),
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
        toolUseResult: { stdout: "module.exports = {}\nconsole.log('publish')\n", stderr: "", interrupted: false },
      }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "入口在 scripts/publish.js" }] },
      }),
      JSON.stringify({ type: "custom-title", customTitle: "修复发布脚本" }),
    ].join("\n");

    const parsed = parseClaudeJsonl("sess-1.jsonl", content, "2026-11-11T00:00:00.000Z");
    expect(parsed).toMatchObject({
      id: "sess-1",
      cwd: "D:\\AutoWork",
      title: "修复发布脚本",
      turnComplete: true,
    });
    expect(parsed?.messages.map((message) => [message.role, message.tool ?? "", message.text])).toEqual([
      ["user", "", "看一下发布脚本"],
      ["thinking", "", "hidden"],
      ["step", "Bash", "cat scripts/publish.js"],
      ["assistant", "", "入口在 scripts/publish.js"],
    ]);
    // The terminal prints the command's own output under the call.
    expect(parsed?.messages[2].result).toEqual({
      status: "ok",
      lines: ["module.exports = {}", "console.log('publish')"],
      more: 0,
    });
  });

  it("prints tool results the way the terminal does", () => {
    const tool = (id: string, name: string, input: unknown) =>
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } });
    const result = (id: string, structured: unknown, extra: Record<string, unknown> = {}) =>
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "x", ...extra }] },
        toolUseResult: structured,
      });
    const content = [
      JSON.stringify({ type: "user", cwd: "D:\\AutoWork", message: { role: "user", content: "改一下" } }),
      tool("r", "Read", { file_path: "D:\\AutoWork\\src\\a.ts" }),
      result("r", { type: "text", file: { numLines: 16 } }),
      tool("e", "Edit", { file_path: "D:\\AutoWork\\src\\a.ts", old_string: "a", new_string: "b" }),
      result("e", {
        filePath: "D:\\AutoWork\\src\\a.ts",
        structuredPatch: [{ oldStart: 3, newStart: 3, lines: [" keep", "-old", "+new", "+more"] }],
      }),
      tool("p", "mcp__ccd_turn__update_plan", { items: [{ content: "读", status: "in_progress" }, { content: "改", status: "pending" }] }),
      result("p", [{ type: "text", text: "Plan shown" }]),
      tool("p2", "mcp__ccd_turn__update_plan", { advance: true }),
      result("p2", [{ type: "text", text: "ok" }]),
      tool("b", "Bash", { command: "npm test" }),
      result("b", null, { is_error: true, content: "<tool_use_error>Exit code 1\nFAIL a.test.ts</tool_use_error>" }),
      tool("s", "mcp__Claude_Browser__navigate", { url: "http://localhost:3000" }),
      JSON.stringify({ type: "user", message: { role: "user", content: "停一下" } }),
    ].join("\n");

    const steps = parseClaudeJsonl("t.jsonl", content, "2026-11-11T00:00:00.000Z")!.messages.filter(
      (message) => message.role === "step",
    );
    expect(steps.map((step) => [step.tool, step.text])).toEqual([
      ["Read", "src\\a.ts"],
      ["Update", "src\\a.ts"],
      ["Update Todos", ""],
      ["Update Todos", ""],
      ["Bash", "npm test"],
      ["Claude_Browser - navigate (MCP)", 'url: "http://localhost:3000"'],
    ]);
    expect(steps[0].result).toEqual({ status: "ok", summary: "Read 16 lines" });
    expect(steps[1].result).toEqual({
      status: "ok",
      summary: "Updated src\\a.ts with 2 additions and 1 removal",
      diff: [
        { kind: " ", no: 3, text: "keep" },
        { kind: "-", no: 4, text: "old" },
        { kind: "+", no: 4, text: "new" },
        { kind: "+", no: 5, text: "more" },
      ],
    });
    expect(steps[3].result?.todos).toEqual([
      { text: "读", status: "completed" },
      { text: "改", status: "in_progress" },
    ]);
    expect(steps[4].result).toMatchObject({ status: "error", lines: ["Exit code 1", "FAIL a.test.ts"] });
    // A call left without a result when the person spoke again was cut short.
    expect(steps[5].result).toEqual({ status: "error", summary: "Interrupted" });
  });

  it("closes each round with its duration and output tokens, counting a repeated message once", () => {
    const at = (second: number) => `2026-11-11T10:00:${String(second).padStart(2, "0")}.000Z`;
    const usage = (output: number) => ({ input_tokens: 5, output_tokens: output });
    const content = [
      JSON.stringify({ type: "user", cwd: "D:\\AutoWork", timestamp: at(0), message: { role: "user", content: "查一下" } }),
      // One API message is written as one record per content block, each repeating the same usage.
      JSON.stringify({
        type: "assistant",
        timestamp: at(3),
        message: { id: "m1", role: "assistant", usage: usage(120), content: [{ type: "thinking", thinking: "" }] },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: at(4),
        message: { id: "m1", role: "assistant", usage: usage(120), content: [{ type: "tool_use", name: "Grep", input: { pattern: "TODO" } }] },
      }),
      JSON.stringify({
        type: "user",
        timestamp: at(6),
        message: { role: "user", content: [{ type: "tool_result", content: "3 处" }, { type: "text", text: "顺便看下测试" }] },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: at(9),
        message: { id: "m2", role: "assistant", usage: usage(80), content: [{ type: "text", text: "找到 3 处" }] },
      }),
      JSON.stringify({ type: "user", timestamp: at(20), message: { role: "user", content: "再看看" } }),
      JSON.stringify({
        type: "assistant",
        timestamp: at(22),
        message: { id: "m3", role: "assistant", usage: usage(40), content: [{ type: "tool_use", name: "Read", input: { file_path: "a.ts" } }] },
      }),
    ].join("\n");

    const parsed = parseClaudeJsonl("r.jsonl", content, at(30));
    expect(parsed?.turnComplete).toBe(false);
    expect(parsed?.messages.map((message) => message.role)).toEqual([
      "user", "step", "user", "assistant", "turn", "user", "step", "turn",
    ]);
    const [done, running] = parsed!.messages.filter((message) => message.role === "turn");
    // A message typed mid-round does not start a new round.
    expect(done).toMatchObject({ startedAt: at(0), endedAt: at(9), tokens: 200 });
    expect(running).toMatchObject({ id: "c-running", startedAt: at(20), tokens: 40 });
    expect(running.endedAt).toBeUndefined();
    expect(parsed!.messages[1]).toMatchObject({ tool: "Search", text: 'pattern: "TODO"' });
  });

  it("is not complete while the latest record is a tool call or a waiting user message", () => {
    const waiting = [
      JSON.stringify({ type: "user", cwd: "D:\\AutoWork", message: { role: "user", content: "继续" } }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "tool_use", name: "Bash" }] },
      }),
    ].join("\n");
    expect(parseClaudeJsonl("a.jsonl", waiting, "2026-11-11T00:00:00.000Z")?.turnComplete).toBe(false);

    const asked = JSON.stringify({
      type: "user",
      cwd: "D:\\AutoWork",
      message: { role: "user", content: "继续" },
    });
    expect(parseClaudeJsonl("b.jsonl", asked, "2026-11-11T00:00:00.000Z")?.turnComplete).toBe(false);
  });

  it("treats a round stopped by hand as finished and hides the stop marker", () => {
    const NL = String.fromCharCode(10);
    const content = [
      JSON.stringify({ type: "user", cwd: "D:\Work", timestamp: "2026-11-11T00:00:00.000Z", message: { role: "user", content: "跑一遍测试" } }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-11-11T00:00:05.000Z",
        message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }] },
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-11-11T00:00:09.000Z",
        message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] },
      }),
    ].join(NL);
    const parsed = parseClaudeJsonl("stop.jsonl", content, "2026-11-11T00:00:09.000Z")!;
    expect(parsed.turnComplete).toBe(true);
    expect(parsed.interruptedAt).toBe(parsed.messages.length);
    expect(parsed.messages.map((message) => message.role)).toEqual(["user", "step", "turn"]);
    expect(parsed.messages[1].result).toEqual({ status: "error", summary: "Interrupted" });
    expect(parsed.messages[2]).toMatchObject({ startedAt: "2026-11-11T00:00:00.000Z", endedAt: "2026-11-11T00:00:09.000Z" });

    const resumed = parseClaudeJsonl(
      "stop.jsonl",
      [content, JSON.stringify({ type: "user", timestamp: "2026-11-11T00:01:00.000Z", message: { role: "user", content: "换个做法" } })].join(NL),
      "2026-11-11T00:01:00.000Z",
    )!;
    expect(resumed.turnComplete).toBe(false);
  });

  it("shows assistant text while stream deltas are still arriving", () => {
    const content = [
      JSON.stringify({ type: "user", cwd: "D:\\AutoWork", message: { role: "user", content: "继续" } }),
      JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "正在" } },
      }),
      JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "写" } },
      }),
    ].join("\n");
    const parsed = parseClaudeJsonl("d.jsonl", content, "2026-11-11T00:00:00.000Z");
    expect(parsed?.messages.at(-1)).toMatchObject({ role: "assistant", text: "正在写" });
    expect(parsed?.turnComplete).toBe(false);
  });

  it("shows the typed words when a peer wrapper was recorded", () => {
    const content = JSON.stringify({
      type: "user",
      cwd: "D:\\AutoWork",
      message: {
        role: "user",
        content:
          "Another Claude session sent a message:\nhi\n\nThis came from another Claude session — not typed by your user, but very likely working on their behalf.",
      },
    });
    expect(parseClaudeJsonl("peer.jsonl", content, "2026-11-11T00:00:00.000Z")?.messages[0]?.text).toBe("hi");
  });

  it("omits a file with no cwd", () => {
    const content = JSON.stringify({
      type: "user",
      message: { role: "user", content: "没有目录" },
    });
    expect(parseClaudeJsonl("c.jsonl", content, "2026-11-11T00:00:00.000Z")).toBeNull();
  });
});

describe("parseCodexJsonl", () => {
  it("shows commentary and final answers as agent text", () => {
    const content = [
      JSON.stringify({
        type: "session_meta",
        payload: { id: "codex-1", cwd: "E:\\WM\\efp" },
      }),
      "bad",
      JSON.stringify({
        type: "event_msg",
        payload: { type: "user_message", message: "核对任务" },
      }),
      JSON.stringify({
        type: "event_msg",
        payload: { type: "agent_message", phase: "commentary", message: "我先读文件" },
      }),
      JSON.stringify({
        type: "event_msg",
        payload: { type: "agent_message", phase: "final_answer", message: "任务配置在 config 里" },
      }),
      JSON.stringify({
        type: "event_msg",
        payload: { type: "task_started", turn_id: "t1" },
      }),
      JSON.stringify({
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "t1" },
      }),
    ].join("\n");

    const parsed = parseCodexJsonl(content, "2026-11-11T00:00:00.000Z");
    expect(parsed).toMatchObject({
      id: "codex-1",
      cwd: "E:\\WM\\efp",
      title: "核对任务",
      turnComplete: true,
    });
    expect(parsed?.messages.map((message) => [message.role, message.text])).toEqual([
      ["user", "核对任务"],
      ["assistant", "我先读文件"],
      ["assistant", "任务配置在 config 里"],
    ]);
  });

  it("times each task and counts the output tokens it added", () => {
    const record = (timestamp: string, type: string, payload: Record<string, unknown>) =>
      JSON.stringify({ timestamp, type, payload });
    const tokens = (output: number) => ({ type: "token_count", info: { total_token_usage: { output_tokens: output } } });
    const content = [
      record("2026-11-11T10:00:00.000Z", "session_meta", { id: "codex-3", cwd: "E:\\WM\\efp" }),
      record("2026-11-11T10:00:00.000Z", "event_msg", tokens(500)),
      record("2026-11-11T10:00:01.000Z", "event_msg", { type: "task_started" }),
      record("2026-11-11T10:00:01.000Z", "event_msg", { type: "user_message", message: "跑测试" }),
      record("2026-11-11T10:00:03.000Z", "response_item", {
        type: "function_call",
        name: "shell",
        arguments: JSON.stringify({ command: ["npm", "test"] }),
      }),
      record("2026-11-11T10:00:05.000Z", "event_msg", tokens(650)),
      record("2026-11-11T10:00:06.000Z", "event_msg", { type: "agent_message", phase: "final_answer", message: "全过了" }),
      record("2026-11-11T10:00:07.000Z", "event_msg", { type: "task_complete" }),
      record("2026-11-11T10:01:00.000Z", "event_msg", { type: "task_started" }),
      record("2026-11-11T10:01:00.000Z", "event_msg", { type: "user_message", message: "再来" }),
      record("2026-11-11T10:01:04.000Z", "event_msg", tokens(700)),
    ].join("\n");

    const parsed = parseCodexJsonl(content, "2026-11-11T10:02:00.000Z");
    expect(parsed?.messages.map((message) => message.role)).toEqual(["user", "step", "assistant", "turn", "user", "turn"]);
    expect(parsed?.messages[1]).toMatchObject({ tool: "Ran", text: "npm test" });
    expect(parsed?.messages[3]).toMatchObject({
      startedAt: "2026-11-11T10:00:01.000Z",
      endedAt: "2026-11-11T10:00:07.000Z",
      tokens: 150,
    });
    expect(parsed?.messages[5]).toMatchObject({ id: "x-running", startedAt: "2026-11-11T10:01:00.000Z", tokens: 50 });
  });

  it("prints Codex calls the way its terminal does", () => {
    const record = (type: string, payload: Record<string, unknown>) => JSON.stringify({ timestamp: "2026-11-11T10:00:00.000Z", type, payload });
    const exec = (callId: string, code: string) =>
      record("response_item", { type: "custom_tool_call", name: "exec", call_id: callId, input: code });
    const content = [
      record("session_meta", { id: "codex-4", cwd: "E:\\WM\\efp" }),
      record("event_msg", { type: "task_started" }),
      record("event_msg", { type: "user_message", message: "修一下" }),
      record("event_msg", { type: "agent_reasoning", text: "**Planning the fix**" }),
      exec("c1", 'const r = await tools.shell_command({"command":"npm test","workdir":"E:\\\\WM\\\\efp"});\ntext(r);'),
      record("response_item", {
        type: "custom_tool_call_output",
        call_id: "c1",
        output: [
          { type: "input_text", text: "Script completed\nWall time 1.8 seconds\nOutput:\n" },
          { type: "input_text", text: "Exit code: 1\nWall time: 1.8 seconds\nOutput:\nFAIL a.test.ts\n" },
        ],
      }),
      exec("c2", 'await tools.update_plan({"plan":[{"step":"读代码","status":"completed"},{"step":"修复","status":"in_progress"}]});'),
      exec("c3", "await tools.apply_patch(`*** Begin Patch`);"),
      record("event_msg", {
        type: "patch_apply_end",
        call_id: "exec-1",
        success: true,
        changes: {
          "E:\\WM\\efp\\src\\a.ts": { type: "update", unified_diff: "@@ -2,2 +2,2 @@\n keep\n-old\n+new\n" },
          "E:\\WM\\efp\\src\\b.ts": { type: "add", content: "one\ntwo\n" },
        },
      }),
      record("response_item", { type: "function_call", name: "js", namespace: "mcp__node_repl", call_id: "c4", arguments: '{"title":"打开页面","code":"x"}' }),
      record("event_msg", { type: "turn_aborted" }),
    ].join("\n");

    const messages = parseCodexJsonl(content, "2026-11-11T10:02:00.000Z")!.messages;
    expect(messages.map((message) => [message.role, message.tool ?? "", message.text])).toEqual([
      ["user", "", "修一下"],
      ["thinking", "", "Planning the fix"],
      ["step", "Ran", "npm test"],
      ["step", "Updated Plan", ""],
      ["step", "Edited", "src\\a.ts (+1 -1)"],
      ["step", "Added", "src\\b.ts (+2 -0)"],
      ["step", "Called", "node_repl.js(打开页面)"],
      ["turn", "", ""],
    ]);
    expect(messages[2].result).toEqual({ status: "error", summary: "Exit code 1", lines: ["FAIL a.test.ts"], more: 0 });
    expect(messages[3].result?.todos).toEqual([
      { text: "读代码", status: "completed" },
      { text: "修复", status: "in_progress" },
    ]);
    expect(messages[4].result?.diff).toEqual([
      { kind: " ", no: 2, text: "keep" },
      { kind: "-", no: 3, text: "old" },
      { kind: "+", no: 3, text: "new" },
    ]);
    // The call still open when the task was aborted was cut short.
    expect(messages[6].result).toEqual({ status: "error", summary: "Interrupted" });
  });

  it("stays incomplete after the latest task start", () => {
    const content = [
      JSON.stringify({ type: "session_meta", payload: { id: "codex-2", cwd: "E:\\WM\\efp" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
    ].join("\n");
    expect(parseCodexJsonl(content, "2026-11-11T00:00:00.000Z")?.turnComplete).toBe(false);
  });
});

describe("screenAllowsInput", () => {
  it("blocks numbered choices and allows a normal composer", () => {
    expect(screenAllowsInput(["Claude Code 要执行命令", "❯ 1. Yes", "  2. No"])).toBe(false);
    expect(screenAllowsInput(["入口在 scripts/publish.js", ">"])).toBe(true);
    expect(screenAllowsInput(["1. 先改接口", "2. 再补测试", "›"])).toBe(true);
    expect(screenAllowsInput(["1. 第一项说明", "2. 第二项说明", "❯ "])).toBe(true);
    expect(screenAllowsInput(["Trust this folder?", "› 1. Yes", "  2. No"])).toBe(false);
    expect(screenAllowsInput(["This conversation is open in another app", "Close it there and press R to continue here."])).toBe(false);
    expect(screenAllowsInput(["Not logged in · Please run /login", "❯ "])).toBe(false);
  });
});

describe("readCatalog", () => {
  it("groups sessions by workspace and sorts by recency", () => {
    const root = mkdtempSync(path.join(tmpdir(), "aimiss-"));
    const claudeRoot = path.join(root, "projects");
    const olderWorkspace = path.join(root, "old-workspace");
    const newerWorkspace = path.join(root, "new-workspace");
    mkdirSync(olderWorkspace, { recursive: true });
    mkdirSync(newerWorkspace, { recursive: true });
    const olderDir = path.join(claudeRoot, encodeClaudeProject(olderWorkspace));
    const newerDir = path.join(claudeRoot, encodeClaudeProject(newerWorkspace));
    mkdirSync(olderDir, { recursive: true });
    mkdirSync(newerDir, { recursive: true });
    const older = path.join(olderDir, "old.jsonl");
    const newer = path.join(newerDir, "new.jsonl");
    writeFileSync(
      older,
      JSON.stringify({
        type: "user",
        cwd: olderWorkspace,
        message: { role: "user", content: "旧会话" },
      }),
    );
    writeFileSync(
      newer,
      JSON.stringify({
        type: "user",
        cwd: newerWorkspace,
        message: { role: "user", content: "新会话" },
      }),
    );
    const codexRoot = path.join(root, "sessions", "2026", "11", "11");
    mkdirSync(codexRoot, { recursive: true });
    writeFileSync(
      path.join(codexRoot, "rollout.jsonl"),
      JSON.stringify({
        type: "session_meta",
        payload: { id: "codex-9", cwd: "Z:\\missing\\place" },
      }) +
        "\n" +
        JSON.stringify({
          type: "event_msg",
          payload: { type: "user_message", message: "丢失目录" },
        }),
    );
    const oldTime = new Date("2026-11-01T00:00:00.000Z");
    const newTime = new Date("2026-11-11T00:00:00.000Z");
    utimesSync(older, oldTime, oldTime);
    utimesSync(newer, newTime, newTime);

    const catalog = readCatalog({
      claudeProjectsDir: claudeRoot,
      codexSessionsDir: path.join(root, "sessions"),
    });

    expect(catalog.claude.map((group) => group.path)).toEqual([newerWorkspace, olderWorkspace]);
    expect(catalog.claude[0]?.missing).toBe(false);
    expect(catalog.codex[0]).toMatchObject({ path: "Z:\\missing\\place", missing: true });
    expect(catalog.codex[0]?.sessions[0]?.title).toBe("丢失目录");
    expect(catalog.claude.every((group) => group.sessions.every((session) => session.pinned === false))).toBe(true);
  });

  it("marks sessions pinned in Claude Code and Codex", () => {
    const root = mkdtempSync(path.join(tmpdir(), "aimiss-"));
    const claudeRoot = path.join(root, "projects");
    const pinnedDir = path.join(claudeRoot, encodeClaudeProject("E:\\WM\\efp"));
    mkdirSync(pinnedDir, { recursive: true });
    writeFileSync(
      path.join(pinnedDir, "starred.jsonl"),
      JSON.stringify({
        type: "user",
        cwd: "E:\\WM\\efp",
        message: { role: "user", content: "能源指纹" },
      }),
    );
    writeFileSync(
      path.join(pinnedDir, "archived.jsonl"),
      JSON.stringify({
        type: "user",
        cwd: "E:\\WM\\efp",
        message: { role: "user", content: "已归档" },
      }),
    );
    const dataDir = path.join(root, "Claude-Data", "acct", "org");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      path.join(dataDir, "local_star.json"),
      JSON.stringify({ isStarred: true, cliSessionId: "starred" }),
    );
    writeFileSync(
      path.join(dataDir, "local_archived.json"),
      JSON.stringify({ isStarred: true, isArchived: true, cliSessionId: "archived" }),
    );
    const sessionsDir = path.join(root, "sessions", "2026", "11", "11");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      path.join(sessionsDir, "pinned.jsonl"),
      JSON.stringify({ type: "session_meta", payload: { id: "codex-pin", cwd: "E:\\WM\\efp" } }) +
        "\n" +
        JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "置顶线程" } }),
    );
    writeFileSync(
      path.join(sessionsDir, "plain.jsonl"),
      JSON.stringify({ type: "session_meta", payload: { id: "codex-plain", cwd: "E:\\WM\\efp" } }) +
        "\n" +
        JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "普通线程" } }),
    );
    writeFileSync(
      path.join(root, ".codex-global-state.json"),
      JSON.stringify({ "pinned-thread-ids": ["codex-pin", "missing-thread"] }),
    );

    const catalog = readCatalog({
      claudeProjectsDir: claudeRoot,
      codexSessionsDir: path.join(root, "sessions"),
      claudeDataDir: path.join(root, "Claude-Data"),
    });

    expect(catalog.claude.flatMap((group) => group.sessions).map((session) => [session.id, session.pinned])).toEqual([
      ["starred", true],
    ]);
    expect(catalog.codex.flatMap((group) => group.sessions).map((session) => [session.id, session.pinned]).sort()).toEqual([
      ["codex-pin", true],
      ["codex-plain", false],
    ]);
  });

  it("marks an unfinished reply as working and a finished unseen reply with the tool's own flag", () => {
    const root = mkdtempSync(path.join(tmpdir(), "aimiss-"));
    const claudeRoot = path.join(root, "projects");
    const project = path.join(claudeRoot, encodeClaudeProject("E:\\WM\\efp"));
    mkdirSync(project, { recursive: true });
    const reply = (text: string) =>
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
    writeFileSync(
      path.join(project, "seen.jsonl"),
      [
        JSON.stringify({ type: "user", cwd: "E:\\WM\\efp", message: { role: "user", content: "看过" } }),
        reply("好"),
      ].join("\n"),
    );
    writeFileSync(
      path.join(project, "fresh.jsonl"),
      [
        JSON.stringify({ type: "user", cwd: "E:\\WM\\efp", message: { role: "user", content: "没看" } }),
        reply("写完了"),
      ].join("\n"),
    );
    writeFileSync(
      path.join(project, "busy.jsonl"),
      JSON.stringify({ type: "user", cwd: "E:\\WM\\efp", message: { role: "user", content: "还在写" } }),
    );
    const dataDir = path.join(root, "Claude-Data", "acct", "org");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      path.join(dataDir, "local_seen.json"),
      JSON.stringify({ cliSessionId: "seen", lastFocusedAt: 200, lastActivityAt: 100 }),
    );
    writeFileSync(
      path.join(dataDir, "local_fresh.json"),
      JSON.stringify({ cliSessionId: "fresh", lastFocusedAt: 100, lastActivityAt: 200 }),
    );
    writeFileSync(
      path.join(dataDir, "local_busy.json"),
      JSON.stringify({ cliSessionId: "busy", lastFocusedAt: 100, lastActivityAt: 300 }),
    );
    const sessionsDir = path.join(root, "sessions", "2026", "11", "11");
    mkdirSync(sessionsDir, { recursive: true });
    const codex = (id: string, done: boolean) =>
      [
        JSON.stringify({ type: "session_meta", payload: { id, cwd: "E:\\WM\\efp" } }),
        JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: id } }),
        ...(done
          ? [
              JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
              JSON.stringify({ type: "event_msg", payload: { type: "agent_message", phase: "final_answer", message: "好" } }),
              JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }),
            ]
          : [JSON.stringify({ type: "event_msg", payload: { type: "task_started" } })]),
      ].join("\n");
    writeFileSync(path.join(sessionsDir, "unread.jsonl"), codex("codex-unread", true));
    writeFileSync(path.join(sessionsDir, "read.jsonl"), codex("codex-read", true));
    writeFileSync(path.join(sessionsDir, "live.jsonl"), codex("codex-live", false));
    writeFileSync(
      path.join(root, ".codex-global-state.json"),
      JSON.stringify({
        "electron-persisted-atom-state": { "unread-thread-ids-by-host-v1": { local: ["codex-unread", "codex-live"] } },
      }),
    );

    const catalog = readCatalog({
      claudeProjectsDir: claudeRoot,
      codexSessionsDir: path.join(root, "sessions"),
      claudeDataDir: path.join(root, "Claude-Data"),
    });
    const claude = Object.fromEntries(
      catalog.claude.flatMap((group) => group.sessions).map((session) => [session.id, { working: session.working, unseen: session.unseen }]),
    );
    expect(claude).toEqual({
      seen: { working: false, unseen: false },
      fresh: { working: false, unseen: true },
      busy: { working: true, unseen: false },
    });
    const threads = Object.fromEntries(
      catalog.codex.flatMap((group) => group.sessions).map((session) => [session.id, { working: session.working, unseen: session.unseen }]),
    );
    expect(threads).toEqual({
      "codex-unread": { working: false, unseen: true },
      "codex-read": { working: false, unseen: false },
      "codex-live": { working: true, unseen: false },
    });
  });

  it("lists one desktop session when Claude Code continued it into a new transcript", () => {
    const root = mkdtempSync(path.join(tmpdir(), "aimiss-"));
    const project = path.join(root, "projects", encodeClaudeProject("E:\\Me"));
    mkdirSync(project, { recursive: true });
    const user = (text: string) =>
      JSON.stringify({ type: "user", cwd: "E:\\Me", message: { role: "user", content: text } });
    writeFileSync(path.join(project, "old-talk.jsonl"), user("旧的 DaTalk"));
    writeFileSync(path.join(project, "new-talk.jsonl"), user("新的 DaTalk"));
    writeFileSync(path.join(project, "other.jsonl"), user("另一条"));
    const dataDir = path.join(root, "Claude-Data", "acct", "org");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      path.join(dataDir, "local_datalk.json"),
      JSON.stringify({
        cliSessionId: "new-talk",
        priorCliSessionIds: ["old-talk"],
        isArchived: false,
        title: "DaTalk",
      }),
    );
    writeFileSync(
      path.join(dataDir, "local_other.json"),
      JSON.stringify({ cliSessionId: "other", priorCliSessionIds: ["old-talk"], title: "别的" }),
    );

    const catalog = readCatalog({
      claudeProjectsDir: path.join(root, "projects"),
      codexSessionsDir: path.join(root, "sessions"),
      claudeDataDir: path.join(root, "Claude-Data"),
    });
    expect(catalog.claude.flatMap((group) => group.sessions).map((session) => session.id).sort()).toEqual([
      "new-talk",
      "other",
    ]);
  });
});

describe("readSchedules", () => {
  it("describes a weekly rule", () => {
    expect(describeRrule("RRULE:FREQ=WEEKLY;BYHOUR=8;BYMINUTE=0;BYDAY=MO,TU,WE,TH,FR")).toBe("每周一至五 08:00");
    expect(describeRrule("RRULE:FREQ=WEEKLY;BYHOUR=5;BYMINUTE=0;BYDAY=SU,MO,TU,WE,TH,FR,SA")).toBe("每天 05:00");
  });

  it("lists Claude schedules and Codex automations together", () => {
    const root = mkdtempSync(path.join(tmpdir(), "aimiss-"));
    const dataDir = path.join(root, "Claude-Data", "acct", "org");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      path.join(dataDir, "scheduled-tasks.json"),
      JSON.stringify({
        scheduledTasks: [
          {
            id: "brief",
            name: "晨报",
            prompt: "汇总今天的安排",
            rrule: "RRULE:FREQ=WEEKLY;BYHOUR=9;BYMINUTE=30;BYDAY=MO,TU,WE,TH,FR",
            status: "ACTIVE",
            cwd: "E:\\WM\\efp",
            updatedAt: "2026-10-01T00:00:00.000Z",
          },
        ],
      }),
    );
    const automation = path.join(root, "automations", "daily-brief");
    mkdirSync(automation, { recursive: true });
    writeFileSync(
      path.join(automation, "automation.toml"),
      [
        'id = "daily-brief"',
        'kind = "heartbeat"',
        'name = "Daily brief"',
        'prompt = "hi"',
        'status = "ACTIVE"',
        'rrule = "RRULE:FREQ=WEEKLY;BYHOUR=5;BYMINUTE=0;BYDAY=SU,MO,TU,WE,TH,FR,SA"',
        'target_thread_id = "thread-1"',
        "updated_at = 1794189689671",
      ].join("\n"),
    );

    const jobs = readSchedules({
      claudeProjectsDir: path.join(root, "projects"),
      codexSessionsDir: path.join(root, "sessions"),
      claudeDataDir: path.join(root, "Claude-Data"),
    });

    expect(jobs.map((job) => [job.tool, job.name, job.cadence, job.location])).toEqual([
      ["codex", "Daily brief", "每天 05:00", "thread-1"],
      ["claude", "晨报", "每周一至五 09:30", "E:\\WM\\efp"],
    ]);
  });
});
