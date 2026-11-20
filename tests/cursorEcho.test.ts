import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(path.join(process.cwd(), "src", "process", "supervisor.ts"), "utf8");

describe("Cursor local echo", () => {
  it("pushes the pending message before waiting for Cursor's desktop window", () => {
    const send = source.slice(source.indexOf("const send = async"));
    const cursorBranch = send.slice(send.indexOf("if (runtime.headless)"), send.indexOf("// Whether the page was already shown"));
    expect(cursorBranch).toContain("remember();\n      emit(tool, id);\n      try {");
  });
});
