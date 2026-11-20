import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ProcessInfo } from "../src/process/occupancy";
import { createSupervisor } from "../src/process/supervisor";
import { createApp, listenLocal } from "../src/server/app";
import { createSettingsStore, detectTools } from "../src/settings/toolSettings";

const proc = (commandLine: string): ProcessInfo => ({ pid: 1, parentPid: 0, commandLine });
const SEP = String.fromCharCode(92);
const win = (...parts: string[]) => parts.join(SEP);

const claudeApp = proc(`"${win("C:", "Program Files", "WindowsApps", "Claude_5.1_x64__abc", "app", "Claude.exe")}" --type=renderer`);
const codexApp = proc(`"${win("C:", "Program Files", "WindowsApps", "OpenAI.Codex_26.7_x64__abc", "app", "ChatGPT.exe")}"`);
const cursorApp = proc(`"${win("C:", "Users", "me", "AppData", "Local", "Programs", "cursor", "Cursor.exe")}"`);
const deepseekDir = win("D:", "Programs", "DeepSeek Harness");
const deepseekApp = proc(`"${win(deepseekDir, "DeepSeek Harness.exe")}" `);
// After an update the app restarts itself with a flag.
const deepseekUpdated = proc(`"${win(deepseekDir, "DeepSeek Harness.exe")}" --updated`);
const deepseekHelper = proc(`"${win(deepseekDir, "DeepSeek Harness.exe")}" --type=renderer --lang=zh-CN`);
const deepseekCli = proc(`"${win(deepseekDir, "DeepSeek Harness.exe")}" --expose-internals cli.js headless --json -`);
// The command-line programs this server starts are not the tool's own app.
const claudeCli = proc(`${win("C:", "Users", "me", "AppData", "Local", "Claude-Data", "claude-code", "2.1", "claude.exe")} --resume abc`);
const codexCli = proc(`node.exe ${win("C:", "nvm4w", "nodejs", "node_modules", "@openai", "codex", "bin", "codex.js")} resume abc`);

describe("tool settings", () => {
  it("counts a tool as open only when its desktop app is running", () => {
    expect(detectTools([claudeCli, codexCli, deepseekHelper, deepseekCli])).toEqual({ claude: { running: false }, codex: { running: false }, cursor: { running: false }, deepseek: { running: false } });
    expect(detectTools([claudeApp, codexCli, cursorApp, deepseekApp])).toEqual({ claude: { running: true }, codex: { running: false }, cursor: { running: true }, deepseek: { running: true } });
    expect(detectTools([codexApp]).codex.running).toBe(true);
    expect(detectTools([deepseekHelper, deepseekUpdated]).deepseek.running).toBe(true);
  });

  it("saves the chosen tools and refuses work for a tool that is off or not open", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "aimiss-settings-"));
    let processes: ProcessInfo[] = [codexApp];
    const settings = createSettingsStore(path.join(root, "nested", "settings.json"), () => processes);
    const supervisor = createSupervisor({
      bins: { claudeExe: "claude.exe", nodeExe: "node.exe", codexJs: "codex.js" },
      roots: { claudeProjectsDir: path.join(root, "projects"), codexSessionsDir: path.join(root, "sessions"), claudeDataDir: "" },
      listProcesses: () => processes,
      spawn: () => {
        throw new Error("should not spawn");
      },
    });
    const server = createApp(supervisor, settings);
    await listenLocal(server, 0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const json = { "content-type": "application/json" };
    try {
      const first = (await (await fetch(`${base}/api/settings`)).json()) as { host: string };
      expect(first.host).toBeTruthy();
      expect(first).toMatchObject({
        tools: ["claude", "codex", "cursor", "deepseek"],
        status: { claude: { running: false }, codex: { running: true }, cursor: { running: false }, deepseek: { running: false } },
      });

      const saved = await fetch(`${base}/api/settings`, { method: "PUT", headers: json, body: JSON.stringify({ tools: ["cursor", "codex", "nope"] }) });
      expect((await saved.json()).tools).toEqual(["codex", "cursor"]);
      expect(settings.read().tools).toEqual(["codex", "cursor"]);
      expect((await fetch(`${base}/api/settings`, { method: "PUT", headers: json, body: JSON.stringify({}) })).status).toBe(400);

      const open = (tool: string) =>
        fetch(`${base}/api/sessions/open`, { method: "POST", headers: json, body: JSON.stringify({ tool, id: "missing" }) }).then(
          async (response) => [response.status, (await response.json()).error],
        );
      // Claude is switched off, Cursor's app is not open, Codex gets through to the session lookup.
      expect(await open("claude")).toEqual([409, "tool_offline"]);
      expect(await open("cursor")).toEqual([409, "tool_offline"]);
      expect(await open("codex")).toEqual([404, "unknown_session"]);

      processes = [];
      expect(await open("codex")).toEqual([409, "tool_offline"]);
    } finally {
      supervisor.dispose();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
