import { describe, expect, it } from "vitest";
import { parseClaudeJsonl } from "../src/transcript/claude";

const at = "2026-11-17T00:00:00.000Z";
const line = (record: Record<string, unknown>) => JSON.stringify({ cwd: "E:\work", timestamp: at, ...record });
const user = (content: unknown, extra: Record<string, unknown> = {}) =>
  line({ type: "user", message: { role: "user", content }, ...extra });
const reply = line({ type: "assistant", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "done" }] } });

describe("slash commands run in the client", () => {
  it("does not leave the session running after a local command like /model", () => {
    const content = [
      user("hello"),
      reply,
      user("<local-command-caveat>The command below was run directly…</local-command-caveat>", { isMeta: true }),
      user("<command-name>/model</command-name>\n<command-args>claude-opus-5-5</command-args>"),
      user("<local-command-stdout>Set model to `claude-opus-5-5`</local-command-stdout>"),
    ].join("\n");
    const parsed = parseClaudeJsonl("s.jsonl", content, at)!;
    expect(parsed.turnComplete).toBe(true);
    expect(parsed.messages.some((m) => m.text.includes("local-command"))).toBe(false);
  });

  it("still runs when a real message follows the local command", () => {
    const content = [
      user("hello"),
      reply,
      user("<command-name>/model</command-name>"),
      user("<local-command-stdout>Set model</local-command-stdout>"),
      user("next question"),
    ].join("\n");
    expect(parseClaudeJsonl("s.jsonl", content, at)!.turnComplete).toBe(false);
  });
});

describe("messages sent from MirrorMix through Claude's inbox", () => {
  it("counts the meta record as the person's own message and starts a round", () => {
    const content = [
      user("hello"),
      reply,
      user(
        "Another Claude session sent a message:\nwhy did it fail\n\nThis came from another Claude session — not typed by your user.",
        { isMeta: true },
      ),
    ].join("\n");
    const parsed = parseClaudeJsonl("s.jsonl", content, at)!;
    expect(parsed.turnComplete).toBe(false);
    expect(parsed.messages.filter((m) => m.role === "user").map((m) => m.text)).toEqual(["hello", "why did it fail"]);
  });
});
