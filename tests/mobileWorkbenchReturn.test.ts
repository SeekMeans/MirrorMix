import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const app = readFileSync(path.join(process.cwd(), "client", "src", "App.tsx"), "utf8");
const finished = readFileSync(path.join(process.cwd(), "client", "src", "useFinished.ts"), "utf8");

describe("mobile workbench return", () => {
  // On a phone the session stays chosen after going back to the list. A reply that finishes then was not read,
  // so it must wait on the workbench instead of being taken as seen.
  it("counts a session as seen only while its conversation is showing", () => {
    expect(app).toContain('const finished = useFinished(catalog, conversationShown ? sessionKey : "");');
  });

  // A phone browser drops a page left in the background; the replies running before are remembered across that.
  it("remembers which sessions were replying across a page reload", () => {
    expect(finished).toContain("useRef<Set<string> | null>(readWorking())");
    expect(finished).toContain("saveWorking(now);");
  });
});
