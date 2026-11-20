import { describe, expect, it } from "vitest";
import { claudeInboxFrames, isClaudePipe } from "../src/process/claudeInbox";
import { appendDesktopStream } from "../src/process/desktopComposer";
import { claudeChildEnv, isDesktopClaudeCommand } from "../src/process/hostAuth";
import { isOccupied } from "../src/process/occupancy";
import { launchSpec, resolveBins, terminalEnv } from "../src/process/launch";

const bins = {
  claudeExe: "C:\\claude\\claude.exe",
  nodeExe: "C:\\node\\node.exe",
  codexJs: "C:\\codex\\codex.js",
};

describe("interactive terminal environment", () => {
  it("repairs inherited TERM=dumb without changing the parent or dropping authentication variables", () => {
    const parent = { TERM: "dumb", PATH: "tools", API_TOKEN: "fixture", UNUSED: undefined };
    expect(terminalEnv(parent)).toEqual({ TERM: "xterm-256color", COLORTERM: "truecolor", PATH: "tools", API_TOKEN: "fixture" });
    expect(parent.TERM).toBe("dumb");
  });
  it("supplies missing values and preserves an explicitly supported terminal type", () => {
    expect(terminalEnv({}).TERM).toBe("xterm-256color");
    expect(terminalEnv({ TERM: "screen-256color", COLORTERM: "24bit" })).toEqual({ TERM: "screen-256color", COLORTERM: "24bit" });
  });
});

describe("isOccupied", () => {
  it("ignores processes this tool owns, including children", () => {
    const processes = [
      { pid: 10, parentPid: 1, commandLine: "claude.exe --resume sess-1" },
      { pid: 11, parentPid: 10, commandLine: "claude.exe --resume sess-1 helper" },
      { pid: 12, parentPid: 1, commandLine: "claude.exe --resume sess-2" },
    ];
    expect(isOccupied("sess-1", processes, [10])).toBe(false);
    expect(isOccupied("sess-2", processes, [10])).toBe(true);
  });
});

describe("launchSpec", () => {
  it("launches native Codex directly, including resume and config overrides", () => {
    const native = { ...bins, codexExe: "C:\\Codex\\codex.exe" };
    expect(launchSpec("codex", "C:\\work", native, "thread", ["-c", 'service_tier="fast"'])).toEqual({
      file: native.codexExe, args: ["-c", 'service_tier="fast"', "resume", "thread"], cwd: "C:\\work",
    });
    expect(launchSpec("codex", "C:\\work", native)).toEqual({ file: native.codexExe, args: [], cwd: "C:\\work" });
  });
  it("resumes an existing session and starts a new one without an id", () => {
    expect(launchSpec("claude", "D:\\AutoWork", bins, "sess-1")).toEqual({
      file: bins.claudeExe,
      args: ["--resume", "sess-1"],
      cwd: "D:\\AutoWork",
    });
    expect(launchSpec("claude", "D:\\AutoWork", bins, "sess-1", [], undefined, "lockscreen message")).toEqual({
      file: bins.claudeExe,
      args: ["--resume", "sess-1", "lockscreen message"],
      cwd: "D:\\AutoWork",
    });
    expect(launchSpec("codex", "E:\\WM\\efp", bins)).toEqual({
      file: bins.nodeExe,
      args: [bins.codexJs],
      cwd: "E:\\WM\\efp",
    });
    expect(launchSpec("codex", "E:\\WM\\efp", bins, "codex-1").args).toEqual([
      bins.codexJs,
      "resume",
      "codex-1",
    ]);
  });
});

describe("appendDesktopStream", () => {
  it("grows the current reply and leaves a finished reply in place", () => {
    const started = appendDesktopStream(
      [{ id: "u", role: "user", text: "hi" }],
      "正在",
    );
    expect(started.at(-1)).toMatchObject({ id: "c-stream", text: "正在" });
    const grown = appendDesktopStream(started, "正在写");
    expect(grown).toHaveLength(2);
    expect(grown.at(-1)?.text).toBe("正在写");
    const done = appendDesktopStream(
      [{ id: "u", role: "user", text: "hi" }, { id: "a", role: "assistant", text: "正在写完" }],
      "正在写",
    );
    expect(done.at(-1)?.id).toBe("a");
  });
});

describe("claudeChildEnv", () => {
  it("fills a missing login from the already running desktop process and keeps an existing value", () => {
    const env = claudeChildEnv(
      { PATH: "C:\\Windows", CLAUDE_CODE_OAUTH_TOKEN: "already" },
      { HTTPS_PROXY: "http://127.0.0.1:7890" },
      { CLAUDE_CODE_OAUTH_TOKEN: "from-desktop", CLAUDE_CODE_USER_EMAIL: "user@example.com", OTHER: "no" },
    );
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("already");
    expect(env.CLAUDE_CODE_USER_EMAIL).toBe("user@example.com");
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
    expect(env.OTHER).toBeUndefined();
  });
});

