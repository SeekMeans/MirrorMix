import { describe, expect, it } from "vitest";
import { readScreenPrompt, screenAnswerKeys } from "../src/transcript/screenPrompt";

const claudeBash = [
  "● I'll run the tests.",
  "",
  "╭──────────────────────────────────────────────────────────────╮",
  "│ Bash command                                                 │",
  "│                                                              │",
  "│   npm test                                                   │",
  "│   Run the unit tests                                         │",
  "│                                                              │",
  "│ Do you want to proceed?                                      │",
  "│ ❯ 1. Yes                                                     │",
  "│   2. Yes, and don't ask again for npm test commands in E:\\w  │",
  "│   3. No, and tell Claude what to do differently (esc)        │",
  "╰──────────────────────────────────────────────────────────────╯",
  "",
];

const codexExec = [
  "• Running the build",
  "",
  "  Would you like to run the following command?",
  "",
  "  $ npm run build",
  "",
  "› 1. Yes, proceed (y)",
  "  2. Yes, and don't ask again for this command (a)",
  "  3. No, and tell Codex what to do differently (esc)",
  "",
  "  Press enter to confirm or esc to cancel",
];

const ask = [
  " ☐ Scope",
  "",
  "Which confirmations should the web handle?",
  "",
  "❯ 1. Terminal first",
  "     Full support for terminal sessions.",
  "  2. All tools",
  "     Terminal and every desktop app.",
  "  3. Type something.",
  "",
  "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
];

describe("a question on the terminal screen", () => {
  it("reads Claude Code's permission box: what, the question, and the answers", () => {
    const prompt = readScreenPrompt(claudeBash)!;
    expect(prompt).toMatchObject({ kind: "permission", title: "Do you want to proceed?", via: "terminal" });
    expect(prompt.detail).toBe("Bash command\nnpm test\nRun the unit tests");
    expect(prompt.options.map((option) => [option.id, option.tone])).toEqual([
      ["1", "yes"],
      ["2", "yes"],
      ["3", "no"],
    ]);
    expect(prompt.options[2].label).toBe("No, and tell Claude what to do differently");
  });

  it("reads Codex's approval and drops the key hints from the labels", () => {
    const prompt = readScreenPrompt(codexExec)!;
    expect(prompt).toMatchObject({ kind: "permission", title: "Would you like to run the following command?", detail: "$ npm run build" });
    expect(prompt.options.map((option) => option.label)).toEqual([
      "Yes, proceed",
      "Yes, and don't ask again for this command",
      "No, and tell Codex what to do differently",
    ]);
  });

  it("reads an AskUserQuestion with its header and descriptions, leaving out the free-text row", () => {
    const prompt = readScreenPrompt(ask)!;
    expect(prompt).toMatchObject({ kind: "question", header: "Scope", title: "Which confirmations should the web handle?" });
    expect(prompt.options).toEqual([
      { id: "1", label: "Terminal first", description: "Full support for terminal sessions." },
      { id: "2", label: "All tools", description: "Terminal and every desktop app." },
    ]);
  });

  it("does not take a numbered list in a reply for a menu", () => {
    expect(readScreenPrompt(["● Steps:", "  1. Build", "  2. Test", "", "❯ "])).toBeNull();
    expect(readScreenPrompt(["● Steps:", "  1. Build", "  2. Test"])).toBeNull();
  });

  it("answers with arrows from the highlighted row, and refuses once the question changed", () => {
    const prompt = readScreenPrompt(claudeBash)!;
    expect(screenAnswerKeys(claudeBash, prompt.id, "3")).toBe("\u001b[B\u001b[B\r");
    expect(screenAnswerKeys(claudeBash, prompt.id, "1")).toBe("\r");
    const moved = claudeBash.map((line) => line.replace("❯ 1.", "  1.").replace("  2. Yes", "❯ 2. Yes"));
    expect(screenAnswerKeys(moved, prompt.id, "1")).toBe("\u001b[A\r");
    expect(screenAnswerKeys(claudeBash, "stale", "1")).toBeNull();
    expect(screenAnswerKeys(["all done", "❯ "], prompt.id, "1")).toBeNull();
  });
});
