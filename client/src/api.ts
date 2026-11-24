export type ToolId = "claude" | "codex" | "cursor" | "deepseek";

export const ALL_TOOLS: ToolId[] = ["claude", "codex", "cursor", "deepseek"];

/** Which tools the person chose to show, and whether each one's app is open on this machine. */
export interface ToolPrefs {
  tools: ToolId[];
  /** Sessions pinned inside MirrorMix (`tool:id`); the tools' own pins are separate and never changed. */
  pinned?: string[];
  status: Record<ToolId, { running: boolean }>;
  /** This computer's name. */
  host: string;
  capabilities?: { create: Record<ToolId, boolean> };
}

export type SessionStatus =
  | "idle"
  | "starting"
  | "running"
  | "occupied"
  | "exited"
  | "failed"
  | "create_failed";

export interface DiffLine {
  kind: "+" | "-" | " " | "…";
  no?: number;
  text: string;
}

export interface StepResult {
  status: "running" | "ok" | "error";
  summary?: string;
  lines?: string[];
  more?: number;
  diff?: DiffLine[];
  todos?: Array<{ text: string; status: "pending" | "in_progress" | "completed" }>;
}

/**
 * step: a tool call, `tool(text)` with its result. thinking: visible reasoning.
 * turn: closes a round with its timing and output tokens; no `endedAt` means still running.
 */
export interface TranscriptMessage {
  id: string;
  role: "user" | "assistant" | "step" | "thinking" | "turn";
  text: string;
  tool?: string;
  server?: string;
  result?: StepResult;
  startedAt?: string;
  endedAt?: string;
  tokens?: number;
  /** On a turn: closed because its last tool call went past its own time limit with no result and no other record. */
  stalled?: { tool: string; limitMs: number };
}

export interface SessionSummary {
  tool: ToolId;
  id: string;
  title: string;
  updatedAt: string;
  status: SessionStatus;
  pinned: boolean;
  /** The latest reply has not finished. */
  working: boolean;
  /** The reply finished and the AI tool still marks it unseen. */
  unseen: boolean;
  /** The reply waits on the person: a permission, a plan or a question. */
  asking?: boolean;
}

/** Something the AI tool stopped to ask: allow a command or an edit, approve a plan, pick an answer. */
export interface ToolPrompt {
  id: string;
  kind: "permission" | "question" | "plan" | "trust";
  title: string;
  detail?: string;
  header?: string;
  options: Array<{ id: string; label: string; description?: string; tone?: "yes" | "no" }>;
  via: "terminal" | "window";
  /** Only shown here; it is answered in the tool itself. */
  readOnly?: boolean;
}

export interface WorkspaceGroup {
  path: string;
  projectName?: string;
  pinned?: boolean;
  /** Shown instead of the folder name, for groups that are not a folder in the tool's own list. */
  label?: string;
  missing: boolean;
  sessions: SessionSummary[];
}

export interface ToolQuota {
  label: string;
  title: string;
  level: "ok" | "high" | "full";
  /** Share of the 5-hour window used, 0–100; absent or null when the tool does not say. */
  percent?: number | null;
  /** Unix milliseconds when the window resets; absent when not known. */
  resetsAt?: number | null;
  /** When only the day is known (Cursor's month: "11月19日重置"), shown in place of a countdown. */
  resetLabel?: string;
}

export interface Catalog {
  claude: WorkspaceGroup[];
  codex: WorkspaceGroup[];
  cursor: WorkspaceGroup[];
  deepseek: WorkspaceGroup[];
  /** Absent until the desk process that serves this page has the quota reader. */
  quotas?: {
    claude?: ToolQuota | null;
    codex?: ToolQuota | null;
    cursor?: ToolQuota | null;
    deepseek?: ToolQuota | null;
  };
}

export interface ScheduleJob {
  tool: ToolId;
  id: string;
  name: string;
  kind: string;
  status: string;
  cadence: string;
  prompt: string;
  location: string;
  updatedAt: string;
}

export interface SessionView {
  id: string;
  tool: ToolId;
  title: string;
  workspacePath: string;
  status: SessionStatus;
  sendEnabled: boolean;
  attached: "process" | "claude" | "desktop";
  /** The desktop app could not take a message, so MirrorMix resumed the session in its own Claude Code. */
  takenOver?: boolean;
  /** The terminal is asking whether to trust the session folder. */
  question?: "trust";
  /** What the tool is waiting on the person for. */
  prompt?: ToolPrompt;
  /** What the process printed before it stopped, when it stopped almost at once. */
  exitNote?: string;
  inputPrompt?: string;
  readOnlyReason?: string;
  /** The model the session is on, as the tool names it (`claude-opus-5-5`). */
  model?: string;
  /** Codex's reasoning effort. */
  effort?: string;
  /** The page can switch the model by sending `/model <name>`. */
  modelSwitch?: boolean;
  /** Created from this page, so it can be deleted here. Sessions the AI tools made themselves cannot. */
  deletable?: boolean;
  messages: TranscriptMessage[];
}

