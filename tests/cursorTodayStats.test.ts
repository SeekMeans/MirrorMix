import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(path.join(process.cwd(), "src", "process", "supervisor.ts"), "utf8");

describe("Cursor today statistics", () => {
  it("hydrates Cursor transcripts before counting today's rounds", () => {
    expect(source).toContain("cursor: today.cursor.map((session) => readSession(\"cursor\", session.filePath, options.roots.cursorStateDb) ?? session)");
  });
});
