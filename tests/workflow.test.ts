import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { replyAfter } from "../src/workflow/aiBridge";
import { createWorkflowEngine, fillIn, holds, type AiRequest, type CommandRequest } from "../src/workflow/engine";
import type { TranscriptMessage } from "../src/shared/types";

const tempDir = () => mkdtempSync(path.join(os.tmpdir(), "mm-flow-"));

function engineWith(options: {
  ai?: (request: AiRequest) => Promise<{ output: string; sessionId: string }>;
  command?: (request: CommandRequest) => Promise<{ output: string; exitCode: number }>;
}) {
  const asked: AiRequest[] = [];
  const ran: string[] = [];
  const engine = createWorkflowEngine({
    dir: tempDir(),
    ai: async (request) => {
      asked.push(request);
      request.onSession("s1");
      return options.ai ? options.ai(request) : { output: `回复：${request.prompt}`, sessionId: "s1" };
    },
    command: async (request) => {
      ran.push(request.command);
      return options.command ? options.command(request) : { output: "ok", exitCode: 0 };
    },
  });
  return { engine, asked, ran };
}

describe("workflow references", () => {
  const scope = {
    input: "登录页",
    results: new Map([
      ["实现", { output: '好的。\n```json\n{"files": ["a.ts"], "ok": true}\n```' }],
      ["测试", { output: "2 failed", exitCode: 1 }],
    ]),
  };

  it("fills in the input, outputs, exit codes and JSON fields", () => {
    expect(fillIn("做 {{输入}}", scope)).toBe("做 登录页");
    expect(fillIn("{{测试.输出}} / {{测试.退出码}}", scope)).toBe("2 failed / 1");
    expect(fillIn("{{实现.ok}} {{实现.files}}", scope)).toBe('true ["a.ts"]');
    expect(fillIn("{{没有这步}}", scope)).toBe("");
  });

  it("checks conditions", () => {
    expect(holds({ source: "{{测试.退出码}}", op: "equals", value: "0" }, scope)).toBe(false);
    expect(holds({ source: "{{测试}}", op: "matches", value: "\\d+ failed" }, scope)).toBe(true);
    expect(holds({ source: "{{没有}}", op: "empty", value: "" }, scope)).toBe(true);
  });
});

