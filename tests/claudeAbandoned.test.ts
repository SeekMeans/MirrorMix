import { describe, expect, it } from "vitest";
import { ABANDONED_MS, parseClaudeJsonl, settleAbandoned, settleBeforeProcess } from "../src/transcript/claude";

const t0 = Date.parse("2026-11-17T13:30:00.000Z");
const at = (seconds: number) => new Date(t0 + seconds * 1000).toISOString();
const line = (record: Record<string, unknown>) => JSON.stringify({ cwd: "E:\\work", ...record });
const user = (content: unknown, seconds: number) => line({ type: "user", timestamp: at(seconds), message: { role: "user", content } });
const text = (words: string, seconds: number) =>
  line({ type: "assistant", timestamp: at(seconds), message: { id: `m${seconds}`, role: "assistant", content: [{ type: "text", text: words }] } });
const call = (id: string, seconds: number) =>
  line({ type: "assistant", timestamp: at(seconds), message: { id: `m${seconds}`, role: "assistant", content: [{ type: "tool_use", id, name: "Read", input: { file_path: "a.ts" } }] } });
const result = (id: string, seconds: number) => user([{ type: "tool_result", tool_use_id: id, content: "ok" }], seconds);

describe("rounds that never got an end", () => {
  it("does not count a background-task notice as something the person said", () => {
    const content = [user("do it", 0), text("done", 5), user("<task-notification>\n<task-id>b1</task-id>\n</task-notification>", 60)].join("\n");
    const parsed = parseClaudeJsonl("s.jsonl", content, at(60))!;
    expect(parsed.turnComplete).toBe(true);
    expect(parsed.messages.some((m) => m.text.includes("task-notification"))).toBe(false);
  });

  it("closes a round whose process went away mid-request, once it has been quiet long enough", () => {
    // Every tool has its result and the next API request went out, but no reply ever came.
    const content = [user("change the box", 0), call("t1", 2), result("t1", 3), line({ type: "cost-state", totalCostUSD: 1 })].join("\n");
    const parsed = parseClaudeJsonl("s.jsonl", content, at(3))!;
    expect(parsed.turnComplete).toBe(false);
    expect(parsed.idleSince).toBe(at(3));
    expect(settleAbandoned(parsed, t0 + 3000 + 60_000).turnComplete).toBe(false);
    const settled = settleAbandoned(parsed, t0 + 3000 + ABANDONED_MS + 1);
    expect(settled.turnComplete).toBe(true);
    expect(settled.messages.filter((m) => m.role === "turn").every((m) => m.endedAt)).toBe(true);
  });

  it("keeps waiting while a tool is still running, however long it takes", () => {
    const content = [user("run the build", 0), call("t1", 2)].join("\n");
    const parsed = parseClaudeJsonl("s.jsonl", content, at(2))!;
    expect(parsed.turnComplete).toBe(false);
    expect(parsed.idleSince).toBeUndefined();
    expect(settleAbandoned(parsed, t0 + 24 * 3_600_000).turnComplete).toBe(false);
  });

  it("ends a round, running tool and all, that was left by a Claude Code process MirrorMix has since replaced", () => {
    // A command was started, then MirrorMix restarted and began the session again with a new process.
    const content = [user("build it", 0), call("t1", 2)].join("\n");
    const parsed = parseClaudeJsonl("s.jsonl", content, at(2))!;
    expect(parsed.turnComplete).toBe(false);
    const settled = settleBeforeProcess(parsed, t0 + 60_000);
    expect(settled.turnComplete).toBe(true);
    expect(settled.messages.find((m) => m.role === "step")?.result).toEqual({ status: "error", summary: "Interrupted" });
    // The process that is running now started before the round: it is the one doing the work.
    expect(settleBeforeProcess(parsed, t0 - 60_000).turnComplete).toBe(false);
  });
});
