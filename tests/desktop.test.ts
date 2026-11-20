import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { claudeHostSession } from "../src/catalog/archive";

describe("claudeHostSession", () => {
  it("finds the desktop row of a transcript by its current or an earlier id", () => {
    const root = mkdtempSync(path.join(tmpdir(), "mirror-desktop-"));
    const dir = path.join(root, "claude_x", "claude-code-sessions", "acct", "org");
    mkdirSync(dir, { recursive: true });
    // The desktop app resumed 61eb… with --fork-session, so the transcript it writes now is e818….
    writeFileSync(
      path.join(dir, "local_26c891c6-64fd-4ce6-8741-54136d30a2e5.json"),
      JSON.stringify({
        cliSessionId: "e81899d5-92db-4a73-9187-98e31d9e4bac",
        priorCliSessionIds: ["61eb8555-ba6b-4a0c-9160-345c9e53a16a"],
      }),
    );
    writeFileSync(
      path.join(dir, "local_99999999-0000-0000-0000-000000000000.json"),
      JSON.stringify({ cliSessionId: "aaaaaaaa-0000-0000-0000-000000000000", isArchived: true }),
    );

    expect(claudeHostSession(root, "E81899D5-92DB-4A73-9187-98E31D9E4BAC")).toBe("local_26c891c6-64fd-4ce6-8741-54136d30a2e5");
    expect(claudeHostSession(root, "61eb8555-ba6b-4a0c-9160-345c9e53a16a")).toBe("local_26c891c6-64fd-4ce6-8741-54136d30a2e5");
    // An archived row no longer runs anywhere.
    expect(claudeHostSession(root, "aaaaaaaa-0000-0000-0000-000000000000")).toBeNull();
    expect(claudeHostSession(root, "bbbbbbbb-0000-0000-0000-000000000000")).toBeNull();
  });
});
