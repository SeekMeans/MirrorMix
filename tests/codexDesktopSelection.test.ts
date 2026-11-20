import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(path.join(process.cwd(), "src", "process", "desktopComposer.ps1"), "utf8");

describe("Codex desktop session selection", () => {
  it("selects the task row itself instead of invoking its pin or archive controls", () => {
    const start = source.indexOf("if ($Tool -eq 'codex') {");
    const end = source.indexOf("  } else {", start);
    const codexBranch = source.slice(start, end);
    expect(codexBranch).toContain("Click-CodexSession $chosen");
    expect(codexBranch).not.toContain("$buttons = $chosen.FindAll");
  });
});
