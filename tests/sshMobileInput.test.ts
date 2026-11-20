import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(path.join(process.cwd(), "client", "src", "SshPlugin.tsx"), "utf8");

describe("mobile SSH terminal", () => {
  it("provides a command input that sends the line followed by Enter", () => {
    expect(source).toContain('placeholder={ready ? "输入命令，回车执行" : "正在连接 SSH"}');
    expect(source).toContain('press(`${line}\\r`)');
  });
});
