import { execFile, execFileSync } from "node:child_process";
import os from "node:os";
import { commandPtyCompatibility } from "../process/commandPty";
import path from "node:path";
import * as pty from "node-pty";
import { createCursorUsageReader, cursorUsageQuota } from "../process/cursorUsage";
import { connectTarget, sshKeyTools } from "../ssh/connect";
import { createSshManager } from "../ssh/manager";
import { createSshStore } from "../ssh/store";
import { dpapiBox } from "../settings/secrets";
import type { ProcessInfo } from "../process/occupancy";
import { createCursorComposer } from "../process/cursorComposer";
import { createDesktopComposer } from "../process/desktopComposer";
import { terminalElevation } from "../process/terminalPrivilege";
import { claudeChildEnv, claudeHostAuthForLaunch, claudeHostSignedIn, claudeInboxForSession, readClaudeSettingsEnv } from "../process/hostAuth";
import { queueCodexMessage } from "../process/codexQueue";
import { moveToRecycleBin } from "../process/recycleBin";
import { createHiddenSessions } from "../settings/hiddenSessions";
import { createCursorChat, resolveCursorAgent, startCursorRun } from "../process/cursorAgent";
import { createDeepseekApp } from "../process/deepseekApp";
import { deepseekExeFrom, readDeepseekKey, resolveDeepseek, startDeepseekRun, type DeepseekBins } from "../process/deepseekAgent";
import { createWorkstationLock } from "../process/workstationLock";
import { resolveBins, terminalEnv } from "../process/launch";
import { createSupervisor } from "../process/supervisor";
import { createTunnel, loadRemoteServer } from "../remote/tunnel";
import { createSettingsStore, detectTools } from "../settings/toolSettings";
import { claudeUsageQuota, readStatusLineQuota } from "../catalog/quotas";
import { desktopUsageQuota } from "../catalog/claudeDesktopUsage";
import { claudeDesktopSession, claudeHostSession } from "../catalog/archive";
import { codexDesktopSession } from "../catalog/codexDesktop";
import { resolveClaudeDataDir } from "../catalog/claudeData";
import { resolveConnectionMode } from "../settings/connectionMode";
import { createApp, listenLocal, type PageServer } from "./app";
import { createCommandTasks } from "../tasks/commandTasks";
import { createWorkflowEngine } from "../workflow/engine";
import { supervisorAi } from "../workflow/aiBridge";
import { createModelStore } from "../models/modelStore";
import { verifyWindowsLogin } from "./windowsLogin";
import { createPreview, htmlFileAt, htmlFilesIn, listeningPorts, localPreviewOrigin } from "./preview";

const PROCESS_QUERY = [
  "-NoProfile",
  "-Command",
  "$windows = @{}; Get-Process | Where-Object MainWindowTitle | ForEach-Object { $windows[$_.Id] = $_.MainWindowTitle }; Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine,Name,@{Name='WindowTitle';Expression={$windows[[int]$_.ProcessId]}} | ConvertTo-Json -Compress",
];
const PROCESS_TTL_MS = 1500;

let processCache: { at: number; rows: ProcessInfo[] } = { at: 0, rows: [] };
let processQueryRunning = false;

function keepProcesses(output: string) {
  type ProcessRow = { ProcessId: number; ParentProcessId: number; CommandLine: string | null; Name?: string; WindowTitle?: string };
  const parsed = JSON.parse(output) as ProcessRow | ProcessRow[];
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  processCache = {
    at: Date.now(),
    rows: rows.map((row) => ({
      pid: row.ProcessId,
      parentPid: row.ParentProcessId,
      commandLine: row.CommandLine ?? "",
      name: row.Name,
      windowTitle: row.WindowTitle,
    })),
  };
}

/**
 * The process list takes a few hundred milliseconds to read. Asking for it never waits: the last list is
 * returned at once and a fresh one is fetched in the background, so the server keeps answering meanwhile.
 */