/** A page of a transcript: `messages[0]` sits at `offset` in a transcript of `total` messages. */
export interface SessionWindow extends SessionView {
  total: number;
  offset: number;
}

export interface LiveFrame extends SessionWindow {
  type: "snapshot" | "patch";
}

/** Reaching this PC from outside through your own server. Mirrors the server's RemoteConfig. */
export interface RemoteConfig {
  enabled: boolean;
  subdomain: string;
}

export interface RemoteView extends RemoteConfig {
  /** The shared server, from mirrormix.config.json: every PC is <subdomain>.<domain> on port 443. */
  server: string;
  serverPort: number;
  domain: string;
  configFile: string;
  hasToken: boolean;
  /** `retryAt`: when the server tries again by itself (ms since 1970), while it is not connected. */
  status: { state: "off" | "starting" | "connected" | "error"; message: string; url: string; retryAt?: number };
}

export const AUTH_EXPIRED = "mirrormix:auth-expired";

/**
 * The last time the person touched the page. Each request tells the server how long ago that was, and only recent
 * use extends the sign-in: a tab left open keeps polling, but signs out 15 hours after it was last used.
 */
let lastInput = Date.now();
if (typeof window !== "undefined") {
  const touched = () => {
    lastInput = Date.now();
  };
  for (const kind of ["pointerdown", "keydown", "wheel", "touchstart"]) window.addEventListener(kind, touched, { capture: true, passive: true });
}

/** All protected HTTP endpoints return to the login screen when the server forgets a session. */
async function authenticatedFetch(url: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("x-mirrormix-idle", String(Math.max(0, Math.round((Date.now() - lastInput) / 1000))));
  const response = await fetch(url, { ...init, headers });
  if (response.status === 401 && typeof window !== "undefined") window.dispatchEvent(new Event(AUTH_EXPIRED));
  return response;
}

/** For plugin pages with endpoints of their own (SSH): the same sign-in handling and error shape as `api`. */
export { authenticatedFetch as apiFetch, request as apiRequest };

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await authenticatedFetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    const error = new Error(body.error ?? "failed") as Error & { code?: string; status?: number };
    error.code = body.error;
    error.status = response.status;
    throw error;
  }
  return body;
}

let catalogText = "";
let catalogValue: Catalog | null = null;

/** Returns the same object while the server's answer is unchanged, so polling does not re-render the list. */
async function catalog(): Promise<Catalog> {
  const response = await authenticatedFetch("/api/catalog");
  if (!response.ok) throw new Error("failed");
  const text = await response.text();
  if (catalogValue && text === catalogText) return catalogValue;
  catalogText = text;
  catalogValue = JSON.parse(text) as Catalog;
  return catalogValue;
}

export function liveUrl(path: "live" | "terminal" | "cmd", tool: ToolId, id: string, tid?: string): string {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const extra = tid ? `&tid=${encodeURIComponent(tid)}` : "";
  return `${protocol}://${location.host}/api/${path}?tool=${tool}&id=${encodeURIComponent(id)}${extra}`;
}

/** One row of the file browser. */
export interface FolderEntry {
  name: string;
  dir: boolean;
  size: number;
  mtime: number;
}

/** An entry of the "/" menu in the message box. */
export interface SlashCommand {
  name: string;
  description: string;
  source: "builtin" | "user" | "project" | "skill";
}

/** An HTML file in a session folder, newest first. `path` is relative to that folder. */
export interface HtmlFile {
  path: string;
  title?: string;
  size: number;
  modifiedAt: string;
}

/** What to preview: a dev server's port, a file in the session folder, or an HTML file anywhere by its full path. */
/** What the preview menu shows for one project folder. Null picks: nothing chosen yet, the menu asks first. */
export interface PreviewPicks {
  files: string[];
  ports: Array<{ port: number; name?: string }>;
  updatedAt: string;
}

export interface PreviewPickView {
  root: string;
  picks: PreviewPicks | null;
  /** The picked files as they are now; `missing` when one was moved or deleted. */
  files: Array<HtmlFile | { path: string; missing: true }>;
}

