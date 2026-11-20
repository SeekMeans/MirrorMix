import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * DeepSeek Harness's own command line, as its `dsh.cmd` starts it: the app's executable run as Node, with the
 * desktop host's cli.js. `dsh headless` answers one task and exits; `--session-id` continues a saved session.
 */
export interface DeepseekBins {
  exe: string;
  cli: string;
}

const CLI = path.join("resources", "app.asar", "dsh", "node_modules", "@deepseek-ai", "dsh-desktop-host", "lib", "cli.js");

function fromInstall(dir: string): DeepseekBins | null {
  const exe = path.join(dir, "DeepSeek Harness.exe");
  // cli.js sits inside app.asar, which only the app's own executable can read; the archive itself must exist.
  if (!existsSync(exe) || !existsSync(path.join(dir, "resources", "app.asar"))) return null;
  return { exe, cli: path.join(dir, CLI) };
}

/** The install folder: as given, else where the running app lives, else the usual places. */
export function resolveDeepseek(given: string | undefined, runningExe?: string): DeepseekBins | null {
  const candidates = [
    given,
    runningExe ? path.dirname(runningExe) : undefined,
    path.join(process.env.LOCALAPPDATA || "", "Programs", "DeepSeek Harness"),
    path.join(process.env.ProgramFiles || "C:\\Program Files", "DeepSeek Harness"),
    "D:\\Programs\\DeepSeek Harness",
  ];
  for (const dir of candidates) {
    if (!dir) continue;
    const found = fromInstall(dir);
    if (found) return found;
  }
  return null;
}

/** The path of the running app's main executable, from a process command line. */
export function deepseekExeFrom(commandLine: string): string | undefined {
  const match = commandLine.match(/^"?([^"]*[\\/]DeepSeek Harness\.exe)"?/i);
  return match?.[1];
}

/**
 * The API key the DeepSeek Harness app saved (`refs.DEEPSEEK_API_KEY` in `~/.dsh/.credentials.yaml`). Its headless
 * mode does not read that store, so the key is handed to each run in its environment. It is never logged or sent
 * anywhere else. Read on every run, so a key changed in the app is used at once.
 */
export function readDeepseekKey(credentialsFile: string): string {
  let text: string;
  try {
    text = readFileSync(credentialsFile, "utf8");
  } catch {
    return "";
  }
  let inRefs = false;
  for (const raw of text.split(/\r?\n/)) {
    if (/^\S/.test(raw)) inRefs = /^refs:\s*$/.test(raw);
    if (!inRefs) continue;
    const match = raw.match(/^\s+DEEPSEEK_API_KEY:\s*(.*?)\s*$/);
    if (!match) continue;
    const value = match[1].replace(/^(["'])(.*)\1$/, "$2");
    return /^[\x21-\x7e]+$/.test(value) ? value : "";
  }
  return "";
}

export interface DeepseekRunResult {
  code: number;
  /** Why the run failed, from its final event or the tail of its error output. */
  error?: string;
  /** The tool's error code (`MISSING_CREDENTIAL`, `AUTH`…), when it gave one. */
  errorCode?: string;
}

export interface DeepseekRun {
  kill: () => void;
  /** The session the run is answering in, once the tool has said (at once for a new one). */
  session: Promise<string>;
}

/**
 * One reply in the background. The message goes in on stdin, so no quoting can change it. `sessionId` continues that
 * session; without it the tool makes a new one in `cwd`. The page reads the session file, not this output.
 */
export function startDeepseekRun(
  bins: DeepseekBins,
  cwd: string,
  text: string,
  sessionId: string | undefined,
  onExit: (result: DeepseekRunResult) => void,
  /** The key for this run; a DEEPSEEK_API_KEY already in MirrorMix's environment wins. */
  apiKey = "",
): DeepseekRun {
  const args = ["--expose-internals", bins.cli, "headless", "--json", ...(sessionId ? ["--session-id", sessionId] : []), "-"];
  const child: ChildProcess = spawn(bins.exe, args, {
    cwd,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      ...(apiKey && !process.env.DEEPSEEK_API_KEY ? { DEEPSEEK_API_KEY: apiKey } : {}),
    },
  });
  let resolveSession: (id: string) => void = () => {};
  let rejectSession: (error: Error) => void = () => {};
  const session = new Promise<string>((resolve, reject) => {
    resolveSession = resolve;
    rejectSession = reject;
  });
  session.catch(() => {});
  if (sessionId) resolveSession(sessionId);

  let pending = "";
  let error = "";
  let errorCode = "";
  let stderr = "";
  const onLine = (line: string) => {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (event.type === "session" && typeof event.sessionId === "string") resolveSession(event.sessionId);
    if (event.type === "final") {
      const reason = event.reason as { kind?: string; error?: { message?: string; code?: string } } | undefined;
      if (reason?.kind === "error") {
        error = reason.error?.message ?? "";
        errorCode = reason.error?.code ?? "";
      }
    }
  };
  child.stdout?.on("data", (chunk: Buffer) => {
    pending += chunk.toString("utf8");
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) onLine(line);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-4_000);
  });
  child.on("error", (failure) => {
    rejectSession(failure);
    onExit({ code: 1, error: failure.message });
  });
  child.on("exit", (code) => {
    if (pending.trim()) onLine(pending);
    if (!errorCode) errorCode = stderr.match(/dsh: ([A-Z_]+):/)?.[1] ?? "";
    rejectSession(new Error(error || stderr.trim().slice(-400) || "no session"));
    const failed = (code ?? 1) !== 0 || Boolean(error);
    onExit({ code: failed ? code || 1 : 0, ...(failed ? { error: error || stderr.trim().slice(-400), errorCode } : {}) });
  });
  child.stdin?.end(text, "utf8");
  return {
    kill() {
      child.kill();
    },
    session,
  };
}