function listProcesses(): ProcessInfo[] {
  if (Date.now() - processCache.at >= PROCESS_TTL_MS && !processQueryRunning) {
    processQueryRunning = true;
    execFile("powershell.exe", PROCESS_QUERY, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      processQueryRunning = false;
      try {
        if (!error) keepProcesses(stdout);
      } catch {
        /* keep the previous list */
      }
      // A failed read is not retried in a tight loop either.
      if (Date.now() - processCache.at >= PROCESS_TTL_MS) processCache = { ...processCache, at: Date.now() };
    });
  }
  return processCache.rows;
}

// The first list is read before the server starts answering, so nothing is decided on an empty one.
try {
  keepProcesses(execFileSync("powershell.exe", PROCESS_QUERY, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, windowsHide: true }));
} catch {
  /* the background refresh will try again */
}

const home = os.homedir();
const connectionMode = resolveConnectionMode(path.join(home, ".mirrormix", "connection-mode.json"));
const desktopOnly = connectionMode === "desktop";
const roots = {
  claudeProjectsDir: process.env.AIMISS_CLAUDE_ROOT || path.join(home, ".claude", "projects"),
  codexSessionsDir: process.env.AIMISS_CODEX_ROOT || path.join(home, ".codex", "sessions"),
  claudeDataDir: resolveClaudeDataDir(),
  cursorStateDb: process.env.AIMISS_CURSOR_DB || path.join(process.env.APPDATA || "", "Cursor", "User", "globalStorage", "state.vscdb"),
  cursorProjectsDir: process.env.AIMISS_CURSOR_PROJECTS || path.join(home, ".cursor", "projects"),
  deepseekSessionsDir: process.env.AIMISS_DEEPSEEK_ROOT || path.join(home, ".dsh", "sessions"),
  hiddenSessionsFile: path.join(home, ".mirrormix", "deleted-sessions.json"),
};
const cursorBins = resolveCursorAgent(process.env.AIMISS_CURSOR_AGENT || path.join(process.env.LOCALAPPDATA || "", "cursor-agent"));
// Cursor's monthly usage, from the CLI's own /usage panel (it signs in with its own login). Off in desktop-only mode,
// which starts no CLI.
const cursorUsage =
  cursorBins && !desktopOnly
    ? createCursorUsageReader({
        bins: cursorBins,
        usageDir: path.join(home, ".mirrormix", "cursor-usage"),
        chatsDir: path.join(home, ".cursor", "chats"),
        cacheFile: path.join(home, ".mirrormix", "cursor-usage.json"),
        spawn: (file, args, cwd) => {
          const terminal = pty.spawn(file, args, { name: "xterm-256color", cols: 110, rows: 40, cwd, env: process.env as Record<string, string>, useConptyDll: process.platform === "win32" });
          return {
            write: (data) => terminal.write(data),
            kill: () => terminal.kill(),
            onData: (callback) => void terminal.onData(callback),
            onExit: (callback) => void terminal.onExit(() => callback()),
          };
        },
      })
    : null;

let deepseekFound: DeepseekBins | null | undefined;
function deepseekBins(): DeepseekBins | null {
  if (deepseekFound) return deepseekFound;
  const running = listProcesses().map((item) => deepseekExeFrom(item.commandLine ?? "")).find(Boolean);
  deepseekFound = resolveDeepseek(process.env.AIMISS_DEEPSEEK_HOME, running);
  return deepseekFound;
}

function where(name: string): string | null {
  try {
    // where.exe's own "not found" goes to stderr in the console's code page; a missing CLI is reported below instead.
    return execFileSync("where.exe", [name], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] })
      .split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? null;
  } catch { return null; }
}
// Desktop mode neither requires CLI installs nor reads their authentication.
const bins = desktopOnly ? { claudeExe: "", nodeExe: "", codexJs: "" } : resolveBins(where, process.execPath, file =>
  execFileSync(file, ["--help"], { encoding: "utf8", windowsHide: true, timeout: 10_000 }));
if (!desktopOnly) {
  if (!bins.claudeExe) console.warn("[setup] Claude Code 命令行没找到（npm install -g @anthropic-ai/claude-code）。桌面版和其他功能照常可用。");
  if (!bins.codexJs && !("codexExe" in bins && bins.codexExe)) console.warn("[setup] Codex 命令行没找到（npm install -g @openai/codex）。桌面版和其他功能照常可用。");
}

