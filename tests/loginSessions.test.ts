import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createLoginSessions, LOGIN_LIFETIME_MS, LOGIN_RENEW_STEP_MS } from "../src/server/loginSessions";

describe("login sessions", () => {
  const file = () => path.join(mkdtempSync(path.join(os.tmpdir(), "mm-login-")), "login-sessions.json");

  it("keeps a sign-in across a restart and stores only a hash", () => {
    const where = file();
    createLoginSessions(where).add("tok-abc", "tester");
    expect(readFileSync(where, "utf8")).not.toContain("tok-abc");
    const restarted = createLoginSessions(where);
    expect(restarted.has("tok-abc")).toBe(true);
    expect(restarted.has("other")).toBe(false);
  });

  it("forgets signed-out and expired sign-ins", () => {
    const where = file();
    let now = 1_000;
    const first = createLoginSessions(where, () => now);
    first.add("a", "tester");
    first.add("b", "tester");
    first.delete("a");
    expect(createLoginSessions(where, () => now).has("a")).toBe(false);
    now += LOGIN_LIFETIME_MS + 1;
    expect(createLoginSessions(where, () => now).has("b")).toBe(false);
  });

  it("lasts 15 hours, and use pushes the end out again", () => {
    expect(LOGIN_LIFETIME_MS).toBe(15 * 60 * 60_000);
    let now = 1_000_000;
    const sessions = createLoginSessions(file(), () => now);
    sessions.add("tok", "tester");
    // Used just now: nothing to move yet, so no new cookie on every poll.
    now += LOGIN_RENEW_STEP_MS - 1;
    expect(sessions.renew("tok")).toBe(false);
    // Used 10 hours in: good for another full 15 hours from then.
    now += 10 * 60 * 60_000;
    expect(sessions.renew("tok")).toBe(true);
    now += 14 * 60 * 60_000 + 59 * 60_000;
    expect(sessions.has("tok")).toBe(true);
    // Left alone for the 15 hours after its last use: gone, and use can no longer bring it back.
    now += 2 * 60_000;
    expect(sessions.has("tok")).toBe(false);
    expect(sessions.renew("tok")).toBe(false);
    expect(sessions.renew("never-signed-in")).toBe(false);
  });

  it("keeps a renewal across a restart", () => {
    const where = file();
    let now = 5_000_000;
    createLoginSessions(where, () => now).add("tok", "tester");
    now += 10 * 60 * 60_000;
    expect(createLoginSessions(where, () => now).renew("tok")).toBe(true);
    now += 12 * 60 * 60_000;
    expect(createLoginSessions(where, () => now).has("tok")).toBe(true);
  });

  it("cuts sign-ins saved under the old 30-day lifetime down to 15 hours", () => {
    const where = file();
    const now = 9_000_000;
    createLoginSessions(where, () => now).add("tok", "tester");
    const saved = JSON.parse(readFileSync(where, "utf8")) as Record<string, { expiresAt: number }>;
    for (const entry of Object.values(saved)) entry.expiresAt = now + 30 * 24 * 3_600_000;
    writeFileSync(where, JSON.stringify(saved));
    // Restarted now: still signed in, but only for the next 15 hours.
    expect(createLoginSessions(where, () => now).has("tok")).toBe(true);
    expect(createLoginSessions(where, () => now + LOGIN_LIFETIME_MS + 1).has("tok")).toBe(false);
  });
});
