import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { claudeHostAuthForLaunch } from "../src/process/hostAuth";
import { createSupervisor } from "../src/process/supervisor";
import { asksForLogin } from "../src/transcript/screen";
import type { LaunchRequest } from "../src/shared/types";

describe("Claude Code that MirrorMix starts without a sign-in", () => {
  it("recognises the login screen", () => {
    expect(asksForLogin(["Select login method:", "❯ 1. Claude account with subscription", "  2. Anthropic Console account"])).toBe(true);
    expect(asksForLogin(["API Error: 401 · Please run /login"])).toBe(true);
    expect(asksForLogin(["> ", "? for shortcuts"])).toBe(false);
  });

  it("asks again, past the cache, when the sign-in could not be found at launch", () => {
    const read = vi.fn<() => Record<string, string>>().mockReturnValueOnce({}).mockReturnValueOnce({ CLAUDE_CODE_OAUTH_TOKEN: "t" });
    expect(claudeHostAuthForLaunch(3, read, () => ({}))).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "t" });
    expect(read).toHaveBeenCalledTimes(2);
    expect(claudeHostAuthForLaunch(3, read, () => ({ CLAUDE_CODE_OAUTH_TOKEN: "cached" })).CLAUDE_CODE_OAUTH_TOKEN).toBe("cached");
  });

  it("starts a session that came up signed out again, once, when the sign-in can be found", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "login-"));
    const claudeProjectsDir = path.join(root, "projects");
    mkdirSync(path.join(claudeProjectsDir, "fixture"), { recursive: true });
    writeFileSync(
      path.join(claudeProjectsDir, "fixture", "claude-thread.jsonl"),
      JSON.stringify({ type: "user", sessionId: "claude-thread", cwd: root, message: { role: "user", content: "hi" } }),
    );
    const terminals: Array<{ data: (text: string) => void; exit: () => void; killed: boolean }> = [];
    const spawn = vi.fn((_spec: LaunchRequest) => {
      const terminal = { data: (_text: string) => {}, exit: () => {}, killed: false };
      terminals.push(terminal);
      return {
        pid: terminals.length,
        write() {},
        resize() {},
        kill() {
          terminal.killed = true;
          setTimeout(() => terminal.exit(), 0);
        },
        onData(callback: (text: string) => void) {
          terminal.data = callback;
        },
        onExit(callback: (code: number) => void) {
          terminal.exit = () => callback(0);
        },
      };
    });
    const supervisor = createSupervisor({
      roots: { codexSessionsDir: path.join(root, "sessions"), claudeProjectsDir, claudeDataDir: "" },
      bins: { claudeExe: "claude.exe", nodeExe: "node.exe", codexJs: "codex.js" },
      spawn,
      listProcesses: () => [],
      claudeSignedIn: () => true,
    });
    try {
      supervisor.open("claude", "claude-thread");
      terminals[0].data("Select login method:\r\n❯ 1. Claude account with subscription\r\n  2. Anthropic Console account\r\n");
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(terminals[0].killed).toBe(true);
      // The replaced process exiting does not end the session.
      expect(supervisor.getSession("claude", "claude-thread").status).toBe("running");
      // Only once: a second login screen is left for the person.
      terminals[1].data("Select login method:\r\n");
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(spawn).toHaveBeenCalledTimes(2);
    } finally {
      supervisor.dispose();
    }
  });
});