export type PreviewRequest = { port: number } | { tool: ToolId; id: string; file: string } | { path: string };

/** Something listening on this PC that looks like a web server. */
export interface ListeningPort {
  port: number;
  name: string;
}

/** A command line kept running on this PC for one session. */
export interface TerminalInfo {
  tid: string;
  label: string;
  createdAt: string;
  /** A tab opened for one of the project's services: its name. */
  service?: string;
}
export type { ProjectService, ServiceView, ServiceList, ServiceAction } from "../../src/shared/projectServices";
import type { ProjectService, ServiceList, ServiceAction } from "../../src/shared/projectServices";
export type { TerminalProject } from "../../src/shared/terminalScope";
import type { TerminalProject } from "../../src/shared/terminalScope";
export interface TerminalList { project: TerminalProject; terminals: TerminalInfo[] }

let prefsText = "";
let prefsValue: ToolPrefs | null = null;

/** Same object while nothing changed, so the regular check does not re-render the page. */
function keepPrefs(text: string): ToolPrefs {
  if (prefsValue && text === prefsText) return prefsValue;
  prefsText = text;
  prefsValue = JSON.parse(text) as ToolPrefs;
  return prefsValue;
}

async function settings(): Promise<ToolPrefs> {
  const response = await authenticatedFetch("/api/settings");
  if (!response.ok) throw new Error("failed");
  return keepPrefs(await response.text());
}

async function saveSettings(change: { tools: ToolId[] } | { pinned: string[] }): Promise<ToolPrefs> {
  const response = await authenticatedFetch("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(change),
  });
  if (!response.ok) throw new Error("failed");
  return keepPrefs(await response.text());
}

export type { Shortcut, ShortcutLibrary } from "../../src/shared/shortcuts";
export type {
  Workflow,
  WorkflowStep,
  WorkflowCondition,
  WorkflowRun,
  RunSummary,
  StepRun,
  AiStep,
  ModelStep,
  CommandStep,
  IfStep,
  LoopStep,
} from "../../src/workflow/types";
import type { Workflow, WorkflowRun, RunSummary } from "../../src/workflow/types";
export type { ModelView } from "../../src/models/modelStore";
import type { ModelView } from "../../src/models/modelStore";
import type { Shortcut, ShortcutLibrary } from "../../src/shared/shortcuts";

/** A command kept in Settings. once: runs to the end. service: keeps running (a dev server) until stopped. */
export type TaskKind = "once" | "service";
export type TaskStatus = "idle" | "running" | "exited" | "failed" | "stopped";

export interface TaskDraft {
  name: string;
  cwd: string;
  command: string;
  kind: TaskKind;
}

export interface CommandTask extends TaskDraft {
  id: string;
  status: TaskStatus;
  pid?: number;
  startedAt?: string;
  endedAt?: string;
  /** Null when the process ended while MirrorMix was not watching it (it restarted in between). */
  exitCode?: number | null;
  /** Running only: TCP ports its processes listen on. Absent until they were looked up. */
  ports?: number[];
  /** Running only: it is the MirrorMix serving this page. */
  self?: boolean;
}

/** A file or picture added to a message, saved on this computer. The message names it by `path`. */
export interface Upload {
  path: string;
  name: string;
  size: number;
  image: boolean;
}

/** Sends the file itself as the body; its name goes in a header so any name survives. */
async function upload(file: Blob, name: string): Promise<Upload> {
  const response = await authenticatedFetch("/api/uploads", {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(name) },
    body: file,
  });
  const body = (await response.json().catch(() => ({}))) as Upload & { error?: string };
  if (!response.ok) {
    const error = new Error(body.error ?? "failed") as Error & { code?: string; status?: number };
    error.code = body.error ?? (response.status === 413 ? "too_large" : "upload_failed");
    error.status = response.status;
    throw error;
  }
  return body;
}