describe("workflow runs", () => {
  it("runs steps in order and passes one step's output to the next", async () => {
    const { engine, asked, ran } = engineWith({ command: async () => ({ output: "3 passed", exitCode: 0 }) });
    const flow = engine.save({
      name: "实现并测试",
      workspace: "E:/proj",
      steps: [
        { id: "a", kind: "ai", name: "实现", tool: "claude", session: "new", prompt: "实现 {{输入}}" },
        { id: "b", kind: "command", name: "测试", command: "npm test" },
        { id: "c", kind: "ai", name: "总结", tool: "codex", session: "new", prompt: "测试结果：{{测试.输出}}" },
      ],
    });
    const run = engine.run(flow.id, "登录");
    await engine.settled(run.id);
    const done = engine.getRun(run.id);
    expect(done.status).toBe("ok");
    expect(asked.map((request) => request.prompt)).toEqual(["实现 登录", "测试结果：3 passed"]);
    expect(asked[0].sessionId).toBeNull();
    expect(asked[0].workspace).toBe("E:/proj");
    expect(ran).toEqual(["npm test"]);
    expect(done.steps.map((step) => step.status)).toEqual(["ok", "ok", "ok"]);
    expect(done.steps[0].session).toEqual({ tool: "claude", id: "s1" });
    expect(engine.runs(flow.id)[0]).toMatchObject({ id: run.id, status: "ok", stepCount: 3 });
  });

  it("takes the branch the condition chooses", async () => {
    const { engine, ran } = engineWith({ command: async (request) => ({ output: "", exitCode: request.command === "check" ? 1 : 0 }) });
    const flow = engine.save({
      name: "分支",
      workspace: "E:/proj",
      steps: [
        { id: "a", kind: "command", name: "检查", command: "check", failOnError: false },
        {
          id: "b",
          kind: "if",
          name: "通过了吗",
          condition: { source: "{{检查.退出码}}", op: "equals", value: "0" },
          then: [{ id: "c", kind: "command", name: "部署", command: "deploy" }],
          else: [{ id: "d", kind: "command", name: "报警", command: "alert" }],
        },
      ],
    });
    const run = engine.run(flow.id, "");
    await engine.settled(run.id);
    expect(ran).toEqual(["check", "alert"]);
    expect(engine.getRun(run.id).steps.find((step) => step.stepId === "b")?.branch).toBe("else");
  });

  it("repeats a loop until its condition holds, and carries on in an earlier step's session", async () => {
    let tries = 0;
    const { engine, asked } = engineWith({
      command: async () => {
        tries += 1;
        return { output: tries >= 2 ? "pass" : "fail", exitCode: tries >= 2 ? 0 : 1 };
      },
    });
    const flow = engine.save({
      name: "修到通过",
      workspace: "E:/proj",
      steps: [
        { id: "a", kind: "ai", name: "实现", tool: "claude", session: "new", prompt: "实现" },
        {
          id: "l",
          kind: "loop",
          name: "修复",
          mode: "until",
          max: 5,
          condition: { source: "{{测试.退出码}}", op: "equals", value: "0" },
          body: [
            { id: "t", kind: "command", name: "测试", command: "npm test", failOnError: false },
            {
              id: "f",
              kind: "if",
              name: "失败了",
              condition: { source: "{{测试.退出码}}", op: "not_equals", value: "0" },
              then: [{ id: "x", kind: "ai", name: "修", tool: "claude", session: "step:a", prompt: "第 {{循环.次数}} 次：{{测试}}" }],
              else: [],
            },
          ],
        },
      ],
    });
    const run = engine.run(flow.id, "");
    await engine.settled(run.id);
    const done = engine.getRun(run.id);
    expect(done.status).toBe("ok");
    expect(tries).toBe(2);
    expect(asked[1]).toMatchObject({ prompt: "第 1 次：fail", sessionId: "s1" });
    expect(done.steps.filter((step) => step.stepId === "t").map((step) => step.round)).toEqual([[1], [2]]);
  });

  it("goes over each line of a list", async () => {
    const { engine, asked } = engineWith({});
    const flow = engine.save({
      name: "逐项",
      workspace: "E:/proj",
      steps: [
        { id: "l", kind: "loop", name: "每个", mode: "each", max: 10, list: "{{输入}}", body: [{ id: "a", kind: "ai", name: "处理", tool: "claude", session: "new", prompt: "处理 {{循环.当前项}}" }] },
      ],
    });
    const run = engine.run(flow.id, "甲\n\n乙\n");
    await engine.settled(run.id);
    expect(asked.map((request) => request.prompt)).toEqual(["处理 甲", "处理 乙"]);
  });

  it("stops at a failed command and can be stopped by hand", async () => {
    const { engine, ran } = engineWith({ command: async () => ({ output: "boom", exitCode: 2 }) });
    const flow = engine.save({
      name: "失败",
      workspace: "E:/proj",
      steps: [
        { id: "a", kind: "command", name: "构建", command: "build" },
        { id: "b", kind: "command", name: "部署", command: "deploy" },
      ],
    });
    const run = engine.run(flow.id, "");
    await engine.settled(run.id);
    expect(engine.getRun(run.id)).toMatchObject({ status: "failed" });
    expect(ran).toEqual(["build"]);

    const waiting = engineWith({
      ai: (request) =>
        new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(new Error("已停止")))),
    });
    const slow = waiting.engine.save({ name: "慢", workspace: "E:/proj", steps: [{ id: "a", kind: "ai", name: "等", tool: "claude", session: "new", prompt: "hi" }] });
    const going = waiting.engine.run(slow.id, "");
    expect(() => waiting.engine.run(slow.id, "")).toThrow("running");
    waiting.engine.stop(going.id);
    await waiting.engine.settled(going.id);
    expect(waiting.engine.getRun(going.id)).toMatchObject({ status: "stopped" });
    expect(waiting.engine.getRun(going.id).steps[0].status).toBe("stopped");
  });

  it("rejects a workflow without a name or workspace", () => {
    const { engine } = engineWith({});
    expect(() => engine.save({ name: "", workspace: "E:/p" })).toThrow("name_required");
    expect(() => engine.save({ name: "x", workspace: "" })).toThrow("workspace_required");
  });
});

describe("AI step reply", () => {
  const message = (role: TranscriptMessage["role"], text: string, extra: Partial<TranscriptMessage> = {}): TranscriptMessage => ({
    id: Math.random().toString(36),
    role,
    text,
    ...extra,
  });

  it("waits for the round to close and takes the last answer after the prompt", () => {
    const before = [message("user", "旧问题"), message("assistant", "旧回答")];
    const running = [...before, message("user", "实现 登录页"), message("assistant", "我先看看"), message("turn", "", { startedAt: "t" })];
    expect(replyAfter(running, "实现 登录页", false)).toBeNull();
    const finished = [...running.slice(0, -1), message("step", "Edit"), message("assistant", "完成了"), message("turn", "", { startedAt: "t", endedAt: "u" })];
    expect(replyAfter(finished, "实现 登录页", false)).toBe("完成了");
    expect(replyAfter(finished, "实现 登录页", true)).toBeNull();
    expect(replyAfter(before, "实现 登录页", false)).toBeNull();
  });
});
