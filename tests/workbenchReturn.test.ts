import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(path.join(process.cwd(), "client", "src", "App.tsx"), "utf8");

describe("desktop workbench return", () => {
  it("clears the selected conversation before showing the workbench", () => {
    const start = source.indexOf("const showRunning = useCallback(");
    const end = source.indexOf("const showPinned", start);
    expect(source.slice(start, end)).toContain("clear();");
  });
});