describe("claudeInboxFrames", () => {
  it("authenticates and then sends the same user text the AI tool will show", () => {
    const frames = claudeInboxFrames("token", "你好").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(frames).toEqual([
      { type: "auth", token: "token" },
      { type: "user", message: { role: "user", content: "你好" } },
    ]);
  });
});

describe("isDesktopClaudeCommand", () => {
  it("matches the desktop binary and skips the npm shim", () => {
    expect(
      isDesktopClaudeCommand(
        String.raw`C:\Users\Administrator\AppData\Local\Claude-Data\claude_x\claude-code\2.1.322\claude.exe --resume abc`,
      ),
    ).toBe(true);
    expect(
      isDesktopClaudeCommand(String.raw`C:\nvm4w\nodejs\node_modules\@anthropic-ai\claude-code\bin\claude.exe`),
    ).toBe(false);
  });
});

describe("isClaudePipe", () => {
  it("accepts a local pipe, including one extra path segment", () => {
    expect(isClaudePipe("\\\\.\\pipe\\claude-session")).toBe(true);
    expect(isClaudePipe("\\\\.\\pipe\\LOCAL\\claude-session")).toBe(true);
    expect(isClaudePipe("C:\\temp\\sock")).toBe(false);
  });
});

describe("resolveBins", () => {
  it("preselects standalone mode only when a native CLI advertises it", () => {
    const where = (name: string) => name === "claude" ? "C:\\claude.exe" : "C:\\codex.exe";
    const resolved = resolveBins(where, "node.exe", () => "Options: --no-daemon");
    expect(launchSpec("codex", "C:\\work", resolved).args).toEqual(["--no-daemon"]);
    expect(launchSpec("codex", "C:\\work", resolved, "thread", ["-c", 'service_tier="fast"']).args).toEqual(["--no-daemon", "-c", 'service_tier="fast"', "resume", "thread"]);
    expect(resolveBins(where, "node.exe", () => "older CLI help").codexArgs).toBeUndefined();
  });
  it("recognizes the executable shipped by the desktop app", () => {
    const resolved = resolveBins((name) => name === "claude" ? "C:\\tools\\claude.exe" : "C:\\Codex\\codex.exe", "C:\\node.exe");
    expect(resolved.codexExe).toBe("C:\\Codex\\codex.exe");
    expect(launchSpec("codex", "C:\\work", resolved).file).toBe(resolved.codexExe);
  });
  it("finds the real executables next to the npm shims", () => {
    const where = (name: string) =>
      name === "claude" ? "C:\\nvm4w\\nodejs\\claude.ps1" : "C:\\nvm4w\\nodejs\\codex.cmd";
    expect(resolveBins(where, "C:\\node.exe")).toEqual({
      claudeExe: "C:\\nvm4w\\nodejs\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe",
      nodeExe: "C:\\node.exe",
      codexJs: "C:\\nvm4w\\nodejs\\node_modules\\@openai\\codex\\bin\\codex.js",
    });
  });
  it("leaves a CLI that is not installed empty instead of stopping the start", () => {
    expect(resolveBins(() => null, "C:\\node.exe")).toEqual({ claudeExe: "", nodeExe: "C:\\node.exe", codexJs: "" });
    expect(resolveBins((name) => (name === "claude" ? "C:\\tools\\claude.exe" : null), "C:\\node.exe")).toEqual({
      claudeExe: "C:\\tools\\claude.exe",
      nodeExe: "C:\\node.exe",
      codexJs: "",
    });
  });
});

describe("a PC without the CLIs", () => {
  it("opens nothing it cannot start, says which CLI is missing, and offers no new sessions for it", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const nodePath = await import("node:path");
    const { encodeClaudeProject } = await import("../src/process/launch");
    const { createSupervisor } = await import("../src/process/supervisor");
    const root = mkdtempSync(nodePath.join(tmpdir(), "aimiss-nocli-"));
    const cwd = nodePath.join(root, "work");
    const project = nodePath.join(root, "projects", encodeClaudeProject(cwd));
    mkdirSync(cwd, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(nodePath.join(project, "s1.jsonl"), JSON.stringify({ type: "user", sessionId: "s1", cwd, message: { role: "user", content: "以前的会话" } }));
    let spawned = 0;
    const supervisor = createSupervisor({
      bins: { claudeExe: "", nodeExe: "C:\\node.exe", codexJs: "" },
      roots: { claudeProjectsDir: nodePath.join(root, "projects"), codexSessionsDir: nodePath.join(root, "sessions"), claudeDataDir: "" },
      listProcesses: () => [],
      spawn: () => {
        spawned += 1;
        throw new Error("must not start");
      },
    });
    expect(supervisor.capabilities().create).toMatchObject({ claude: false, codex: false });
    expect(() => supervisor.open("claude", "s1")).toThrow("claude_cli_missing");
    // Reading the history still works.
    expect(supervisor.getSession("claude", "s1").messages[0].text).toBe("以前的会话");
    expect(spawned).toBe(0);
    supervisor.dispose();
  });
});
