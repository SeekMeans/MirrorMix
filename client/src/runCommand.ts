/** A reply's "运行" button asks the conversation's command line to run a command; App opens it and passes it on. */
export const RUN_COMMAND = "mirrormix:run-command";

export interface RunRequest {
  /** Changes on every click, so running the same command twice runs it twice. */
  seq: number;
  command: string;
}

const SHELLS = new Set(["bash", "sh", "shell", "zsh", "console", "terminal", "cmd", "bat", "batch", "powershell", "pwsh", "ps", "ps1"]);

/**
 * The command a code block holds, if it is one: a block marked as a shell language. Prompts copied along
 * ("$ ", "> ", "PS C:\x> ") are dropped, and so are blank lines; each remaining line is typed in turn.
 */
export function commandOf(language: string, code: string): string | null {
  if (!SHELLS.has(language.toLowerCase())) return null;
  const lines = code
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/^\s*(?:PS [^>\n]*>|\$|>)\s+/, "").trimEnd())
    .filter((line) => line.trim());
  if (!lines.length || lines.join("\n").length > 4000) return null;
  return lines.join("\n");
}

let seq = 0;

export function requestRun(command: string) {
  window.dispatchEvent(new CustomEvent<RunRequest>(RUN_COMMAND, { detail: { seq: ++seq, command } }));
}
