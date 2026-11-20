import { describe, expect, it } from "vitest";
import { commandOf } from "../client/src/runCommand";

describe("commands in replies", () => {
  it("offers shell blocks only", () => {
    expect(commandOf("bash", "npm run dev\n")).toBe("npm run dev");
    expect(commandOf("PowerShell", "Get-Date")).toBe("Get-Date");
    expect(commandOf("ts", "const a = 1;")).toBeNull();
    expect(commandOf("", "npm run dev")).toBeNull();
    expect(commandOf("bash", "  \n ")).toBeNull();
  });

  it("drops copied prompts and blank lines", () => {
    expect(commandOf("console", "$ npm install\n\n$ npm test")).toBe("npm install\nnpm test");
    expect(commandOf("powershell", "PS E:\Me\AIMiss> npm run dev")).toBe("npm run dev");
  });
});
