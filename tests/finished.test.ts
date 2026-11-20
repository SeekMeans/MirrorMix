import { describe, expect, it } from "vitest";
import { clearFinishedAfterNativeRead, clearFinishedOnView } from "../client/src/useFinished";

describe("finished session attention", () => {
  it("removes a completed session from the home list as soon as it is opened", () => {
    expect(clearFinishedOnView(new Set(["codex:read", "cursor:waiting"]), "codex:read")).toEqual(new Set(["cursor:waiting"]));
  });

  it("removes a completed Codex session after Codex clears its unread flag", () => {
    expect(
      clearFinishedAfterNativeRead(
        new Set(["codex:read", "cursor:waiting"]),
        new Set(["codex:read"]),
        new Set<string>(),
        new Set(["codex:read", "cursor:waiting"]),
      ),
    ).toEqual(new Set(["cursor:waiting"]));
  });
});