function plainEnv(): Record<string, string> {
  return terminalEnv(process.env);
}

const desktop = createDesktopComposer("claude", path.join(home, ".mirrormix", "claude-desktop-usage.json"));
const codexDesktop = createDesktopComposer("codex");
const cursorDesktop = createCursorComposer();
const workstation = createWorkstationLock();
const supervisor = createSupervisor({
  bins,
  desktopOnly,
  roots,
  listProcesses,
  // Deleting from the page: files only the CLI uses go to the Recycle Bin; an app's sessions just leave the list.
  hidden: createHiddenSessions(path.join(home, ".mirrormix", "hidden-sessions.json")),
  // Sessions created from the page; only these show a delete button.
  madeHere: createHiddenSessions(path.join(home, ".mirrormix", "created-sessions.json")),
  trash: moveToRecycleBin,
  submitDesktop: (title, text) => desktop.submit(title, text),
  claudeSignedIn: () => claudeHostSignedIn(),
  stopDesktop: (title) => desktop.stop(title),
  stopCodex: (title, id) => codexDesktop.stop(title, id),
  // A session made on the web starts in the Claude app when it is open, so the app lists it as well.
  createDesktop: desktopOnly ? undefined : (folder, text) => desktop.create(folder, text),
  desktopCanCreate: async () => detectTools(listProcesses()).claude.running && !(await workstation.locked()),
  findClaudeInbox: (id, skipPids) => claudeInboxForSession(id, skipPids, Date.now(), claudeHostSession(roots.claudeDataDir, id) ?? ""),
  // A Codex thread open in the Codex app gets its messages there; without the app (or while the screen is locked)
  // MirrorMix's own Codex takes them, except in desktop-only mode, which never starts one.
  submitCodex: (title, text, id) => codexDesktop.submit(title, text, id),
  // Outside desktop-only mode a thread counts as the app's only while the app is open; otherwise MirrorMix runs it.
  codexDesktopSession: (id) =>
    desktopOnly || detectTools(listProcesses()).codex.running ? codexDesktopSession(roots.codexSessionsDir, id) : null,
  desktopSession: (id) => claudeDesktopSession(roots.claudeDataDir, id),
  readDesktopStream: (title) => desktop.read(title),
  // Questions the app windows ask in a conversation (allow, approve, pick), read off the window and answered there.
  readWindowPrompt: (tool, title) =>
    tool === "claude" ? desktop.prompt(title) : tool === "codex" ? codexDesktop.prompt(title) : tool === "cursor" ? cursorDesktop.prompt(title) : null,
  answerWindowPrompt: (tool, title, label, id) =>
    tool === "claude"
      ? desktop.answer(title, label)
      : tool === "codex"
        ? codexDesktop.answer(title, label, id)
        : tool === "cursor"
          ? cursorDesktop.answer(title, label)
          : Promise.reject(new Error("no_option")),
  // The status line or the desktop panel's five-hour window first. Without a current five-hour reading, the app's
  // own meter (usually the weekly limit, labelled 本周) still shows, rather than no quota at all.
  claudeUsage: () => {
    const fromStatusLine = readStatusLineQuota(path.join(home, ".mirrormix", "claude-usage.json"));
    if (!detectTools(listProcesses()).claude.running) return fromStatusLine;
    const usage = desktop.usage();
    // The app's usage button names its fullest window and is read live; when that is the 5-hour one it is newer
    // than a panel reading taken at the last lock.
    const meter = claudeUsageQuota(usage.meter);
    const liveFiveHour = meter?.label.startsWith("5小时") ? meter : null;
    return fromStatusLine ?? liveFiveHour ?? desktopUsageQuota(usage) ?? meter;
  },
  submitCursor: (title, text) => cursorDesktop.submit(title, text),
  submitCursorNow: (title, text) => cursorDesktop.submitNow(title, text),
  cursorUsage: () => cursorUsageQuota(cursorUsage?.current() ?? null),
  disposeExtra: () => {
    cursorUsage?.dispose();
    desktop.dispose();
    codexDesktop.dispose();
    cursorDesktop.dispose();
    workstation.dispose();
  },
  createCursorChat: cursorBins ? (cwd) => createCursorChat(cursorBins, cwd) : undefined,
  startCursor: cursorBins
    ? (id, cwd, text, onExit) => startCursorRun(cursorBins, id, cwd, text, onExit)
    : undefined,
  // While the app is open, messages go into it through its own local server, like typing into its window.
  deepseekApp: createDeepseekApp({
    credentialsFile: path.join(process.env.DSH_HOME || path.join(home, ".dsh"), ".credentials.yaml"),
    listProcesses,
  }),
  // Found when first needed: the running app tells where it is installed.
  startDeepseek: (cwd, text, sessionId, onExit) => {
    const found = deepseekBins();
    if (!found) throw new Error("DeepSeek Harness is not installed");
    const key = readDeepseekKey(path.join(process.env.DSH_HOME || path.join(home, ".dsh"), ".credentials.yaml"));
    return startDeepseekRun(found, cwd, text, sessionId, onExit, key);
  },
  workstationLocked: () => workstation.locked(),
  queueCodex: (id, cwd, text) => queueCodexMessage(bins, id, cwd, text),
  spawn(spec) {
    if (desktopOnly) throw new Error("Desktop mode does not launch agent CLIs");
    const terminal = pty.spawn(spec.file, spec.args, {
      name: "xterm-256color", useConptyDll: process.platform === "win32",
      cols: spec.cols, rows: spec.rows, cwd: spec.cwd,
      env: spec.file === bins.claudeExe ? terminalEnv(claudeChildEnv(process.env, readClaudeSettingsEnv(), claudeHostAuthForLaunch())) : plainEnv(),
    });
    return {
      pid: terminal.pid,
      write: (data: string) => terminal.write(data),
      resize: (cols: number, rows: number) => terminal.resize(cols, rows),
      kill: () => terminal.kill(),
      onData: (callback: (data: string) => void) => { terminal.onData(callback); },
      onExit: (callback: (code: number) => void) => { terminal.onExit(({ exitCode }) => callback(exitCode)); },
    };
  },
});

