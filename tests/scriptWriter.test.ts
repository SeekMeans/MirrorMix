import { describe, expect, it } from "vitest";
import { readScript, scriptPrompt } from "../src/models/scriptWriter";

describe("AI-written snippets", () => {
  it("tells the model which shell it writes for, and what to change when there is a command already", () => {
    const [system, user] = scriptPrompt("windows", "看看 C 盘空间");
    expect(system.content).toContain("PowerShell");
    expect(user.content).toBe("看看 C 盘空间");
    expect(scriptPrompt("python", "统计 IP")[0].content).toContain("python3 - <<'PY'");
    expect(scriptPrompt("linux", "再加上重启 nginx", "git pull\n")[1].content).toContain("git pull");
  });

  it("reads the JSON it asked for, a fenced reply, or plain text", () => {
    expect(readScript('{"label": "部署", "command": "git pull\\n./install.sh"}')).toEqual({ label: "部署", command: "git pull\n./install.sh" });
    expect(readScript('```json\n{"label": "x", "command": "```bash\\nls -la\\n```"}\n```')).toEqual({ label: "x", command: "ls -la" });
    expect(readScript("```bash\ndf -h\n```")).toEqual({ label: "", command: "df -h" });
    expect(readScript("uptime")).toEqual({ label: "", command: "uptime" });
  });
});
