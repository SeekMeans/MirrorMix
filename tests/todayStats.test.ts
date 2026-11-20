import { describe, expect, it } from "vitest";
import { countToday, startOfToday } from "../src/catalog/todayStats";
import type { ParsedSession } from "../src/shared/types";

const now = new Date(2026, 10, 19, 15, 30).getTime();
const at = (hours: number, minutes = 0, dayOffset = 0) => new Date(2026, 10, 19 + dayOffset, hours, minutes).toISOString();

/** A round: started at `start`, finished `minutes` later (open when null), with `tokens` of reply. */
type Round = [start: string, minutes: number | null, tokens?: number];

const session = (id: string, rounds: Round[], options: { updatedAt?: string; title?: string; cwd?: string } = {}): ParsedSession => ({
  id,
  cwd: options.cwd ?? "E:/work/demo",
  title: options.title ?? id,
  updatedAt: options.updatedAt ?? at(15),
  turnComplete: true,
  messages: rounds.flatMap(([startedAt, minutes, tokens], index) => [
    { id: `${id}-u${index}`, role: "user" as const, text: "hi" },
    { id: `${id}-a${index}`, role: "assistant" as const, text: "hello" },
    {
      id: `${id}-t${index}`,
      role: "turn" as const,
      text: "",
      startedAt,
      ...(minutes == null ? {} : { endedAt: new Date(Date.parse(startedAt) + minutes * 60_000).toISOString() }),
      ...(tokens ? { tokens } : {}),
    },
  ]),
});

describe("today's conversations", () => {
  it("counts messages, conversations, new ones, reply time and tokens per tool", () => {
    const stats = countToday(
      {
        claude: [
          session("a", [[at(23, 50, -1), 5], [at(9), 2, 100], [at(10, 30), 3, 50]], { title: "重构", cwd: "E:/Me/AIMiss" }),
          session("b", [[at(0, 1), 1, 10]]),
        ],
        codex: [session("c", [[at(14), 4]])],
        cursor: [],
        deepseek: [session("d", [[at(12), 1]], { updatedAt: at(12) })],
      },
      now,
    );
    expect(stats.total).toBe(5);
    expect(stats.conversations).toBe(4);
    // "a" began yesterday; the other three began today.
    expect(stats.started).toBe(3);
    expect(stats.byTool.claude).toEqual({ messages: 3, conversations: 2, started: 1, busyMs: 6 * 60_000, tokens: 160 });
    expect(stats.byTool.codex).toMatchObject({ messages: 1, conversations: 1, started: 1, busyMs: 4 * 60_000 });
    expect(stats.byTool.cursor).toEqual({ messages: 0, conversations: 0, started: 0, busyMs: 0, tokens: 0 });
    expect(stats.busyMs).toBe(11 * 60_000);
    expect(stats.since).toBe(startOfToday(now));
  });

  it("lists the busiest conversations, most messages first and then the latest", () => {
    const stats = countToday(
      {
        claude: [session("one", [[at(9), 1]]), session("three", [[at(8), 1], [at(9), 1], [at(10), 1]], { title: "三条", cwd: "E:/Me/AIMiss/" })],
        codex: [session("one-later", [[at(13), 1]])],
      },
      now,
    );
    expect(stats.top.map((item) => [item.tool, item.id, item.messages])).toEqual([
      ["claude", "three", 3],
      ["codex", "one-later", 1],
      ["claude", "one", 1],
    ]);
    expect(stats.top[0]).toMatchObject({ title: "三条", place: "AIMiss", lastAt: Date.parse(at(10)) });
  });

  it("caps a round that never ended, and skips sessions untouched today or listed twice", () => {
    const hung = session("hung", [[at(9), null]]);
    const old = session("old", [[at(10, 0, -1), 1]], { updatedAt: at(10, 0, -1) });
    const twice = session("twice", [[at(11), 1]]);
    const stats = countToday({ claude: [hung, old, twice, twice] }, now);
    expect(stats.byTool.claude.messages).toBe(2);
    expect(stats.byTool.claude.busyMs).toBe(30 * 60_000 + 60_000);
  });

  it("starts from midnight on this computer", () => {
    expect(new Date(startOfToday(now)).getHours()).toBe(0);
    expect(now - startOfToday(now)).toBeLessThan(24 * 3_600_000);
  });
});