const port = Number(process.env.AIMISS_PORT ?? 4789);
// Pages running on this PC (a dev server) are shown through this second listener, at the root of their own address.
const previewPort = Number(process.env.AIMISS_PREVIEW_PORT ?? port + 1);
const preview = createPreview({ port: previewPort, blocked: [port, previewPort] });
const settings = createSettingsStore(process.env.AIMISS_SETTINGS || path.join(home, ".mirrormix", "settings.json"), listProcesses);
// Reaching this PC from outside through your own server, switched on in Settings.
const remoteConfigFile = path.resolve(process.env.MIRRORMIX_CONFIG || "mirrormix.config.json");
const remoteServer = loadRemoteServer(remoteConfigFile);
for (const problem of remoteServer.problems) console.warn(`[config] ${problem}`);
const remote = createTunnel({
  dir: path.join(home, ".mirrormix"),
  localPort: port,
  server: remoteServer.server,
  configFile: remoteConfigFile,
  bundledFrpc: path.resolve("frpc.exe"),
  previewPort,
});
// `npm run dev`: the page comes from Vite and reloads itself on edits; the server restarts on its own edits.
const dev = process.argv.includes("--dev");
let devPages: PageServer["handle"] | null = null;
const pages: PageServer | undefined = dev
  ? {
      handle(request, response) {
        if (devPages) return devPages(request, response);
        response.writeHead(503, { "content-type": "text/plain; charset=utf-8", "retry-after": "1" });
        response.end("MirrorMix is starting");
      },
      ownsUpgrade: (request) => request.headers["sec-websocket-protocol"] === "vite-hmr",
    }
  : undefined;