export const api = {
  upload,
  models: () => request<{ models: ModelView[] }>("/api/models"),
  saveModel: (model: Record<string, unknown>, id?: string) =>
    request<ModelView>(id ? `/api/models/${id}` : "/api/models", { method: id ? "PUT" : "POST", body: JSON.stringify(model) }),
  deleteModel: (id: string) => request<{ ok: true }>(`/api/models/${id}`, { method: "DELETE" }),
  testModel: (id: string) =>
    request<{ ok: true; reply: string; ms: number } | { ok: false; message: string; reply?: undefined; ms?: undefined }>(`/api/models/${id}/test`, { method: "POST" }),
  writeScript: (id: string, input: { kind: "linux" | "windows" | "python"; description: string; current?: string }) =>
    request<{ ok: true; label: string; command: string } | { ok: false; message: string }>(`/api/models/${id}/script`, { method: "POST", body: JSON.stringify(input) }),
  workflows: () => request<{ workflows: Workflow[] }>("/api/workflows"),
  saveWorkflow: (flow: Partial<Workflow>, id?: string) =>
    request<Workflow>(id ? `/api/workflows/${id}` : "/api/workflows", { method: id ? "PUT" : "POST", body: JSON.stringify(flow) }),
  deleteWorkflow: (id: string) => request<{ ok: true }>(`/api/workflows/${id}`, { method: "DELETE" }),
  runWorkflow: (id: string, input: string) => request<WorkflowRun>(`/api/workflows/${id}/run`, { method: "POST", body: JSON.stringify({ input }) }),
  workflowRuns: (id: string) => request<{ runs: RunSummary[] }>(`/api/workflows/${id}/runs`),
  workflowRun: (runId: string) => request<WorkflowRun>(`/api/workflows/runs/${runId}`),
  stopWorkflowRun: (runId: string) => request<WorkflowRun>(`/api/workflows/runs/${runId}/stop`, { method: "POST" }),
  commands: () => request<ShortcutLibrary>("/api/commands"),
  saveCommands: (commands: Shortcut[], revision: string) => request<ShortcutLibrary>("/api/commands", { method: "PUT", body: JSON.stringify({ commands, revision }) }),
  prepareCommand: (entry: Shortcut, revision: string, message?: string) => request<{ command: string }>("/api/commands/prepare", { method: "POST", body: JSON.stringify({ group: entry.group, name: entry.name, revision, message }) }),
  catalog,
  settings,
  saveSettings,
  schedules: () => request<ScheduleJob[]>("/api/schedules"),
  /** The plugins added from the plugin market. */
  plugins: () => request<{ installed: string[] }>("/api/plugins"),
  setPlugins: (installed: string[]) =>
    request<{ installed: string[] }>("/api/plugins", { method: "PUT", body: JSON.stringify({ installed }) }),
  remote: () => request<RemoteView>("/api/remote"),
  /** The saved connection token in plain text, for the eye button only. */
  remoteToken: () => request<{ token: string }>("/api/remote/token"),
  retryRemote: () => request<RemoteView>("/api/remote/retry", { method: "POST" }),
  saveRemote: (change: Partial<RemoteConfig> & { token?: string }) =>
    request<RemoteView>("/api/remote", { method: "PUT", body: JSON.stringify(change) }),
  page: (tool: ToolId, id: string, before: number, limit: number) =>
    request<SessionWindow>(`/api/sessions/${tool}/${encodeURIComponent(id)}?before=${before}&limit=${limit}`),
  latest: (tool: ToolId, id: string) =>
    request<SessionWindow>(`/api/sessions/${tool}/${encodeURIComponent(id)}`),
  open: (tool: ToolId, id: string) =>
    request<SessionWindow>("/api/sessions/open", { method: "POST", body: JSON.stringify({ tool, id }) }),
  create: (tool: ToolId, workspacePath: string) =>
    request<SessionWindow>("/api/sessions/create", { method: "POST", body: JSON.stringify({ tool, workspacePath }) }),
  close: (tool: ToolId, id: string) =>
    request<SessionWindow>("/api/sessions/close", { method: "POST", body: JSON.stringify({ tool, id }) }),
  /** "trash": the files went to the Recycle Bin. "hidden": an app keeps the session, so it only left this list. */
  deleteSession: (tool: ToolId, id: string) =>
    request<{ removed: "trash" | "hidden" }>("/api/sessions/delete", { method: "POST", body: JSON.stringify({ tool, id }) }),
  send: (tool: ToolId, id: string, text: string) =>
    request<{ ok: true }>("/api/sessions/send", { method: "POST", body: JSON.stringify({ tool, id, text }) }),
  previewPorts: () => request<{ ports: ListeningPort[] }>("/api/preview/ports"),
  files: (tool: ToolId, id: string, dir: string) =>
    request<{ root: string; dir: string; entries: FolderEntry[]; truncated: boolean }>(
      `/api/files?tool=${tool}&id=${encodeURIComponent(id)}&dir=${encodeURIComponent(dir)}`,
    ),
  /** A file of the session's folder, for an <img>, a download link, or reading as text. */
  fileUrl: (tool: ToolId, id: string, path: string, download = false) =>
    `/api/files/raw?tool=${tool}&id=${encodeURIComponent(id)}&path=${encodeURIComponent(path)}${download ? "&download=1" : ""}`,
  slashCommands: (tool: ToolId, id: string) =>
    request<{ commands: SlashCommand[] }>(`/api/slash?tool=${tool}&id=${encodeURIComponent(id)}`),
  previewFiles: (tool: ToolId, id: string) =>
    request<{ root: string; files: HtmlFile[] }>(`/api/preview/files?tool=${tool}&id=${encodeURIComponent(id)}`),
  previewPicks: (tool: ToolId, id: string) =>
    request<PreviewPickView>(`/api/preview/picks?tool=${tool}&id=${encodeURIComponent(id)}`),
  savePreviewPicks: (tool: ToolId, id: string, picks: { files: string[]; ports: Array<{ port: number; name?: string }> }) =>
    request<PreviewPickView>("/api/preview/picks", { method: "PUT", body: JSON.stringify({ tool, id, ...picks }) }),
  openPreview: (what: PreviewRequest) => request<{ url: string }>("/api/preview/open", { method: "POST", body: JSON.stringify(what) }),
  tasks: () => request<{ tasks: CommandTask[] }>("/api/tasks"),
  createTask: (draft: TaskDraft) => request<CommandTask>("/api/tasks", { method: "POST", body: JSON.stringify(draft) }),
  updateTask: (id: string, draft: TaskDraft) =>
    request<CommandTask>(`/api/tasks/${id}`, { method: "PUT", body: JSON.stringify(draft) }),
  deleteTask: (id: string) => request<{ ok: true }>(`/api/tasks/${id}`, { method: "DELETE" }),
  startTask: (id: string) => request<CommandTask>(`/api/tasks/${id}/start`, { method: "POST" }),
  stopTask: (id: string) => request<CommandTask>(`/api/tasks/${id}/stop`, { method: "POST" }),
  restartTask: (id: string) => request<CommandTask>(`/api/tasks/${id}/restart`, { method: "POST" }),
  taskLog: (id: string) => request<{ text: string; truncated: boolean }>(`/api/tasks/${id}/log`),
  terminals: (tool: ToolId, id: string) =>
    request<TerminalList>(`/api/cmd/list?tool=${tool}&id=${encodeURIComponent(id)}`),
  newTerminal: (tool: ToolId, id: string, ensure = false) =>
    request<TerminalList & { terminal: TerminalInfo }>("/api/cmd/new", { method: "POST", body: JSON.stringify({ tool, id, ensure }) }),
  closeTerminal: (tool: ToolId, id: string, tid: string) =>
    request<TerminalList>("/api/cmd/close", { method: "POST", body: JSON.stringify({ tool, id, tid }) }),
  services: (tool: ToolId, id: string) =>
    request<ServiceList>(`/api/services?tool=${tool}&id=${encodeURIComponent(id)}`),
  detectServices: (tool: ToolId, id: string) =>
    request<{ root: string; services: ProjectService[] }>(`/api/services/detect?tool=${tool}&id=${encodeURIComponent(id)}`),
  saveServices: (tool: ToolId, id: string, services: ProjectService[]) =>
    request<ServiceList>("/api/services", { method: "PUT", body: JSON.stringify({ tool, id, services }) }),
  /** No names: every service of the project. `focus` is the tab to show. */
  runServices: (tool: ToolId, id: string, action: ServiceAction, names: string[] = []) =>
    request<ServiceList & TerminalList & { focus?: string }>("/api/services/run", { method: "POST", body: JSON.stringify({ tool, id, action, names }) }),
  answer: (tool: ToolId, id: string, choice: "trust" | "cancel") =>
    request<SessionWindow>("/api/sessions/answer", { method: "POST", body: JSON.stringify({ tool, id, choice }) }),
  /** Answers what the tool asked (`SessionWindow.prompt`) with one of its options. */
  answerPrompt: (tool: ToolId, id: string, promptId: string, optionId: string) =>
    request<SessionWindow>("/api/sessions/prompt", { method: "POST", body: JSON.stringify({ tool, id, promptId, optionId }) }),
  /** Stops the reply under way: Esc in MirrorMix's own terminal, the Stop button in the desktop app. */
  interrupt: (tool: ToolId, id: string) =>
    request<{ ok: true }>("/api/sessions/interrupt", { method: "POST", body: JSON.stringify({ tool, id }) }),
  sendNow: (tool: ToolId, id: string, text: string) =>
    request<{ ok: true }>("/api/sessions/send-now", { method: "POST", body: JSON.stringify({ tool, id, text }) }),
};
