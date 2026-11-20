import path from "node:path";
import type { LaunchRequest, ToolBins, ToolId } from "../shared/types";

export function encodeClaudeProject(cwd: string): string {
  return path.resolve(cwd).replace(/:/g, "-").replace(/[\\/]/g, "-");
}

export function samePath(left: string, right: string): boolean {
  return path.resolve(left).toLocaleLowerCase() === path.resolve(right).toLocaleLowerCase();
}

/** A PTY must advertise its terminal type explicitly; Windows does not apply node-pty's name to env. */
export function terminalEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) if (typeof value === "string") env[key] = value;
  if (!env.TERM?.trim() || env.TERM.toLowerCase() === "dumb") env.TERM = "xterm-256color";
  if (!env.COLORTERM) env.COLORTERM = "truecolor";
  return env;
}

/** Terminal output with its colour, cursor and window-title sequences removed. */
function plainOutput(output: string): string {
  return output.replace(/\u001b\][^\u0007]*\u0007/g, "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

/**
 * Learn a compatibility override from the CLI's startup error: an older config value, or a desktop
 * executable that needs --no-daemon because it does not ship a complete background-server package.
 */
export function codexConfigFix(output: string): string[] | null {
  if (plainOutput(output).includes("this CLI has no complete local package")) return ["--no-daemon"];
  const match = plainOutput(output).match(
    /Error loading config\.toml: unknown variant `[^`]*`, expected (?:one of )?`([^`]+)`[^\r\n]*\s+in `([A-Za-z0-9_.]+)`/,
  );
  return match ? ["-c", `${match[2]}="${match[1]}"`] : null;
}

/** What a short-lived process printed, for telling the person why it would not stay up. */
export function exitNote(output: string): string {
  const plain = plainOutput(output);
  if (plain.length > 2000) return "";
  return plain
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .slice(0, 300);
}

export function launchSpec(
  tool: ToolId,
  cwd: string,
  bins: ToolBins,
  sessionId?: string,
  codexOptions: string[] = [],
  /** A new Claude session started under this id, so it is known before its transcript exists. */
  newSessionId?: string,
  /** Pass an initial prompt to Claude when a resumed terminal must begin work immediately. */
  initialPrompt?: string,
): LaunchRequest {
  if (tool === "claude") {
    return {
      file: bins.claudeExe,
      args: sessionId
        ? ["--resume", sessionId, ...(initialPrompt ? [initialPrompt] : [])]
        : newSessionId ? ["--session-id", newSessionId] : [],
      cwd,
    };
  }
  codexOptions = [...(bins.codexArgs ?? []), ...codexOptions];
  if (bins.codexExe) {
    return { file: bins.codexExe, args: sessionId ? [...codexOptions, "resume", sessionId] : codexOptions, cwd };
  }
  return {
    file: bins.nodeExe,
    args: sessionId ? [bins.codexJs, ...codexOptions, "resume", sessionId] : [bins.codexJs, ...codexOptions],
    cwd,
  };
}

/**
 * Where the Claude Code and Codex CLIs are. One that is not installed is left empty: MirrorMix still runs, follows
 * the desktop apps and Cursor, and says so only when that CLI would have to be started.
 */
export function resolveBins(where: (name: string) => string | null, nodeExe: string, readHelp?: (file: string) => string): ToolBins {
  const claudeShim = where("claude");
  const codexShim = where("codex");
  const claudeExe = !claudeShim
    ? ""
    : claudeShim.toLowerCase().endsWith("claude.exe")
      ? claudeShim
      : path.join(path.dirname(claudeShim), "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
  if (!codexShim) return { claudeExe, nodeExe, codexJs: "" };
  const codexJs = codexShim.toLowerCase().endsWith("codex.js")
    ? codexShim
    : path.join(path.dirname(codexShim), "node_modules", "@openai", "codex", "bin", "codex.js");
  const native = codexShim.toLowerCase().endsWith(".exe");
  let codexArgs: string[] = [];
  if (native && readHelp) {
    try {
      if (readHelp(codexShim).includes("--no-daemon")) codexArgs = ["--no-daemon"];
    } catch { /* older installations keep the error-guided compatibility retry */ }
  }
  return { claudeExe, nodeExe, codexJs, ...(native ? { codexExe: codexShim } : {}), ...(codexArgs.length ? { codexArgs } : {}) };
}