// The SSH plugin: hosts, keychain and known hosts in ~/.mirrormix/ssh.json, secrets sealed with DPAPI.
// 模型管理: models reached by API (DeepSeek, 通义千问…), keys sealed with DPAPI like the SSH secrets.
const modelStore = createModelStore(path.join(home, ".mirrormix", "models.json"), dpapiBox());
const sshStore = createSshStore(path.join(home, ".mirrormix", "ssh.json"), dpapiBox(), sshKeyTools);
const sshPlugin = { store: sshStore, manager: createSshManager(sshStore, (target) => connectTarget(target, sshStore)) };
const server = createApp(supervisor, settings, {
  verify: verifyWindowsLogin,
  sessionFile: process.env.AIMISS_LOGIN_SESSIONS || path.join(home, ".mirrormix", "login-sessions.json"),
}, {
  elevated: terminalElevation(),
  windowsPty: commandPtyCompatibility().windowsPty,
  open(cwd, cols, rows) {
    const terminal = pty.spawn(process.env.ComSpec || "cmd.exe", [], {
      name: "xterm-256color",
      useConptyDll: commandPtyCompatibility().useConptyDll,
      cols,
      rows,
      cwd,
      env: plainEnv(),
    });
    return {
      pid: terminal.pid,
      write(data) {
        terminal.write(data);
      },
      resize(nextCols, nextRows) {
        terminal.resize(nextCols, nextRows);
      },
      kill() {
        terminal.kill();
      },
      onData(callback) {
        terminal.onData(callback);
      },
      onExit(callback) {
        terminal.onExit(() => callback());
      },
    };
  },
}, remote, {
  allowed: preview.allowed,
  issue: preview.issue,
  ports: () => listeningPorts([port, previewPort]),
  htmlFiles: (root) => htmlFilesIn(root),
  htmlFile: (root, relative) => htmlFileAt(root, relative),
  origin: (throughTunnel, target) => (throughTunnel ? remote.previewOrigin() : localPreviewOrigin(previewPort, target)),
}, pages, undefined, undefined, createCommandTasks(path.join(home, ".mirrormix")), undefined, sshPlugin,
  createWorkflowEngine({
    dir: path.join(home, ".mirrormix"),
    ai: supervisorAi(supervisor),
    model: ({ modelId, system, prompt, json, timeoutMs, signal }) =>
      modelStore.chat(modelId, [...(system ? [{ role: "system" as const, content: system }] : []), { role: "user", content: prompt }], { json, timeoutMs, signal }),
  }), modelStore);
if (dev) {
  const { createServer } = await import("vite");
  const { default: react } = await import("@vitejs/plugin-react");
  const clientDir = path.resolve("client");
  const vite = await createServer({
    // Not vite.config.ts: loading it from here would make the server watcher restart on Vite's temporary copy.
    configFile: false,
    root: clientDir,
    plugins: [react()],
    appType: "spa",
    clearScreen: false,
    server: {
      middlewareMode: true,
      hmr: { server },
      // Through the tunnel the page is asked for as <subdomain>.<domain>; Vite refuses hosts it does not know.
      allowedHosts: remoteServer.server.domain ? [`.${remoteServer.server.domain}`] : [],
      // The page is reachable from outside through the tunnel: only the client and its packages, never the
      // project's own files such as mirrormix.config.json.
      fs: { strict: true, allow: [clientDir, path.resolve("node_modules")] },
    },
  });
  devPages = (request, response) =>
    vite.middlewares(request, response, () => {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found");
    });
  console.log("[dev] page served by Vite with hot reload");
}
// Reading every transcript for the first time takes several seconds. Doing it here means the first
// page load, session open and message do not each pay for it.
try {
  supervisor.catalog();
} catch {
  /* the first request will read whatever could not be read now */
}
await listenLocal(server, port);
console.log(`MirrorMix listening on http://127.0.0.1:${port}`);
try {
  await preview.listen("127.0.0.1");
} catch {
  // Without it everything else still works; only the browser button cannot show local pages.
  console.warn(`[preview] port ${previewPort} is taken; set AIMISS_PREVIEW_PORT to use another one`);
}
console.log(`Connection mode: ${connectionMode}`);

process.on("SIGINT", () => {
  preview.server.close();
  remote.dispose();
  supervisor.dispose();
  server.close();
});
process.on("SIGTERM", () => {
  preview.server.close();
  remote.dispose();
  supervisor.dispose();
  server.close();
});
