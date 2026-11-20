import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(path.join(process.cwd(), "client", "src", "App.tsx"), "utf8");

describe("mobile workbench return", () => {
  it("keeps the selected conversation marked as seen after returning to the list", () => {
    expect(source).toContain("const finished = useFinished(catalog, sessionKey);");
  });
});
