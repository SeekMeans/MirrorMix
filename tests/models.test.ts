import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createModelStore } from "../src/models/modelStore";
import { plainBox } from "../src/settings/secrets";
import { createWorkflowEngine, type ModelRequest } from "../src/workflow/engine";

const fileIn = () => path.join(mkdtempSync(path.join(os.tmpdir(), "mm-models-")), "models.json");

describe("model store", () => {
  it("keeps the key sealed and out of what the page sees", () => {
    const file = fileIn();
    const store = createModelStore(file, plainBox());
    const saved = store.save({ provider: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1/", model: "deepseek-chat", apiKey: "sk-secret-1234" });
    expect(saved).toMatchObject({ name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", hasKey: true, keyTail: "1234" });
    expect(JSON.stringify(store.list())).not.toContain("sk-secret");
    expect(readFileSync(file, "utf8")).not.toContain("sk-secret");

    // An edit without a key keeps it; clearKey takes it away.
    expect(store.save({ name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-reasoner" }, saved.id)).toMatchObject({ model: "deepseek-reasoner", hasKey: true });
    expect(store.save({ name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "x", clearKey: true }, saved.id).hasKey).toBe(false);
  });

  it("checks what is saved", () => {
    const store = createModelStore(fileIn(), plainBox());
    expect(() => store.save({ name: "", baseUrl: "https://a", model: "m" })).toThrow("name_required");
    expect(() => store.save({ name: "a", baseUrl: "ftp://a", model: "m" })).toThrow("bad_url");
    expect(() => store.save({ name: "a", baseUrl: "https://a", model: "" })).toThrow("model_required");
    store.save({ name: "a", baseUrl: "https://a", model: "m" });
    expect(() => store.save({ name: "a", baseUrl: "https://b", model: "m" })).toThrow("name_taken");
  });

  it("calls the chat-completions endpoint with the key and returns the reply", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ choices: [{ message: { content: " 你好 " } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const store = createModelStore(fileIn(), plainBox(), fake);
    const model = store.save({ name: "Q", baseUrl: "https://x.test/v1", model: "qwen-plus", apiKey: "k1", temperature: 0.2 });
    const reply = await store.chat(model.id, [{ role: "system", content: "框架" }, { role: "user", content: "问" }], { json: true });
    expect(reply).toBe("你好");
    expect(calls[0].url).toBe("https://x.test/v1/chat/completions");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer k1");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toMatchObject({ model: "qwen-plus", temperature: 0.2, response_format: { type: "json_object" } });
    expect(body.messages[0]).toEqual({ role: "system", content: "框架" });
  });

  it("says what the service answered when it refuses", async () => {
    const fake = (async () => new Response(JSON.stringify({ error: { message: "Authentication Fails" } }), { status: 401 })) as unknown as typeof fetch;
    const store = createModelStore(fileIn(), plainBox(), fake);
    const model = store.save({ name: "D", baseUrl: "https://x.test/v1", model: "m" });
    await expect(store.chat(model.id, [{ role: "user", content: "hi" }])).rejects.toThrow("模型返回 401：Authentication Fails");
  });
});

describe("workflow model step", () => {
  it("sends the framework and prompt with references filled in, and passes the reply on", async () => {
    const asked: ModelRequest[] = [];
    const engine = createWorkflowEngine({
      dir: mkdtempSync(path.join(os.tmpdir(), "mm-flow-")),
      ai: async () => ({ output: "", sessionId: "s" }),
      command: async (request) => ({ output: request.command, exitCode: 0 }),
      model: async (request) => {
        asked.push(request);
        return '{"ok": false}';
      },
    });
    const flow = engine.save({
      name: "评审",
      workspace: "E:/p",
      steps: [
        { id: "m", kind: "model", name: "评审", modelId: "abc", system: "你评审 {{输入}}", prompt: "改动如下", json: true },
        { id: "c", kind: "command", name: "结果", command: "echo {{评审.ok}}" },
      ],
    });
    const run = engine.run(flow.id, "前端");
    await engine.settled(run.id);
    expect(asked[0]).toMatchObject({ modelId: "abc", system: "你评审 前端", prompt: "改动如下", json: true });
    expect(engine.getRun(run.id).steps[1].output).toBe("echo false");
  });
});
