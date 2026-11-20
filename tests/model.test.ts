import { describe, expect, it } from "vitest";
import { modelFamily, modelName } from "../client/src/modelName";
import { parseClaudeJsonl } from "../src/transcript/claude";
import { parseCodexJsonl } from "../src/transcript/codex";

const lines = (...records: unknown[]) => records.map((record) => JSON.stringify(record)).join("\n");

describe("the model a session is on", () => {
  it("is the model of Claude's latest reply", () => {
    const parsed = parseClaudeJsonl(
      "a.jsonl",
      lines(
        { type: "user", cwd: "C:\\p", timestamp: "2026-11-17T01:00:00Z", message: { role: "user", content: "hi" } },
        { type: "assistant", timestamp: "2026-11-17T01:00:01Z", message: { id: "m1", model: "claude-sonnet-5", role: "assistant", content: [{ type: "text", text: "a" }] } },
        { type: "user", timestamp: "2026-11-17T01:00:02Z", message: { role: "user", content: "again" } },
        { type: "assistant", timestamp: "2026-11-17T01:00:03Z", message: { id: "m2", model: "claude-opus-5-5", role: "assistant", content: [{ type: "text", text: "b" }] } },
        // Claude Code's own error notices name no real model.
        { type: "assistant", timestamp: "2026-11-17T01:00:04Z", message: { id: "m3", model: "<synthetic>", role: "assistant", content: [{ type: "text", text: "API error" }] } },
      ),
      "2026-11-17T01:00:04Z",
    );
    expect(parsed?.model).toBe("claude-opus-5-5");
  });

  it("follows /model before the next reply", () => {
    const parsed = parseClaudeJsonl(
      "a.jsonl",
      lines(
        { type: "user", cwd: "C:\\p", timestamp: "2026-11-17T01:00:00Z", message: { role: "user", content: "hi" } },
        { type: "assistant", timestamp: "2026-11-17T01:00:01Z", message: { id: "m1", model: "claude-opus-5-5", role: "assistant", content: [{ type: "text", text: "a" }] } },
        { type: "user", timestamp: "2026-11-17T01:00:02Z", message: { role: "user", content: "<local-command-stdout>Set model to \u001b[1mclaude-sonnet-5\u001b[22m</local-command-stdout>" } },
      ),
      "2026-11-17T01:00:02Z",
    );
    expect(parsed?.model).toBe("claude-sonnet-5");
  });

  it("is Codex's latest turn context, with its effort", () => {
    const parsed = parseCodexJsonl(
      lines(
        { type: "session_meta", payload: { id: "t1", cwd: "C:\\p" } },
        { type: "turn_context", payload: { model: "gpt-6", effort: "medium" } },
        { type: "turn_context", payload: { model: "gpt-6.1-sol", effort: "high" } },
      ),
      "2026-11-17T01:00:00Z",
    );
    expect(parsed).toMatchObject({ model: "gpt-6.1-sol", effort: "high" });
  });
});

describe("model names", () => {
  it("reads ids the way people say them", () => {
    expect(modelName("claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelName("claude-sonnet-4-5-20250929")).toBe("Sonnet 4.5");
    expect(modelName("claude-opus-5-5[1m]")).toBe("Opus 5.5 1M");
    expect(modelName("gpt-6.1-sol")).toBe("GPT 6.1 Sol");
    expect(modelName("composer-2")).toBe("Composer 2");
    expect(modelName("")).toBe("");
  });

  it("knows which /model alias an id belongs to", () => {
    expect(modelFamily("claude-opus-5-5")).toBe("opus");
    expect(modelFamily("claude-haiku-5-5")).toBe("haiku");
    expect(modelFamily("gpt-6.1-sol")).toBe("");
  });
});
