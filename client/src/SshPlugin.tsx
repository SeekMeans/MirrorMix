import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import type {
  SftpEntry,
  SshAuth,
  SshGroup,
  SshHostInput,
  SshHostKeyQuestion,
  SshHostView,
  SshIdentityView,
  SshKeyView,
  SshSessionInfo,
  SshSnippet,
  SshState,
  SshTask,
  SshTaskRun,
} from "../../src/shared/ssh";
import { api, apiFetch, apiRequest, type ModelView } from "./api";
import { createPortal } from "react-dom";
import { Select, type SelectOption } from "./Select";
import { ChevronIcon, CloseIcon, EditIcon, FileIcon, FolderIcon, PlayIcon, PlusIcon, RefreshIcon, SearchIcon, ShieldQuestionIcon, Spinner, StopIcon, TrashIcon, UpIcon } from "./icons";

import { tr, uiLocale } from "./i18n";
// ---------------------------------------------------------------- server calls

type Fail = Error & { code?: string; status?: number; question?: SshHostKeyQuestion };

async function call<T>(url: string, method = "GET", payload?: unknown): Promise<T> {
  const response = await apiFetch(url, {
    method,
    headers: payload === undefined ? undefined : { "content-type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string; question?: SshHostKeyQuestion };
  if (!response.ok) {
    const error = new Error(body.error ?? "failed") as Fail;
    error.code = body.error;
    error.status = response.status;
    error.question = body.question;
    throw error;
  }
  return body;
}

const ssh = {
  state: () => call<SshState>("/api/ssh/state"),
  saveHost: (input: SshHostInput) => call<SshHostView>("/api/ssh/hosts", "POST", input),
  duplicateHost: (id: string) => call<SshHostView>("/api/ssh/hosts/duplicate", "POST", { id }),
  deleteHost: (id: string) => call(`/api/ssh/hosts?id=${encodeURIComponent(id)}`, "DELETE"),
  testHost: (id: string) => call("/api/ssh/hosts/test", "POST", { id }),
  importConfig: () => call<{ hosts: number; keys: number; skipped: string[] }>("/api/ssh/import-config", "POST", {}),
  saveGroup: (input: { id?: string; name: string; parentId?: string }) => call<SshGroup>("/api/ssh/groups", "POST", input),
  deleteGroup: (id: string) => call(`/api/ssh/groups?id=${encodeURIComponent(id)}`, "DELETE"),
  importKey: (input: { label: string; privateKey: string; passphrase?: string }) => call<SshKeyView>("/api/ssh/keys/import", "POST", input),
  generateKey: (input: { label: string; type: string; bits?: number; passphrase?: string }) => call<SshKeyView>("/api/ssh/keys/generate", "POST", input),
  renameKey: (id: string, label: string) => call<SshKeyView>("/api/ssh/keys/rename", "POST", { id, label }),
  deleteKey: (id: string) => call(`/api/ssh/keys?id=${encodeURIComponent(id)}`, "DELETE"),
  saveIdentity: (input: { id?: string; label: string; username: string; password?: string; keyId?: string }) =>
    call<SshIdentityView>("/api/ssh/identities", "POST", input),
  deleteIdentity: (id: string) => call(`/api/ssh/identities?id=${encodeURIComponent(id)}`, "DELETE"),
  saveSnippet: (input: Partial<SshSnippet>) => call<SshSnippet>("/api/ssh/snippets", "POST", input),
  deleteSnippet: (id: string) => call(`/api/ssh/snippets?id=${encodeURIComponent(id)}`, "DELETE"),
  saveTask: (input: Partial<SshTask>) => call<SshTask>("/api/ssh/tasks", "POST", input),
  deleteTask: (id: string) => call(`/api/ssh/tasks?id=${encodeURIComponent(id)}`, "DELETE"),
  runTask: (id: string) => call<SshTaskRun>("/api/ssh/tasks/run", "POST", { id }),
  taskRun: (id: string) => call<SshTaskRun>(`/api/ssh/tasks/run?id=${encodeURIComponent(id)}`),
  taskRuns: (taskId: string) => call<{ runs: SshTaskRun[] }>(`/api/ssh/tasks/runs?task=${encodeURIComponent(taskId)}`),
  stopTaskRun: (id: string) => call<SshTaskRun>("/api/ssh/tasks/stop", "POST", { id }),
  trust: (question: SshHostKeyQuestion) => call("/api/ssh/known", "POST", question),
  openSession: (hostId: string) => call<SshSessionInfo>("/api/ssh/sessions", "POST", { hostId }),
  closeSession: (tid: string) => call(`/api/ssh/sessions?tid=${encodeURIComponent(tid)}`, "DELETE"),
  runSnippet: (tid: string, snippetId: string) => call("/api/ssh/sessions/snippet", "POST", { tid, snippetId }),
  sftpHome: (host: string) => call<{ path: string }>(`/api/ssh/sftp/home?host=${encodeURIComponent(host)}`),
  sftpList: (host: string, path: string) =>
    call<{ path: string; entries: SftpEntry[] }>(`/api/ssh/sftp/list?host=${encodeURIComponent(host)}&path=${encodeURIComponent(path)}`),
  sftpMkdir: (host: string, path: string) => call("/api/ssh/sftp/mkdir", "POST", { host, path }),
  sftpRename: (host: string, from: string, to: string) => call("/api/ssh/sftp/rename", "POST", { host, from, to }),
  sftpRemove: (host: string, path: string) => call("/api/ssh/sftp/remove", "POST", { host, path }),
  sftpChmod: (host: string, path: string, mode: string) => call("/api/ssh/sftp/chmod", "POST", { host, path, mode }),
  async sftpUpload(host: string, path: string, file: File) {
    const response = await apiFetch(`/api/ssh/sftp/upload?host=${encodeURIComponent(host)}&path=${encodeURIComponent(path)}`, { method: "PUT", body: file });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      const error = new Error(body.error ?? "failed") as Fail;
      error.code = body.error;
      throw error;
    }
  },
  downloadUrl: (host: string, path: string) => `/api/ssh/sftp/download?host=${encodeURIComponent(host)}&path=${encodeURIComponent(path)}`,
  privateKeyUrl: (id: string) => `/api/ssh/keys/private?id=${encodeURIComponent(id)}`,
};
void apiRequest;

const MESSAGES = (): Record<string, string> => ({
  host_required: tr("请填写主机地址。", "Enter the host address."),
  bad_host: tr("主机地址里不能有空格。", "The host address cannot contain spaces."),
  bad_port: tr("端口要在 1–65535 之间。", "The port must be between 1 and 65535."),
  key_required: tr("选择一把密钥，或者改用密码登录。", "Choose a key, or sign in with a password instead."),
  identity_required: tr("选择一个身份。", "Choose an identity."),
  username_required: tr("请填写用户名。", "Enter the user name."),
  unknown_host: tr("这台主机已经不在了，刷新一下。", "This host is gone; refresh."),
  jump_loop: tr("跳板机绕回了自己，换一台跳板机。", "The jump host loops back to itself; choose another."),
  auth_failed: tr("登录被拒绝：用户名、密码或密钥不对。", "Sign-in refused: wrong user name, password or key."),
  timeout: tr("连接超时，检查地址、端口和网络。", "Connection timed out. Check the address, port and network."),
  host_not_found: tr("找不到这个主机名，检查地址拼写或 DNS。", "Host name not found. Check the spelling or DNS."),
  connection_refused: tr("对方拒绝连接：端口没开或 SSH 服务没运行。", "Connection refused: the port is closed or SSH is not running."),
  connect_failed: tr("连不上这台主机。", "Cannot connect to this host."),
  jump_failed: tr("跳板机连上了，但它到不了目标主机。", "The jump host connected but cannot reach the target host."),
  agent_failed: tr("没连上 SSH Agent：先在 Windows 里启动 OpenSSH Authentication Agent 服务，或打开 Pageant。", "Could not reach the SSH agent. Start the OpenSSH Authentication Agent service in Windows, or open Pageant."),
  shell_failed: tr("连上了，但对方没有开出终端。", "Connected, but the host did not open a terminal."),
  too_many_sessions: tr("这台主机已经开了 8 个终端，先关掉几个。", "This host already has 8 terminals open; close some first."),
  bad_key: tr("这不是一把能识别的私钥。", "This is not a private key that can be read."),
  needs_passphrase: tr("这把密钥有口令保护，请填写口令。", "This key has a passphrase; enter it."),
  bad_passphrase: tr("密钥口令不对。", "Wrong key passphrase."),
  not_private_key: tr("这是公钥，请粘贴私钥。", "This is a public key; paste the private key."),
  key_in_use: tr("还有主机或身份在用这把密钥，先换掉再删除。", "Hosts or identities still use this key. Change them before deleting it."),
  key_file_missing: tr("密钥文件找不到了（它是从 ~/.ssh 引用的）。", "The key file is missing (it was referenced from ~/.ssh)."),
  identity_in_use: tr("还有主机在用这个身份，先换掉再删除。", "Hosts still use this identity. Change them before deleting it."),
  command_required: tr("请填写命令。", "Enter a command."),
  snippet_required: tr("选择要执行的代码片段。", "Choose the snippet to run."),
  snippet_in_use: tr("还有任务在用这个片段，先换掉或删除那些任务。", "Tasks still use this snippet. Change or delete them first."),
  bad_dir: tr("目录里不能有换行。", "The folder cannot contain line breaks."),
  unknown_task: tr("这个任务已经不在了，刷新一下。", "This task is gone; refresh."),
  task_running: tr("这个任务正在执行，等它结束或先停止。", "This task is running. Wait for it or stop it first."),
  unknown_run: tr("这次执行的记录已经不在了（MirrorMix 重启后不保留）。", "This run's record is gone (it is not kept across MirrorMix restarts)."),
  no_ssh_config: tr("没有找到 ~/.ssh/config。", "~/.ssh/config was not found."),
  not_found: tr("文件或文件夹不存在。", "The file or folder does not exist."),
  permission_denied: tr("没有权限。", "Permission denied."),
  is_directory: tr("这是文件夹，不能下载。", "This is a folder and cannot be downloaded."),
  sftp_failed: tr("SFTP 打不开：对方可能没有启用 SFTP。", "SFTP will not open; the host may not have SFTP enabled."),
  bad_mode: tr("权限要写成 755 这样的八进制数字。", "Write permissions as an octal number like 755."),
  group_loop: tr("分组不能放进自己的子分组。", "A group cannot go inside its own subgroup."),
});
const explain = (error: unknown) => {
  const code = (error as Fail)?.code ?? "";
  return MESSAGES()[code] ?? (code ? tr(`操作失败（${code}）`, `Failed (${code})`) : tr("操作失败，稍后再试。", "That failed. Try again later."));
};

// ---------------------------------------------------------------- small pieces

const COLORS = ["#2f7d6d", "#3b6fd8", "#8b5cf6", "#d9467a", "#d97706", "#64748b"];

function initials(label: string) {
  const text = label.trim();
  if (!text) return "?";
  return /^[\x00-\x7f]/.test(text) ? text.slice(0, 2).toUpperCase() : text.slice(0, 1);
}

function Avatar({ host }: { host: Pick<SshHostView, "label" | "color"> }) {
  return (
    <span className="ssh-avatar" style={{ background: host.color ?? "var(--signal)" }} aria-hidden="true">
      {initials(host.label)}
    </span>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="ssh-field">
      <span className="ssh-field-label">{label}</span>
      {children}
      {hint && <span className="ssh-field-hint">{hint}</span>}
    </label>
  );
}

function copy(text: string) {
  void navigator.clipboard?.writeText(text).catch(() => undefined);
}

function size(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

const when = (ms?: number) => (ms ? new Date(ms).toLocaleString(uiLocale(), { hour12: false }) : "—");

// ---------------------------------------------------------------- host key question

function HostKeyDialog({ question, onTrust, onCancel }: { question: SshHostKeyQuestion; onTrust: () => void; onCancel: () => void }) {
  return (
    <div className="ssh-modal" role="alertdialog" aria-labelledby="ssh-hostkey-title">
      <div className="ssh-modal-card">
        <h3 id="ssh-hostkey-title">{question.previous ? tr("主机密钥变了", "The host key changed") : tr("第一次连接这台主机", "First connection to this host")}</h3>
        {question.previous ? (
          <p className="ssh-warning">
            {tr(
              `${question.address} 的主机密钥和之前保存的不一样。可能是服务器重装了，也可能有人在中间冒充它。确认是你自己换的再继续。`,
              `${question.address}'s host key differs from the saved one. The server may have been reinstalled, or someone may be impersonating it. Continue only if you changed it yourself.`,
            )}
          </p>
        ) : (
          <p>
            {tr("确认下面的指纹和服务器上 ", "Check that the fingerprint below matches what ")}
            <code>ssh-keygen -lf /etc/ssh/ssh_host_*_key.pub</code>
            {tr(" 显示的一致，再信任它。", " shows on the server, then trust it.")}
          </p>
        )}
        <dl className="ssh-hostkey">
          <dt>{tr("主机", "Host")}</dt>
          <dd>{question.address}</dd>
          <dt>{tr("类型", "Type")}</dt>
          <dd>{question.keyType}</dd>
          <dt>{tr("指纹", "Fingerprint")}</dt>
          <dd>
            <code>{question.fingerprint}</code>
          </dd>
          {question.previous && (
            <>
              <dt>{tr("之前的", "Previous")}</dt>
              <dd>
                <code>{question.previous}</code>
              </dd>
            </>
          )}
        </dl>
        <div className="ssh-modal-actions">
          <button type="button" className="quiet-button" onClick={onCancel}>
            {tr("取消", "Cancel")}
          </button>
          <button type="button" className={question.previous ? "quiet-button is-danger" : "quiet-button is-primary"} onClick={onTrust}>
            {question.previous ? tr("替换并连接", "Replace and connect") : tr("信任并连接", "Trust and connect")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- terminal

function SshScreen({ tid, mobile, onGone }: { tid: string; mobile: boolean; onGone: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const lineRef = useRef<HTMLInputElement>(null);
  const goneRef = useRef(onGone);
  const [ready, setReady] = useState(false);
  const [line, setLine] = useState("");
  goneRef.current = onGone;

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace',
      fontSize: mobile ? 12 : 13,
      scrollback: 8000,
      theme: { background: "#0f1f26", foreground: "#d7e6ec", cursor: "#5cc4b8", selectionBackground: "#2b4a55" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);
    let closed = false;
    let retry = 0;
    let sized = "";
    const sendSize = () => {
      const socket = socketRef.current;
      if (socket?.readyState !== WebSocket.OPEN) return;
      const next = `${term.cols}x${term.rows}`;
      if (next === sized) return;
      sized = next;
      socket.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    };
    const refit = () => {
      try {
        fit.fit();
      } catch {
        return;
      }
      sendSize();
    };
    const connect = (attempt: number) => {
      setReady(false);
      const protocol = location.protocol === "https:" ? "wss" : "ws";
      const socket = new WebSocket(`${protocol}://${location.host}/api/ssh/term?tid=${encodeURIComponent(tid)}`);
      socketRef.current = socket;
      socket.onopen = () => {
        attempt = 0;
        term.reset();
        sized = "";
        refit();
        setReady(true);
        if (!mobile) term.focus();
      };
      socket.onmessage = (event) => term.write(typeof event.data === "string" ? event.data : String(event.data));
      socket.onclose = (event) => {
        setReady(false);
        if (closed) return;
        if (event.code === 4404 || event.code === 4000) {
          term.write(`\r\n\x1b[90m${tr("[连接已结束]", "[Connection closed]")}\x1b[0m\r\n`);
          goneRef.current();
          return;
        }
        retry = window.setTimeout(() => connect(attempt + 1), Math.min(5000, 400 * 2 ** attempt));
      };
    };
    connect(0);
    const typed = term.onData((data) => {
      if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(data);
    });
    let timer = 0;
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(refit, 100);
    });
    observer.observe(element);
    return () => {
      closed = true;
      window.clearTimeout(retry);
      window.clearTimeout(timer);
      observer.disconnect();
      typed.dispose();
      socketRef.current?.close();
      term.dispose();
    };
  }, [tid, mobile]);

  const press = (data: string) => {
    if (socketRef.current?.readyState !== WebSocket.OPEN) return false;
    socketRef.current.send(data);
    return true;
  };

  const submitLine = (event: FormEvent) => {
    event.preventDefault();
    if (!line || !press(`${line}\r`)) return;
    setLine("");
    lineRef.current?.focus();
  };

  return (
    <div className="ssh-screen-wrap">
      <div className="ssh-screen" ref={host} />
      {mobile && (
        <div className="cmd-line ssh-line">
          <div className="cmd-line-keys" aria-label={tr("快捷键", "Keys")}>
            {[
              ["Esc", "\x1b"],
              ["Tab", "\t"],
              ["Ctrl+C", "\x03"],
              ["Ctrl+D", "\x04"],
              ["↑", "\x1b[A"],
              ["↓", "\x1b[B"],
              ["←", "\x1b[D"],
              ["→", "\x1b[C"],
            ].map(([label, data]) => (
              <button key={label} type="button" disabled={!ready} onClick={() => press(data)}>
                {label}
              </button>
            ))}
          </div>
          <form onSubmit={submitLine}>
            <input
              ref={lineRef}
              aria-label={tr("要执行的命令", "Command to run")}
              placeholder={ready ? tr("输入命令，回车执行", "Type a command, Enter to run") : tr("正在连接 SSH", "Connecting SSH")}
              value={line}
              enterKeyHint="send"
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setLine(event.target.value)}
            />
            <button type="submit" disabled={!ready}>{tr("执行", "Run")}</button>
          </form>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- SFTP

function SftpPanel({ host, onError, onHostKey }: { host: SshHostView; onError: (text: string) => void; onHostKey: (question: SshHostKeyQuestion, retry: () => void) => void }) {
  const [dir, setDir] = useState("");
  const [entries, setEntries] = useState<SftpEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const [uploading, setUploading] = useState("");
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const join = (base: string, name: string) => (base.endsWith("/") ? base + name : `${base}/${name}`);
  const parent = (path: string) => (path === "/" ? "/" : path.replace(/\/[^/]+\/?$/, "") || "/");

  const load = useCallback(
    async (path?: string) => {
      setBusy(true);
      try {
        const target = path ?? (dir || (await ssh.sftpHome(host.id)).path);
        const result = await ssh.sftpList(host.id, target);
        setDir(result.path);
        setEntries(result.entries);
      } catch (error) {
        const fail = error as Fail;
        if (fail.question) onHostKey(fail.question, () => void load(path));
        else onError(explain(error));
      } finally {
        setBusy(false);
      }
    },
    [dir, host.id, onError, onHostKey],
  );

  useEffect(() => {
    setDir("");
    setEntries(null);
    void (async () => {
      setBusy(true);
      try {
        const home = (await ssh.sftpHome(host.id)).path;
        const result = await ssh.sftpList(host.id, home);
        setDir(result.path);
        setEntries(result.entries);
      } catch (error) {
        const fail = error as Fail;
        if (fail.question) onHostKey(fail.question, () => void load("."));
        else onError(explain(error));
      } finally {
        setBusy(false);
      }
    })();
    // Only when the host changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host.id]);

  const act = async (work: () => Promise<unknown>) => {
    try {
      await work();
      await load(dir);
    } catch (error) {
      onError(explain(error));
    }
  };

  const upload = async (files: FileList | File[]) => {
    const list = [...files];
    for (const [index, file] of list.entries()) {
      setUploading(tr(`正在上传 ${index + 1}/${list.length}：${file.name}`, `Uploading ${index + 1}/${list.length}: ${file.name}`));
      try {
        await ssh.sftpUpload(host.id, join(dir, file.name), file);
      } catch (error) {
        onError(tr(`${file.name}：${explain(error)}`, `${file.name}: ${explain(error)}`));
      }
    }
    setUploading("");
    await load(dir);
  };

  const crumbs = dir.split("/").filter(Boolean);
  const shown = (entries ?? []).filter((entry) => !filter || entry.name.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div
      className={dragging ? "sftp is-dragging" : "sftp"}
      onDragOver={(event) => {
        if (![...event.dataTransfer.types].includes("Files")) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        if (event.dataTransfer.files.length) void upload(event.dataTransfer.files);
      }}
    >
      <div className="sftp-bar">
        <button type="button" className="icon-button" title={tr("上一级", "Up")} disabled={!dir || dir === "/"} onClick={() => void load(parent(dir))}>
          <UpIcon />
        </button>
        <nav className="sftp-crumbs" aria-label={tr("路径", "Path")}>
          <button type="button" onClick={() => void load("/")}>
            /
          </button>
          {crumbs.map((part, index) => (
            <button key={index} type="button" onClick={() => void load("/" + crumbs.slice(0, index + 1).join("/"))}>
              {part}
            </button>
          ))}
        </nav>
        <span className="sftp-tools">
          <input className="ssh-search-input" placeholder={tr("筛选", "Filter")} value={filter} onChange={(event) => setFilter(event.target.value)} />
          <button type="button" className="icon-button" title={tr("刷新", "Refresh")} onClick={() => void load(dir)}>
            {busy ? <Spinner /> : <RefreshIcon />}
          </button>
          <button
            type="button"
            className="quiet-button"
            onClick={() => {
              const name = window.prompt(tr("新文件夹名称", "New folder name"));
              if (name?.trim()) void act(() => ssh.sftpMkdir(host.id, join(dir, name.trim())));
            }}
          >
            {tr("新建文件夹", "New folder")}
          </button>
          <button type="button" className="quiet-button is-primary" onClick={() => fileInput.current?.click()}>
            {tr("上传", "Upload")}
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              if (event.target.files?.length) void upload(event.target.files);
              event.target.value = "";
            }}
          />
        </span>
      </div>
      {uploading && <p className="sftp-note">{uploading}</p>}
      <div className="sftp-table" role="table" aria-label={tr(`${host.label} 的文件`, `${host.label}'s files`)}>
        <div className="sftp-row sftp-head" role="row">
          <span>{tr("名称", "Name")}</span>
          <span>{tr("大小", "Size")}</span>
          <span>{tr("修改时间", "Modified")}</span>
          <span>{tr("权限", "Permissions")}</span>
          <span />
        </div>
        {entries === null ? (
          <p className="blank">{busy ? tr("正在打开…", "Opening…") : tr("没有打开", "Not open")}</p>
        ) : shown.length === 0 ? (
          <p className="blank">{filter ? tr("没有匹配的文件", "No matching files") : tr("空文件夹。把文件拖到这里即可上传。", "Empty folder. Drag files here to upload.")}</p>
        ) : (
          shown.map((entry) => {
            const full = join(dir, entry.name);
            return (
              <div className="sftp-row" role="row" key={entry.name} onDoubleClick={() => entry.dir && void load(full)}>
                <span className="sftp-name">
                  {entry.dir ? <FolderIcon /> : <FileIcon />}
                  {entry.dir ? (
                    <button type="button" className="link-button" onClick={() => void load(full)}>
                      {entry.name}
                    </button>
                  ) : (
                    <span title={entry.name}>{entry.name}</span>
                  )}
                  {entry.link && <em className="sftp-link">{tr("链接", "link")}</em>}
                </span>
                <span>{entry.dir ? "—" : size(entry.size)}</span>
                <span>{when(entry.mtime)}</span>
                <span className="sftp-mode">{entry.mode}</span>
                <span className="sftp-actions">
                  {!entry.dir && (
                    <a className="quiet-button" href={ssh.downloadUrl(host.id, full)} download={entry.name}>
                      {tr("下载", "Download")}
                    </a>
                  )}
                  <button
                    type="button"
                    className="quiet-button"
                    onClick={() => {
                      const name = window.prompt(tr("新名称", "New name"), entry.name);
                      if (name?.trim() && name.trim() !== entry.name) void act(() => ssh.sftpRename(host.id, full, join(dir, name.trim())));
                    }}
                  >
                    {tr("重命名", "Rename")}
                  </button>
                  <button
                    type="button"
                    className="quiet-button"
                    onClick={() => {
                      const mode = window.prompt(tr("权限（八进制，例如 755）", "Permissions (octal, e.g. 755)"), "");
                      if (mode?.trim()) void act(() => ssh.sftpChmod(host.id, full, mode.trim()));
                    }}
                  >
                    {tr("权限", "Permissions")}
                  </button>
                  <button
                    type="button"
                    className="quiet-button is-danger"
                    onClick={() => {
                      if (window.confirm(entry.dir ? tr(`删除文件夹“${entry.name}”和里面的所有内容？不能恢复。`, `Delete the folder "${entry.name}" and everything in it? This cannot be undone.`) : tr(`删除“${entry.name}”？不能恢复。`, `Delete "${entry.name}"? This cannot be undone.`))) {
                        void act(() => ssh.sftpRemove(host.id, full));
                      }
                    }}
                  >
                    {tr("删除", "Delete")}
                  </button>
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- host editor

const AUTH_LABEL = (): Record<SshAuth, string> => ({ password: tr("密码", "Password"), key: tr("密钥", "Key"), identity: tr("身份", "Identity"), agent: "SSH Agent" });

function HostEditor({
  state,
  host,
  groupId,
  onSaved,
  onClose,
  onDelete,
  onTest,
  onDuplicate,
  onSftp,
}: {
  state: SshState;
  host: SshHostView | null;
  groupId?: string;
  onSaved: (host: SshHostView) => void;
  onClose: () => void;
  onDelete?: () => void;
  /** Connects and leaves again; resolves true when it worked. */
  onTest?: () => Promise<boolean>;
  onDuplicate?: () => void;
  onSftp?: () => void;
}) {
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState("");
  const [form, setForm] = useState<SshHostInput>(() =>
    host
      ? {
          id: host.id,
          label: host.label,
          host: host.host,
          port: host.port,
          username: host.username,
          groupId: host.groupId ?? null,
          tags: host.tags,
          color: host.color ?? null,
          auth: host.auth,
          keyId: host.keyId ?? null,
          identityId: host.identityId ?? null,
          jumpHostId: host.jumpHostId ?? null,
          startupSnippetId: host.startupSnippetId ?? null,
          keepAlive: host.keepAlive,
          backspace: host.backspace ?? "del",
          notes: host.notes ?? "",
        }
      : { label: "", host: "", port: 22, username: "root", auth: "password", groupId: groupId ?? null, tags: [], keepAlive: 30, backspace: "del" },
  );
  const [password, setPassword] = useState("");
  const [clearPassword, setClearPassword] = useState(false);
  const [tags, setTags] = useState((host?.tags ?? []).join(", "));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (change: Partial<SshHostInput>) => setForm((current) => ({ ...current, ...change }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const saved = await ssh.saveHost({
        ...form,
        tags: tags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean),
        ...(password ? { password } : clearPassword ? { password: "" } : {}),
      });
      onSaved(saved);
    } catch (caught) {
      setError(explain(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="ssh-editor" onSubmit={submit}>
      <header className="ssh-editor-head">
        <h3>{host ? tr("编辑主机", "Edit host") : tr("新建主机", "New host")}</h3>
        <button type="button" className="icon-button" aria-label={tr("关闭", "Close")} onClick={onClose}>
          <CloseIcon />
        </button>
      </header>
      <div className="ssh-editor-body">
        {host && (
          <div className="ssh-editor-tools">
            <button
              type="button"
              className="quiet-button"
              disabled={testing}
              onClick={async () => {
                if (!onTest) return;
                setTesting(true);
                setTested("");
                const ok = await onTest();
                setTesting(false);
                if (ok) setTested(tr("连接正常", "Connection OK"));
              }}
            >
              {testing && <Spinner />}
              {tr("测试连接", "Test connection")}
            </button>
            {onDuplicate && (
              <button type="button" className="quiet-button" onClick={onDuplicate}>
                {tr("复制一份", "Duplicate")}
              </button>
            )}
            {onSftp && (
              <button type="button" className="quiet-button" onClick={onSftp}>
                {tr("打开 SFTP", "Open SFTP")}
              </button>
            )}
            {tested && <span className="ssh-editor-ok">{tested}</span>}
          </div>
        )}
        <Field label={tr("地址", "Address")}>
          <input required autoFocus={!host} placeholder={tr("example.com 或 10.0.0.5", "example.com or 10.0.0.5")} value={form.host} onChange={(event) => set({ host: event.target.value })} />
        </Field>
        <div className="ssh-field-row">
          <Field label={tr("名称", "Name")}>
            <input placeholder={tr("不填就用地址", "Defaults to the address")} value={form.label} onChange={(event) => set({ label: event.target.value })} />
          </Field>
          <Field label={tr("端口", "Port")}>
            <input type="number" min={1} max={65535} value={form.port ?? 22} onChange={(event) => set({ port: Number(event.target.value) })} />
          </Field>
        </div>
        <Field label={tr("标签", "Tags")}>
          <input placeholder={tr("生产, 数据库", "production, database")} value={tags} onChange={(event) => setTags(event.target.value)} />
        </Field>
        <Field label={tr("颜色", "Colour")}>
          <span className="ssh-colors">
            {COLORS.map((color) => (
              <button
                key={color}
                type="button"
                className={form.color === color ? "ssh-color is-on" : "ssh-color"}
                style={{ background: color }}
                aria-label={tr(`颜色 ${color}`, `Colour ${color}`)}
                onClick={() => set({ color: form.color === color ? null : color })}
              />
            ))}
          </span>
        </Field>

        <fieldset className="ssh-fieldset">
          <legend>{tr("登录", "Sign-in")}</legend>
          <div className="theme-choice ssh-auth" role="radiogroup" aria-label={tr("登录方式", "Sign-in method")}>
            {(Object.keys(AUTH_LABEL()) as SshAuth[]).map((auth) => (
              <button key={auth} type="button" role="radio" aria-checked={form.auth === auth} className={form.auth === auth ? "active" : ""} onClick={() => set({ auth })}>
                {AUTH_LABEL()[auth]}
              </button>
            ))}
          </div>
          {form.auth !== "identity" && (
            <Field label={tr("用户名", "User name")}>
              <input value={form.username ?? ""} onChange={(event) => set({ username: event.target.value })} />
            </Field>
          )}
          {form.auth === "password" && (
            <Field label={tr("密码", "Password")} hint={host?.hasPassword ? tr("已保存。留空则不修改。", "Saved. Leave empty to keep it.") : tr("加密保存在这台电脑上，只有你的 Windows 账户能解开。", "Stored encrypted on this computer; only your Windows account can unlock it.")}>
              <input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} />
              {host?.hasPassword && (
                <label className="ssh-check">
                  <input type="checkbox" checked={clearPassword} onChange={(event) => setClearPassword(event.target.checked)} /> {tr("删除已保存的密码", "Delete the saved password")}
                </label>
              )}
            </Field>
          )}
          {form.auth === "key" && (
            <Field label={tr("密钥", "Key")} hint={state.keys.length ? undefined : tr("钥匙串里还没有密钥，先到“钥匙串”生成或导入一把。", "The keychain has no keys yet. Generate or import one under Keychain first.")}>
              <Select
                ariaLabel={tr("密钥", "Key")}
                placeholder={tr("选择密钥", "Choose a key")}
                empty={tr("钥匙串里还没有密钥", "No keys in the keychain yet")}
                value={form.keyId ?? ""}
                onChange={(keyId) => set({ keyId: keyId || null })}
                options={state.keys.map((key) => ({ value: key.id, label: key.label, hint: `${key.type} · ${key.fingerprint.slice(0, 22)}…`, keywords: key.fingerprint }))}
              />
            </Field>
          )}
          {form.auth === "identity" && (
            <Field label={tr("身份", "Identity")} hint={state.identities.length ? undefined : tr("还没有身份，先到“钥匙串”添加。", "No identities yet. Add one under Keychain first.")}>
              <Select
                ariaLabel={tr("身份", "Identity")}
                placeholder={tr("选择身份", "Choose an identity")}
                empty={tr("还没有身份", "No identities yet")}
                value={form.identityId ?? ""}
                onChange={(identityId) => set({ identityId: identityId || null })}
                options={state.identities.map((identity) => ({
                  value: identity.id,
                  label: identity.label,
                  hint: `${identity.username}${identity.keyId ? tr(" · 密钥", " · key") : identity.hasPassword ? tr(" · 密码", " · password") : ""}`,
                }))}
              />
            </Field>
          )}
          {form.auth === "agent" && <p className="ssh-field-hint">{tr("使用 Windows 的 OpenSSH Authentication Agent（或 Pageant）里已经加载的密钥。", "Uses the keys already loaded in Windows' OpenSSH Authentication Agent (or Pageant).")}</p>}
        </fieldset>

        <fieldset className="ssh-fieldset">
          <legend>{tr("高级", "Advanced")}</legend>
          <Field label={tr("连接后运行", "Run after connecting")} hint={tr("终端打开后自动输入的代码片段。", "A snippet typed in automatically once the terminal opens.")}>
            <Select
              ariaLabel={tr("连接后运行", "Run after connecting")}
              value={form.startupSnippetId ?? ""}
              onChange={(startupSnippetId) => set({ startupSnippetId: startupSnippetId || null })}
              options={[{ value: "", label: tr("不运行", "Nothing") }, ...state.snippets.map(snippetOption)]}
            />
          </Field>
          <div className="ssh-field-row">
            <Field label={tr("保活（秒）", "Keep-alive (seconds)")}>
              <input type="number" min={0} max={600} value={form.keepAlive ?? 30} onChange={(event) => set({ keepAlive: Number(event.target.value) })} />
            </Field>
            <Field label={tr("退格键发送", "Backspace sends")}>
              <Select
                ariaLabel={tr("退格键发送", "Backspace sends")}
                value={form.backspace ?? "del"}
                onChange={(backspace) => set({ backspace: backspace === "bs" ? "bs" : "del" })}
                options={[
                  { value: "del", label: "DEL", hint: tr("多数系统", "Most systems") },
                  { value: "bs", label: "Ctrl+H", hint: tr("老设备、部分交换机", "Older devices, some switches") },
                ]}
              />
            </Field>
          </div>
          <Field label={tr("备注", "Notes")}>
            <textarea rows={3} value={form.notes ?? ""} onChange={(event) => set({ notes: event.target.value })} />
          </Field>
        </fieldset>
        {error && <p className="banner is-warning">{error}</p>}
      </div>
      <footer className="ssh-editor-foot">
        {host && onDelete && (
          <button type="button" className="quiet-button is-danger" onClick={onDelete}>
            {tr("删除主机", "Delete host")}
          </button>
        )}
        <span className="ssh-spacer" />
        <button type="button" className="quiet-button" onClick={onClose}>
          {tr("取消", "Cancel")}
        </button>
        <button type="submit" className="quiet-button is-primary" disabled={busy}>
          {busy && <Spinner />}
          {tr("保存", "Save")}
        </button>
      </footer>
    </form>
  );
}

// ---------------------------------------------------------------- vault sections

type Section = "hosts" | "tasks" | "keychain" | "snippets";
const SECTIONS = (): Array<[Section, string]> => [
  ["hosts", tr("主机", "Hosts")],
  ["tasks", tr("任务", "Tasks")],
  ["keychain", tr("钥匙串", "Keychain")],
  ["snippets", tr("代码片段", "Snippets")],
];

function HostsSection({
  state,
  onConnect,
  onEdit,
  onNew,
  onChange,
  onError,
}: {
  state: SshState;
  onConnect: (host: SshHostView) => void;
  onEdit: (host: SshHostView) => void;
  onNew: (groupId?: string) => void;
  onChange: () => void;
  onError: (text: string) => void;
}) {
  const [query, setQuery] = useState("");
  /** The tag picked under the search box; picking it again shows every host. */
  const [tag, setTag] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const needle = query.trim().toLowerCase();
  const allTags = [...new Set(state.hosts.flatMap((host) => host.tags))].sort((a, b) => a.localeCompare(b));
  // A tag no host carries any more (edited away) stops filtering.
  const picked = tag && allTags.includes(tag) ? tag : null;
  const hosts = state.hosts
    .filter((host) => !picked || host.tags.includes(picked))
    .filter((host) => !needle || [host.label, host.host, host.username, ...host.tags].some((text) => text.toLowerCase().includes(needle)))
    .sort((a, b) => a.label.localeCompare(b.label));

  const card = (host: SshHostView) => (
    <li key={host.id} className="ssh-host">
      <button type="button" className="ssh-host-main" title={tr("连接", "Connect")} onClick={() => onConnect(host)}>
        <Avatar host={host} />
        <span className="ssh-host-text">
          <strong>
            {host.label}
            {!state.knownHosts.some((known) => known.address === `${host.host}:${host.port}`) && (
              <span className="ssh-host-unverified" title={tr("还没确认过这台主机的密钥：第一次连接时会请你核对指纹", "This host's key has not been confirmed yet; you will be asked to check its fingerprint on first connection")} aria-label={tr("主机密钥未确认", "Host key not confirmed")}>
                <ShieldQuestionIcon />
              </span>
            )}
          </strong>
          <span>
            {host.username ? `${host.username}@` : ""}
            {host.host}
            {host.port !== 22 ? `:${host.port}` : ""}
          </span>
          {host.tags.length > 0 && (
            <span className="ssh-tags">
              {host.tags.map((tag) => (
                <em key={tag}>{tag}</em>
              ))}
            </span>
          )}
        </span>
      </button>
      <button type="button" className="ssh-host-edit" aria-label={tr(`编辑 ${host.label}`, `Edit ${host.label}`)} title={tr("编辑", "Edit")} onClick={() => onEdit(host)}>
        <EditIcon />
      </button>
    </li>
  );

  return (
    <div className="ssh-section">
      <div className="ssh-toolbar">
        <label className="ssh-search">
          <SearchIcon />
          <input placeholder={tr("搜索名称、地址、用户或标签", "Search names, addresses, users or tags")} value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <button type="button" className="quiet-button is-primary" onClick={() => onNew()}>
          <PlusIcon />
          {tr("新建主机", "New host")}
        </button>
        <button
          type="button"
          className="quiet-button"
          title={tr("读取 ~/.ssh/config 里的 Host", "Read the Host entries in ~/.ssh/config")}
          onClick={async () => {
            try {
              const result = await ssh.importConfig();
              setNotice(tr(`从 ~/.ssh/config 导入了 ${result.hosts} 台主机、${result.keys} 把密钥${result.skipped.length ? `，${result.skipped.length} 台已存在` : ""}。`, `Imported ${result.hosts} hosts and ${result.keys} keys from ~/.ssh/config${result.skipped.length ? `; ${result.skipped.length} already existed` : ""}.`));
              onChange();
            } catch (error) {
              onError(explain(error));
            }
          }}
        >
          {tr("导入 ~/.ssh/config", "Import ~/.ssh/config")}
        </button>
      </div>
      {notice && <p className="banner">{notice}</p>}

      {allTags.length > 0 && (
        <div className="ssh-tag-filter" role="group" aria-label={tr("按标签筛选", "Filter by tag")}>
          {allTags.map((item) => (
            <button
              key={item}
              type="button"
              className={item === picked ? "ssh-tag-chip is-on" : "ssh-tag-chip"}
              aria-pressed={item === picked}
              onClick={() => setTag(item === picked ? null : item)}
            >
              {item}
              <span>{state.hosts.filter((host) => host.tags.includes(item)).length}</span>
            </button>
          ))}
        </div>
      )}

      {hosts.length ? (
        <ul className="ssh-hosts">{hosts.map(card)}</ul>
      ) : (
        <div className="ssh-empty">
          <p>{state.hosts.length ? tr("没有匹配的主机。", "No matching hosts.") : tr("还没有主机。新建一台，或者从 ~/.ssh/config 导入。", "No hosts yet. Add one, or import from ~/.ssh/config.")}</p>
        </div>
      )}
    </div>
  );
}

function KeychainSection({ state, onChange, onError }: { state: SshState; onChange: () => void; onError: (text: string) => void }) {
  const [mode, setMode] = useState<"" | "generate" | "import" | "identity">("");
  const [label, setLabel] = useState("");
  const [type, setType] = useState("ed25519");
  const [bits, setBits] = useState(4096);
  const [passphrase, setPassphrase] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [identity, setIdentity] = useState<{ id?: string; label: string; username: string; password: string; keyId: string }>({ label: "", username: "", password: "", keyId: "" });
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState("");

  const reset = () => {
    setMode("");
    setLabel("");
    setPassphrase("");
    setPrivateKey("");
    setIdentity({ label: "", username: "", password: "", keyId: "" });
  };
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
      reset();
      onChange();
    } catch (error) {
      onError(explain(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ssh-section">
      <div className="ssh-toolbar">
        <h4 className="ssh-title">{tr("密钥", "Key")}</h4>
        <button type="button" className="quiet-button is-primary" onClick={() => setMode("generate")}>
          {tr("生成密钥", "Generate key")}
        </button>
        <button type="button" className="quiet-button" onClick={() => setMode("import")}>
          {tr("导入私钥", "Import private key")}
        </button>
      </div>

      {mode === "generate" && (
        <form
          className="ssh-inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            void run(() => ssh.generateKey({ label, type, ...(type === "rsa" ? { bits } : {}), ...(passphrase ? { passphrase } : {}) }));
          }}
        >
          <div className="ssh-field-row">
            <Field label={tr("名称", "Name")}>
              <input autoFocus placeholder={tr("例如 laptop", "e.g. laptop")} value={label} onChange={(event) => setLabel(event.target.value)} />
            </Field>
            <Field label={tr("类型", "Type")}>
              <Select
                ariaLabel={tr("密钥类型", "Key type")}
                value={type}
                onChange={setType}
                options={[
                  { value: "ed25519", label: "Ed25519", hint: tr("推荐：短、快、安全", "Recommended: short, fast, secure") },
                  { value: "ecdsa", label: "ECDSA", hint: tr("老一些的系统也支持", "Older systems support it too") },
                  { value: "rsa", label: "RSA", hint: tr("兼容最广", "Widest compatibility") },
                ]}
              />
            </Field>
            {type === "rsa" && (
              <Field label={tr("位数", "Bits")}>
                <Select
                  ariaLabel={tr("位数", "Bits")}
                  value={String(bits)}
                  onChange={(next) => setBits(Number(next))}
                  options={[
                    { value: "4096", label: "4096", hint: tr("推荐", "Recommended") },
                    { value: "2048", label: "2048" },
                  ]}
                />
              </Field>
            )}
          </div>
          <Field label={tr("口令（可选）", "Passphrase (optional)")} hint={tr("给私钥再加一层保护。", "An extra layer of protection for the private key.")}>
            <input type="password" autoComplete="new-password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} />
          </Field>
          <div className="ssh-form-actions">
            <button type="button" className="quiet-button" onClick={reset}>
              {tr("取消", "Cancel")}
            </button>
            <button type="submit" className="quiet-button is-primary" disabled={busy}>
              {busy && <Spinner />}
              {tr("生成", "Generate")}
            </button>
          </div>
        </form>
      )}

      {mode === "import" && (
        <form
          className="ssh-inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            void run(() => ssh.importKey({ label, privateKey, ...(passphrase ? { passphrase } : {}) }));
          }}
        >
          <Field label={tr("名称", "Name")}>
            <input autoFocus value={label} onChange={(event) => setLabel(event.target.value)} />
          </Field>
          <Field label={tr("私钥", "Private key")} hint={tr("粘贴 OpenSSH 或 PEM 格式的私钥，或选择文件。", "Paste an OpenSSH or PEM private key, or choose a file.")}>
            <textarea rows={6} className="ssh-mono" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" value={privateKey} onChange={(event) => setPrivateKey(event.target.value)} />
            <input
              type="file"
              onChange={async (event) => {
                const file = event.target.files?.[0];
                if (file) setPrivateKey(await file.text());
                if (file && !label) setLabel(file.name);
              }}
            />
          </Field>
          <Field label={tr("口令（如果有）", "Passphrase (if any)")}>
            <input type="password" autoComplete="new-password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} />
          </Field>
          <div className="ssh-form-actions">
            <button type="button" className="quiet-button" onClick={reset}>
              {tr("取消", "Cancel")}
            </button>
            <button type="submit" className="quiet-button is-primary" disabled={busy || !privateKey.trim()}>
              {busy && <Spinner />}
              {tr("导入", "Import")}
            </button>
          </div>
        </form>
      )}

      {state.keys.length === 0 ? (
        <p className="blank">{tr("钥匙串里还没有密钥。", "No keys in the keychain yet.")}</p>
      ) : (
        <ul className="ssh-list">
          {state.keys.map((key: SshKeyView) => (
            <li key={key.id} className="ssh-list-row">
              <span className="ssh-list-main">
                <strong>{key.label}</strong>
                <span>
                  {key.type} · {key.fingerprint}
                  {key.hasPassphrase ? tr(" · 有口令", " · passphrase") : ""}
                  {key.file ? tr(` · 引用 ${key.file}`, ` · from ${key.file}`) : ""}
                </span>
              </span>
              <span className="ssh-row-actions">
                <button
                  type="button"
                  className="quiet-button"
                  onClick={() => {
                    copy(key.publicKey);
                    setCopied(key.id);
                    window.setTimeout(() => setCopied(""), 1500);
                  }}
                >
                  {copied === key.id ? tr("已复制", "Copied") : tr("复制公钥", "Copy public key")}
                </button>
                <a className="quiet-button" href={ssh.privateKeyUrl(key.id)} onClick={(event) => !window.confirm(tr("导出私钥文件？拿到它的人可以登录这把钥匙能登录的所有主机。", "Export the private key file? Anyone who has it can sign in to every host this key can.")) && event.preventDefault()}>
                  {tr("导出私钥", "Export private key")}
                </a>
                <button
                  type="button"
                  className="quiet-button"
                  onClick={async () => {
                    const name = window.prompt(tr("密钥名称", "Key name"), key.label);
                    if (!name?.trim()) return;
                    try {
                      await ssh.renameKey(key.id, name.trim());
                      onChange();
                    } catch (error) {
                      onError(explain(error));
                    }
                  }}
                >
                  {tr("重命名", "Rename")}
                </button>
                <button
                  type="button"
                  className="quiet-button is-danger"
                  onClick={() => window.confirm(tr(`从钥匙串删除“${key.label}”？${key.file ? "原文件不会被删除。" : "删除后无法找回，除非你另有备份。"}`, `Delete "${key.label}" from the keychain? ${key.file ? "The original file is not deleted." : "It cannot be recovered unless you have a backup."}`)) && void run(() => ssh.deleteKey(key.id))}
                >
                  {tr("删除", "Delete")}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="ssh-toolbar ssh-toolbar-gap">
        <h4 className="ssh-title">{tr("身份", "Identity")}</h4>
        <span className="ssh-field-hint">{tr("一组用户名和密码（或密钥），多台主机可以共用。", "A user name with a password (or key) that several hosts can share.")}</span>
        <button type="button" className="quiet-button" onClick={() => setMode("identity")}>
          {tr("添加身份", "Add identity")}
        </button>
      </div>
      {mode === "identity" && (
        <form
          className="ssh-inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            void run(() =>
              ssh.saveIdentity({
                ...(identity.id ? { id: identity.id } : {}),
                label: identity.label,
                username: identity.username,
                ...(identity.password ? { password: identity.password } : {}),
                ...(identity.keyId ? { keyId: identity.keyId } : {}),
              }),
            );
          }}
        >
          <div className="ssh-field-row">
            <Field label={tr("名称", "Name")}>
              <input value={identity.label} onChange={(event) => setIdentity({ ...identity, label: event.target.value })} />
            </Field>
            <Field label={tr("用户名", "User name")}>
              <input required value={identity.username} onChange={(event) => setIdentity({ ...identity, username: event.target.value })} />
            </Field>
          </div>
          <div className="ssh-field-row">
            <Field label={tr("密码", "Password")} hint={identity.id ? tr("留空则不修改。", "Leave empty to keep it.") : undefined}>
              <input type="password" autoComplete="new-password" value={identity.password} onChange={(event) => setIdentity({ ...identity, password: event.target.value })} />
            </Field>
            <Field label={tr("密钥", "Key")}>
              <Select
                ariaLabel={tr("密钥", "Key")}
                value={identity.keyId}
                onChange={(keyId) => setIdentity({ ...identity, keyId })}
                options={[{ value: "", label: tr("不用密钥", "No key") }, ...state.keys.map((key) => ({ value: key.id, label: key.label, hint: key.type }))]}
              />
            </Field>
          </div>
          <div className="ssh-form-actions">
            <button type="button" className="quiet-button" onClick={reset}>
              {tr("取消", "Cancel")}
            </button>
            <button type="submit" className="quiet-button is-primary" disabled={busy}>
              {tr("保存", "Save")}
            </button>
          </div>
        </form>
      )}
      {state.identities.length === 0 ? (
        <p className="blank">{tr("还没有身份。", "No identities yet.")}</p>
      ) : (
        <ul className="ssh-list">
          {state.identities.map((item) => (
            <li key={item.id} className="ssh-list-row">
              <span className="ssh-list-main">
                <strong>{item.label}</strong>
                <span>
                  {item.username}
                  {item.hasPassword ? tr(" · 已存密码", " · password saved") : ""}
                  {item.keyId ? tr(` · 密钥 ${state.keys.find((key) => key.id === item.keyId)?.label ?? ""}`, ` · key ${state.keys.find((key) => key.id === item.keyId)?.label ?? ""}`) : ""}
                </span>
              </span>
              <span className="ssh-row-actions">
                <button
                  type="button"
                  className="quiet-button"
                  onClick={() => {
                    setIdentity({ id: item.id, label: item.label, username: item.username, password: "", keyId: item.keyId ?? "" });
                    setMode("identity");
                  }}
                >
                  {tr("编辑", "Edit")}
                </button>
                <button type="button" className="quiet-button is-danger" onClick={() => window.confirm(tr(`删除身份“${item.label}”？`, `Delete the identity "${item.label}"?`)) && void run(() => ssh.deleteIdentity(item.id))}>
                  {tr("删除", "Delete")}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type ScriptKind = NonNullable<SshSnippet["kind"]>;
const KIND_LABEL: Record<ScriptKind, string> = { linux: "Linux", windows: "Windows", python: "Python" };
const KIND_HINT = (): Record<ScriptKind, string> => ({
  linux: tr("bash 命令", "bash commands"),
  windows: tr("PowerShell 命令（Windows 主机）", "PowerShell commands (Windows hosts)"),
  python: tr("Python 代码，用 python3 在 Linux 上执行", "Python code, run with python3 on Linux"),
});
const KIND_MARK: Record<ScriptKind, string> = { linux: "$", windows: "PS", python: "py" };
const KIND_OPTIONS = (): SelectOption[] => (Object.keys(KIND_LABEL) as ScriptKind[]).map((kind) => ({
  value: kind,
  label: KIND_LABEL[kind],
  hint: KIND_HINT()[kind],
  icon: <span className={`mm-kind-mark is-${kind}`}>{KIND_MARK[kind]}</span>,
}));
const LAST_MODEL_KEY = "mirrormix.snippet-model";
const EXAMPLE = (): Record<ScriptKind, string> => ({
  linux: tr("如：拉取最新代码，进入 deploy 目录执行 install.sh，最后重启 nginx", "e.g. pull the latest code, run install.sh in the deploy folder, then restart nginx"),
  windows: tr("如：查看 C 盘剩余空间，列出占用最大的 10 个文件夹", "e.g. check free space on C: and list the 10 largest folders"),
  python: tr("如：读取 /var/log/nginx/access.log，统计访问次数最多的 10 个 IP", "e.g. read /var/log/nginx/access.log and count the 10 most frequent IPs"),
});

interface ChatLine {
  id: number;
  who: "me" | "ai";
  text: string;
  bad?: boolean;
}

/**
 * The chat that opens between the command's title and the command: each message asks the chosen model to write the
 * command (or change the one below), and the answer goes straight into the command box.
 */
function AiChat({ kind, command, onWritten }: { kind: ScriptKind; command: string; onWritten: (script: { label: string; command: string }) => void }) {
  const [models, setModels] = useState<ModelView[] | null>(null);
  const [modelId, setModelId] = useState(() => {
    try {
      return localStorage.getItem(LAST_MODEL_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [ask, setAsk] = useState("");
  const [writing, setWriting] = useState(false);
  const log = useRef<HTMLDivElement | null>(null);
  const nextId = useRef(1);
  useEffect(() => {
    api
      .models()
      .then((result) => setModels(result.models))
      .catch(() => setModels([]));
  }, []);
  useEffect(() => {
    const element = log.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [lines, writing]);
  // The model used last time, or the first one.
  const model = models?.find((item) => item.id === modelId) ?? models?.[0];
  const say = (who: ChatLine["who"], text: string, bad = false) => setLines((current) => [...current, { id: nextId.current++, who, text, bad }]);

  const send = async () => {
    const text = ask.trim();
    if (!model || !text || writing) return;
    setAsk("");
    say("me", text);
    setWriting(true);
    try {
      localStorage.setItem(LAST_MODEL_KEY, model.id);
    } catch {
      /* remembered next time only when storage works */
    }
    // Once there is a command, each message changes it: the chat goes on from what is in the box.
    const revising = Boolean(command.trim());
    try {
      const result = await api.writeScript(model.id, { kind, description: text, current: command });
      if (result.ok) {
        onWritten(result);
        const count = lineCount(result.command);
        say("ai", tr(`${revising ? "已按要求改好" : "写好了"}：${count} 行${KIND_LABEL[kind]}命令，已填到下面。检查一下再保存，想调整就接着说。`, `${revising ? "Revised as asked" : "Done"}: ${count} lines of ${KIND_LABEL[kind]} commands, filled in below. Check them before saving; say more to adjust.`));
      } else say("ai", result.message, true);
    } catch (error) {
      const code = (error as { code?: string }).code;
      say("ai", code === "not_found" ? tr("这个模型已经不在了，到 设置 → 模型管理 看看。", "That model is gone; check Settings → Models.") : tr("请求没有发出去，稍后再试。", "The request was not sent; try again later."), true);
    } finally {
      setWriting(false);
    }
  };

  if (models !== null && models.length === 0) {
    return (
      <div className="ssh-ai-chat">
        <p className="ssh-ai-empty">{tr("还没有可用的模型。到 设置 → 模型管理 添加一个（如 DeepSeek），就能在这里让它写命令。", "No models available yet. Add one (such as DeepSeek) in Settings → Models to have it write commands here.")}</p>
      </div>
    );
  }
  return (
    <div className="ssh-ai-chat">
      <div className="ssh-ai-chat-head">
        <span>
          {tr("按 ", "Writing a ")}
          <strong>{KIND_LABEL[kind]}</strong>
          {tr(" 脚本来写", " script")}
        </span>
        {models === null ? (
          <span className="ssh-field-hint">{tr("正在读取模型…", "Loading models…")}</span>
        ) : (
          <span className="ssh-ai-chat-model">
            <Select ariaLabel={tr("模型", "Model")} value={model?.id ?? ""} onChange={setModelId} options={models.map((item) => ({ value: item.id, label: item.name, hint: item.model }))} />
          </span>
        )}
      </div>
      <div className="ssh-ai-log" ref={log} aria-live="polite">
        {lines.length === 0 && <p className="ssh-ai-intro">{command.trim() ? tr("说说要怎么改下面的命令，比如“出错时发通知”。", "Say how to change the command below, e.g. \"send a notice on error\".") : tr("描述要做什么，模型写好后直接填到下面。", "Describe what to do; the model fills it in below.")}</p>}
        {lines.map((line) => (
          <p key={line.id} className={`ssh-ai-line is-${line.who}${line.bad ? " is-bad" : ""}`}>
            {line.text}
          </p>
        ))}
        {writing && (
          <p className="ssh-ai-line is-ai is-writing">
            <Spinner />
            {tr(`${model?.name ?? tr("模型", "Model")} 正在写…`, `${model?.name ?? "The model"} is writing…`)}
          </p>
        )}
      </div>
      <div className="ssh-ai-input">
        <textarea
          rows={2}
          value={ask}
          autoFocus
          placeholder={command.trim() ? tr("要怎么改？Enter 发送，Shift+Enter 换行", "What should change? Enter sends, Shift+Enter starts a new line") : tr(`${EXAMPLE()[kind]}。Enter 发送`, `${EXAMPLE()[kind]}. Enter sends`)}
          onChange={(event) => setAsk(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <button type="button" className="quiet-button is-primary" disabled={writing || !model || !ask.trim()} onClick={() => void send()}>
          {writing ? <Spinner /> : null}
          {tr("发送", "Send")}
        </button>
      </div>
    </div>
  );
}

/** 新建片段 / 编辑片段: a drawer with the name, the script type, and the command, with its AI chat a click away. */
function SnippetDrawer({
  snippet,
  knownTags,
  onClose,
  onSaved,
  onError,
}: {
  snippet: Partial<SshSnippet>;
  knownTags: string[];
  onClose: () => void;
  onSaved: () => void;
  onError: (text: string) => void;
}) {
  const [form, setForm] = useState<Partial<SshSnippet>>(() => ({ label: "", command: "", run: true, kind: "linux", ...snippet }));
  const [tags, setTags] = useState((snippet.tags ?? []).join(", "));
  const typed = splitTags(tags);
  const suggested = knownTags.filter((tag) => !typed.includes(tag));
  const kind = form.kind ?? "linux";
  const [busy, setBusy] = useState(false);
  const [chat, setChat] = useState(false);
  const [opened, setOpened] = useState(false);
  const command = form.command ?? "";

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (chat) setChat(false);
      else onClose();
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [onClose, chat]);

  return (
    <>
      <div className="ssh-drawer-scrim" onPointerDown={onClose} />
      <form
        className="ssh-editor ssh-snippet-drawer"
        aria-labelledby="ssh-snippet-title"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          try {
            await ssh.saveSnippet({ ...form, kind, tags: typed });
            onSaved();
          } catch (error) {
            onError(explain(error));
          } finally {
            setBusy(false);
          }
        }}
      >
        <header className="ssh-editor-head">
          <h3 id="ssh-snippet-title">{snippet.id ? tr("编辑片段", "Edit snippet") : tr("新建片段", "New snippet")}</h3>
          <button type="button" className="icon-button" aria-label={tr("关闭", "Close")} onClick={onClose}>
            <CloseIcon />
          </button>
        </header>
        <div className="ssh-editor-body">
          <Field label={tr("名称", "Name")}>
            <input autoFocus value={form.label ?? ""} placeholder={tr("不填就用命令的第一行", "Defaults to the command's first line")} onChange={(event) => setForm({ ...form, label: event.target.value })} />
          </Field>
          <div className="ssh-field">
            <span className="ssh-field-label">{tr("脚本类型", "Script type")}</span>
            <Select ariaLabel={tr("脚本类型", "Script type")} value={kind} options={KIND_OPTIONS()} onChange={(next) => setForm({ ...form, kind: next as ScriptKind })} />
          </div>
          <div className="ssh-field ssh-command-field">
            <div className="ssh-command-head">
              <label className="ssh-field-label" htmlFor="ssh-snippet-command">
                {tr("命令", "Command")}
              </label>
              <button
                type="button"
                className={chat ? "ssh-ai-toggle is-on" : "ssh-ai-toggle"}
                aria-expanded={chat}
                aria-label={chat ? tr("收起 AI 生成", "Hide AI writing") : tr("AI 生成", "Write with AI")}
                title={chat ? tr("收起 AI 生成", "Hide AI writing") : tr("AI 生成", "Write with AI")}
                onClick={() => {
                  setOpened(true);
                  setChat(!chat);
                }}
              >
                <span className="ssh-ai-spark" aria-hidden="true">
                  <svg width="14" height="14" viewBox="0 0 16 16">
                    <path d="M8 1.5 9.4 6.6 14.5 8 9.4 9.4 8 14.5 6.6 9.4 1.5 8 6.6 6.6Z" fill="currentColor" />
                  </svg>
                </span>
                {tr("AI 生成", "Write with AI")}
              </button>
            </div>
            {/* Folding the chat away keeps what was said, for when it opens again. */}
            {opened && (
              <div className="ssh-ai-fold" hidden={!chat}>
                <AiChat kind={kind} command={command} onWritten={(script) => setForm((current) => ({ ...current, command: script.command, label: current.label?.trim() ? current.label : script.label }))} />
              </div>
            )}
            <textarea
              id="ssh-snippet-command"
              className="ssh-mono ssh-snippet-editor"
              spellCheck={false}
              value={command}
              placeholder={kind === "windows" ? "Get-PSDrive C" : kind === "python" ? "python3 - <<'PY'\nprint('hello')\nPY" : "cd /opt/app && git pull"}
              onChange={(event) => setForm({ ...form, command: event.target.value })}
            />
          </div>
          <div className="ssh-field">
            <label className="ssh-field-label" htmlFor="ssh-snippet-tags">
              {tr("标签（可不填）", "Tags (optional)")}
            </label>
            <input id="ssh-snippet-tags" className="ssh-text-input" value={tags} placeholder={tr("部署, 日志, 数据库", "deploy, logs, database")} onChange={(event) => setTags(event.target.value)} />
            {suggested.length > 0 && (
              <span className="ssh-tag-suggest">
                {suggested.map((tag) => (
                  <button key={tag} type="button" className="ssh-tag-chip" onClick={() => setTags([...typed, tag].join(", "))}>
                    + {tag}
                  </button>
                ))}
              </span>
            )}
          </div>
          <label className="ssh-check">
            <input type="checkbox" checked={form.run !== false} onChange={(event) => setForm({ ...form, run: event.target.checked })} /> {tr("输入后直接回车执行", "Press Enter after typing it")}
          </label>
        </div>
        <footer className="ssh-editor-foot">
          <button type="button" className="quiet-button" onClick={onClose}>
            {tr("取消", "Cancel")}
          </button>
          <span className="ssh-editor-spacer" />
          <button type="submit" className="quiet-button is-primary" disabled={busy || !command.trim()}>
            {busy && <Spinner />}
            {tr("保存片段", "Save snippet")}
          </button>
        </footer>
      </form>
    </>
  );
}

/** When something was last changed, in words: 刚刚, 5 分钟前, 昨天 14:20, 2026-11-02. */
function updatedText(ms?: number): string {
  if (!ms) return tr("更新时间未知", "Update time unknown");
  const now = new Date();
  const at = new Date(ms);
  const minutes = Math.floor((now.getTime() - ms) / 60_000);
  if (minutes < 1) return tr("刚刚更新", "Updated just now");
  if (minutes < 60) return tr(`${minutes} 分钟前更新`, `Updated ${minutes} min ago`);
  const clock = at.toLocaleTimeString(uiLocale(), { hour: "2-digit", minute: "2-digit", hour12: false });
  const day = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  if (days === 0) return tr(`今天 ${clock} 更新`, `Updated today ${clock}`);
  if (days === 1) return tr(`昨天 ${clock} 更新`, `Updated yesterday ${clock}`);
  const date = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
  return tr(`${date} 更新`, `Updated ${date}`);
}

const snippetMark = (snippet: Pick<SshSnippet, "kind">) =>
  snippet.kind ? <span className={`mm-kind-mark is-${snippet.kind}`}>{KIND_MARK[snippet.kind]}</span> : <span className="mm-kind-mark is-snippet">&gt;_</span>;

/** A snippet opened from its card: the command itself, to copy, change or delete. */
function SnippetView({ snippet, onClose, onEdit, onDelete }: { snippet: SshSnippet; onClose: () => void; onEdit: () => void; onDelete: () => void }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [onClose]);
  return (
    <div className="ssh-modal" role="dialog" aria-modal="true" aria-labelledby="ssh-snippet-view-title" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="ssh-modal-card ssh-snippet-view">
        <div className="ssh-snippet-view-head">
          {snippetMark(snippet)}
          <div className="ssh-snippet-view-title">
            <h3 id="ssh-snippet-view-title">{snippet.label}</h3>
            <span>
              {snippet.kind ? tr(`${KIND_LABEL[snippet.kind]} 脚本`, `${KIND_LABEL[snippet.kind]} script`) : tr("未注明类型", "No type given")}
              {tr("，", ", ")}
              {updatedText(snippet.updatedAt)}
              {snippet.run ? "" : tr("，输入后不自动回车", ", typed without pressing Enter")}
            </span>
          </div>
          <button type="button" className="icon-button" aria-label={tr("关闭", "Close")} onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        {snippet.tags.length > 0 && (
          <span className="ssh-tags">
            {snippet.tags.map((tag) => (
              <em key={tag}>{tag}</em>
            ))}
          </span>
        )}
        <div className="ssh-snippet-view-code">
          <pre>{snippet.command}</pre>
          <button
            type="button"
            className="ssh-copy"
            onClick={() => {
              copy(snippet.command);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? tr("已复制", "Copied") : tr("复制", "Copy")}
          </button>
        </div>
        <div className="ssh-modal-actions">
          <button type="button" className="quiet-button is-delete" onClick={onDelete}>
            {tr("删除", "Delete")}
          </button>
          <span className="ssh-editor-spacer" />
          <button type="button" className="quiet-button" onClick={onClose}>
            {tr("关闭", "Close")}
          </button>
          <button type="button" className="quiet-button is-primary" onClick={onEdit}>
            <EditIcon />
            {tr("编辑", "Edit")}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Asks before a snippet goes: shows which one (name, type, the start of its command), says it cannot be undone, and
 * keeps the delete button shut while tasks still run it, naming them, instead of failing after the click.
 */
function SnippetDeleteDialog({ snippet, users, onCancel, onDeleted }: { snippet: SshSnippet; users: SshTask[]; onCancel: () => void; onDeleted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState("");
  const cancel = useRef<HTMLButtonElement>(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  useEffect(() => {
    // Keep and Cancel is the safe answer, so it holds the focus: Enter alone does not delete.
    cancel.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // The snippet's own view may be open underneath; Esc closes only this question.
      event.stopImmediatePropagation();
      onCancelRef.current();
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, []);
  const lines = snippet.command.split(/\r?\n/);
  const preview = lines.slice(0, 4).join("\n");
  const blocked = users.length > 0;
  const confirm = async () => {
    setBusy(true);
    setFailed("");
    try {
      await ssh.deleteSnippet(snippet.id);
      onDeleted();
    } catch (error) {
      setFailed(explain(error));
      setBusy(false);
    }
  };
  return (
    <div className="ssh-modal ssh-confirm-layer" role="alertdialog" aria-modal="true" aria-labelledby="ssh-snippet-delete-title" aria-describedby="ssh-snippet-delete-note" onPointerDown={(event) => event.target === event.currentTarget && !busy && onCancel()}>
      <div className="ssh-modal-card ssh-confirm">
        <div className="ssh-confirm-head">
          <span className="ssh-confirm-mark" aria-hidden="true">
            <TrashIcon />
          </span>
          <div>
            <h3 id="ssh-snippet-delete-title">{tr("删除这个代码片段？", "Delete this snippet?")}</h3>
            <p id="ssh-snippet-delete-note">{blocked ? tr("还有任务在用它，先把这些任务换成别的片段或删掉。", "Tasks still use it. Switch them to another snippet or delete them first.") : tr("删除后无法恢复。", "This cannot be undone.")}</p>
          </div>
        </div>
        <div className="ssh-confirm-item">
          <span className="ssh-confirm-item-top">
            {snippetMark(snippet)}
            <strong>{snippet.label}</strong>
          </span>
          <pre>
            {preview}
            {lines.length > 4 && <span className="ssh-confirm-more">{tr(`\n… 还有 ${lines.length - 4} 行`, `\n… ${lines.length - 4} more lines`)}</span>}
          </pre>
        </div>
        {blocked && (
          <ul className="ssh-confirm-users" aria-label={tr("在用这个片段的任务", "Tasks using this snippet")}>
            {users.map((task) => (
              <li key={task.id}>{task.name}</li>
            ))}
          </ul>
        )}
        {failed && (
          <p className="ssh-confirm-error" role="alert">
            {failed}
          </p>
        )}
        <div className="ssh-modal-actions">
          <button type="button" className="quiet-button" ref={cancel} onClick={onCancel} disabled={busy}>
            {blocked ? tr("知道了", "OK") : tr("取消", "Cancel")}
          </button>
          {!blocked && (
            <button type="button" className="quiet-button is-danger" onClick={() => void confirm()} disabled={busy}>
              {busy ? <Spinner /> : <TrashIcon />}
              {busy ? tr("正在删除", "Deleting") : tr("删除", "Delete")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function SnippetsSection({ state, onChange, onError }: { state: SshState; onChange: () => void; onError: (text: string) => void }) {
  const [form, setForm] = useState<Partial<SshSnippet> | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const closeForm = useCallback(() => setForm(null), []);
  const closeView = useCallback(() => setViewing(null), []);
  const [query, setQuery] = useState("");
  /** The tag picked above the cards; picking it again shows every snippet. */
  const [tag, setTag] = useState<string | null>(null);
  const allTags = useMemo(() => [...new Set(state.snippets.flatMap((snippet) => snippet.tags))].sort((a, b) => a.localeCompare(b)), [state.snippets]);
  // A tag no snippet carries any more stops filtering.
  const picked = tag && allTags.includes(tag) ? tag : null;
  const needle = query.trim().toLowerCase();
  const shown = state.snippets
    .filter((snippet) => !picked || snippet.tags.includes(picked))
    .filter((snippet) => !needle || [snippet.label, snippet.command, ...snippet.tags].some((text) => text.toLowerCase().includes(needle)))
    // Most recently changed first; snippets from before times were kept stay in their order at the end.
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const open = viewing ? state.snippets.find((snippet) => snippet.id === viewing) : undefined;

  /** The snippet waiting on the delete question, if any. */
  const [deleting, setDeleting] = useState<SshSnippet | null>(null);
  const remove = (snippet: SshSnippet) => setDeleting(snippet);
  const cancelDelete = useCallback(() => setDeleting(null), []);

  return (
    <div className="ssh-section">
      <div className="ssh-toolbar">
        <label className="ssh-search">
          <SearchIcon />
          <input placeholder={tr("搜索片段名称、命令或标签", "Search snippet names, commands or tags")} value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <button type="button" className="quiet-button is-primary" onClick={() => setForm({ label: "", command: "", run: true, kind: "linux", tags: [] })}>
          <PlusIcon />
          {tr("新建片段", "New snippet")}
        </button>
      </div>

      {allTags.length > 0 && (
        <div className="ssh-tag-filter" role="group" aria-label={tr("按标签筛选", "Filter by tag")}>
          <button type="button" className={picked ? "ssh-tag-chip" : "ssh-tag-chip is-on"} aria-pressed={!picked} onClick={() => setTag(null)}>
            {tr("全部", "All")}
            <span>{state.snippets.length}</span>
          </button>
          {allTags.map((item) => (
            <button
              key={item}
              type="button"
              className={item === picked ? "ssh-tag-chip is-on" : "ssh-tag-chip"}
              aria-pressed={item === picked}
              onClick={() => setTag(item === picked ? null : item)}
            >
              {item}
              <span>{state.snippets.filter((snippet) => snippet.tags.includes(item)).length}</span>
            </button>
          ))}
        </div>
      )}

      {form && (
        <SnippetDrawer
          key={form.id ?? "new"}
          snippet={form}
          knownTags={allTags}
          onClose={closeForm}
          onSaved={() => {
            setForm(null);
            onChange();
          }}
          onError={onError}
        />
      )}
      {open && (
        <SnippetView
          snippet={open}
          onClose={closeView}
          onEdit={() => {
            setViewing(null);
            setForm(open);
          }}
          onDelete={() => remove(open)}
        />
      )}
      {deleting && (
        <SnippetDeleteDialog
          snippet={deleting}
          users={state.tasks.filter((task) => task.snippetId === deleting.id)}
          onCancel={cancelDelete}
          onDeleted={() => {
            setDeleting(null);
            setViewing(null);
            onChange();
          }}
        />
      )}

      {shown.length === 0 ? (
        <p className="blank">{state.snippets.length ? tr("没有匹配的片段。", "No matching snippets.") : tr("还没有代码片段。点“新建片段”写一个，或让 AI 帮你写。", "No snippets yet. Click New snippet to write one, or let AI write it.")}</p>
      ) : (
        <ul className="ssh-snippet-cards">
          {shown.map((snippet) => (
            <li key={snippet.id}>
              <button type="button" className="ssh-snippet-card" onClick={() => setViewing(snippet.id)} aria-label={tr(`${snippet.label}，查看命令`, `${snippet.label}, view the command`)}>
                <span className="ssh-snippet-card-top">
                  {snippetMark(snippet)}
                  <strong>{snippet.label}</strong>
                </span>
                {snippet.tags.length > 0 ? (
                  <span className="ssh-tags">
                    {snippet.tags.map((item) => (
                      <em key={item}>{item}</em>
                    ))}
                  </span>
                ) : (
                  <span className="ssh-snippet-card-none">{tr("没有标签", "No tags")}</span>
                )}
                <span className="ssh-snippet-card-when">{updatedText(snippet.updatedAt)}</span>
              </button>
              {/* Beside the card, not inside it: a button cannot hold buttons. Shown on hover or keyboard focus. */}
              <span className="ssh-snippet-card-tools">
                <button type="button" className="icon-button" aria-label={tr(`编辑 ${snippet.label}`, `Edit ${snippet.label}`)} title={tr("编辑", "Edit")} onClick={() => setForm(snippet)}>
                  <EditIcon />
                </button>
                <button type="button" className="icon-button is-delete" aria-label={tr(`删除 ${snippet.label}`, `Delete ${snippet.label}`)} title={tr("删除", "Delete")} onClick={() => remove(snippet)}>
                  <TrashIcon />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- tasks

const RUN_WORD = (): Record<SshTaskRun["state"], string> => ({ running: tr("执行中", "Running"), ok: tr("成功", "Succeeded"), failed: tr("失败", "Failed"), stopped: tr("已停止", "Stopped") });

function took(run: SshTaskRun, now: number) {
  const ms = (run.endedAt ?? now) - run.startedAt;
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? tr(`${seconds} 秒`, `${seconds} s`) : tr(`${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`, `${Math.floor(seconds / 60)} min ${seconds % 60} s`);
}

/** The result of a run in a few words: state, exit code, how long. */
function RunBadge({ run, now }: { run: SshTaskRun; now: number }) {
  return (
    <span className={`ssh-run-badge is-${run.state}`}>
      {run.state === "running" && <Spinner />}
      {RUN_WORD()[run.state]}
      {run.exitCode !== undefined && run.state !== "ok" && <em>{tr(`退出码 ${run.exitCode}`, `exit code ${run.exitCode}`)}</em>}
      <em>{took(run, now)}</em>
    </span>
  );
}

/** The output of one run, read again every second while it runs. */
function RunOutput({ runId, onError }: { runId: string; onError: (text: string) => void }) {
  const [run, setRun] = useState<SshTaskRun | null>(null);
  const [now, setNow] = useState(Date.now());
  const box = useRef<HTMLPreElement | null>(null);
  const stuck = useRef(true);
  useEffect(() => {
    let alive = true;
    let timer = 0;
    const read = async () => {
      try {
        const next = await ssh.taskRun(runId);
        if (!alive) return;
        setRun(next);
        setNow(Date.now());
        if (next.state === "running") timer = window.setTimeout(() => void read(), 1000);
      } catch (error) {
        if (alive) onError(explain(error));
      }
    };
    void read();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [runId, onError]);
  // Follows the end of the output unless the person scrolled up to read.
  useEffect(() => {
    const element = box.current;
    if (element && stuck.current) element.scrollTop = element.scrollHeight;
  }, [run?.output]);
  if (!run) return <p className="blank">{tr("正在读取输出…", "Loading output…")}</p>;
  return (
    <div className="ssh-run">
      <div className="ssh-run-head">
        <RunBadge run={run} now={now} />
        <span className="ssh-run-when">{tr(`${when(run.startedAt)} 开始`, `Started ${when(run.startedAt)}`)}</span>
        {run.state === "running" && (
          <button
            type="button"
            className="quiet-button"
            onClick={async () => {
              try {
                await ssh.stopTaskRun(run.id);
              } catch (error) {
                onError(explain(error));
              }
            }}
          >
            <StopIcon />
            {tr("停止", "Stop")}
          </button>
        )}
      </div>
      {run.message && <p className="ssh-run-message">{run.message}</p>}
      <pre
        ref={box}
        className="ssh-run-output"
        onScroll={(event) => {
          const element = event.currentTarget;
          stuck.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
        }}
      >
        {run.truncated && <span className="ssh-run-cut">{tr("…前面的输出太长，已省略", "…earlier output was too long and is left out")}{"\n"}</span>}
        {run.output || (run.state === "running" ? tr("等待输出…", "Waiting for output…") : tr("（没有输出）", "(no output)"))}
      </pre>
    </div>
  );
}

const hostAddress = (host: SshHostView) => `${host.username ? `${host.username}@` : ""}${host.host}${host.port !== 22 ? `:${host.port}` : ""}`;

function TagList({ tags }: { tags: string[] }) {
  if (!tags.length) return null;
  return (
    <span className="ssh-tags">
      {tags.slice(0, 3).map((tag) => (
        <em key={tag}>{tag}</em>
      ))}
    </span>
  );
}

/** A host, shown the way the 主机 page does: colour, name, address; grouped, with tags in the list. */
function HostPicker({ hosts, groups, value, onChange }: { hosts: SshHostView[]; groups: SshGroup[]; value: string; onChange: (id: string) => void }) {
  const options = useMemo(() => {
    const groupName = new Map(groups.map((group) => [group.id, group.name]));
    const nameOf = (host: SshHostView) => (host.groupId ? groupName.get(host.groupId) ?? "" : "");
    return [...hosts]
      .sort((a, b) => nameOf(a).localeCompare(nameOf(b)))
      .map<SelectOption>((host) => ({
        value: host.id,
        label: host.label,
        hint: hostAddress(host),
        icon: <Avatar host={host} />,
        keywords: [host.host, host.username, ...host.tags].join(" "),
        group: nameOf(host) || (groups.length ? tr("未分组", "Ungrouped") : undefined),
        side: <TagList tags={host.tags} />,
      }));
  }, [hosts, groups]);
  return <Select rich ariaLabel={tr("主机", "Host")} placeholder={tr("选择主机", "Choose a host")} searchHint={tr("名称、地址、分组或标签", "Name, address, group or tag")} empty={tr("还没有主机", "No hosts yet")} value={value} onChange={onChange} options={options} />;
}

/** How many lines a snippet has. */
const lineCount = (command: string) => command.replace(/\n+$/, "").split("\n").length;

/** A snippet: its type mark and name, with the first line of its command under it. */
function snippetOption(snippet: SshSnippet): SelectOption {
  const lines = lineCount(snippet.command);
  return {
    value: snippet.id,
    label: snippet.label,
    hint: snippet.command.replace(/\n+$/, "").split("\n")[0],
    icon: snippet.kind ? <span className={`mm-kind-mark is-${snippet.kind}`}>{KIND_MARK[snippet.kind]}</span> : <span className="mm-kind-mark is-snippet">&gt;_</span>,
    keywords: [snippet.command, ...snippet.tags].join(" "),
    side: (
      <>
        {lines > 1 && <span>{tr(`${lines} 行`, `${lines} lines`)}</span>}
        <TagList tags={snippet.tags} />
      </>
    ),
  };
}

function SnippetPicker({ snippets, value, onChange }: { snippets: SshSnippet[]; value: string; onChange: (id: string) => void }) {
  const options = useMemo(() => snippets.map(snippetOption), [snippets]);
  return <Select rich ariaLabel={tr("代码片段", "Snippet")} placeholder={tr("选择代码片段", "Choose a snippet")} searchHint={tr("片段名称、命令或标签", "Snippet name, command or tag")} empty={tr("还没有代码片段", "No snippets yet")} value={value} onChange={onChange} options={options} />;
}

const splitTags = (text: string) => [...new Set(text.split(/[,，\s]+/).map((tag) => tag.trim()).filter(Boolean))];

function TaskDialog({
  state,
  task,
  onClose,
  onSaved,
  onError,
}: {
  state: SshState;
  task: Partial<SshTask>;
  onClose: () => void;
  onSaved: (task: SshTask) => void;
  onError: (text: string) => void;
}) {
  const [form, setForm] = useState<Partial<SshTask>>(() => ({
    hostId: state.hosts[0]?.id ?? "",
    snippetId: state.snippets[0]?.id ?? "",
    dir: "",
    name: "",
    ...task,
  }));
  const [tags, setTags] = useState((task.tags ?? []).join(", "));
  const [busy, setBusy] = useState(false);
  const snippet = state.snippets.find((item) => item.id === form.snippetId);
  const host = state.hosts.find((item) => item.id === form.hostId);
  const typed = splitTags(tags);
  const known = [...new Set(state.tasks.flatMap((item) => item.tags ?? []))].filter((tag) => !typed.includes(tag)).sort((a, b) => a.localeCompare(b));

  useEffect(() => {
    const escape = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [onClose]);

  return (
    <div className="ssh-modal" role="dialog" aria-modal="true" aria-labelledby="ssh-task-title" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <form
        className="ssh-modal-card ssh-task-dialog"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          try {
            onSaved(await ssh.saveTask({ ...form, tags: typed }));
          } catch (error) {
            onError(explain(error));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="ssh-task-dialog-head">
          <h3 id="ssh-task-title">{task.id ? tr("编辑任务", "Edit task") : tr("新建任务", "New task")}</h3>
          <button type="button" className="icon-button" aria-label={tr("关闭", "Close")} onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <Field label={tr("任务名称", "Task name")}>
          <input autoFocus value={form.name ?? ""} placeholder={snippet && host ? `${snippet.label} @ ${host.label}` : tr("如：部署 DNSMgr", "e.g. Deploy DNSMgr")} onChange={(event) => setForm({ ...form, name: event.target.value })} />
        </Field>
        <div className="ssh-field">
          <span className="ssh-field-label">{tr("主机", "Host")}</span>
          <HostPicker hosts={state.hosts} groups={state.groups} value={form.hostId ?? ""} onChange={(hostId) => setForm({ ...form, hostId })} />
        </div>
        <Field label={tr("目录", "Folder")}>
          <input className="ssh-mono" value={form.dir ?? ""} placeholder={tr("/opt/code/my-app，不填就在登录后的默认目录", "/opt/code/my-app; empty uses the default folder after signing in")} onChange={(event) => setForm({ ...form, dir: event.target.value })} />
        </Field>
        <div className="ssh-field">
          <span className="ssh-field-label">{tr("代码片段", "Snippet")}</span>
          <SnippetPicker snippets={state.snippets} value={form.snippetId ?? ""} onChange={(snippetId) => setForm({ ...form, snippetId })} />
        </div>
        {snippet && (
          <div className="ssh-field">
            <span className="ssh-field-label">{tr("执行时", "When run")}</span>
            <pre className="ssh-task-preview">{`${form.dir ? `${snippet.kind === "windows" ? "Set-Location" : "cd"} ${form.dir}\n` : ""}${snippet.command.replace(/\n+$/, "")}`}</pre>
            <span className="ssh-field-hint">{form.dir ? tr("先进入这个目录，进不去就停止；片段里的相对路径都从这里算。", "Enters this folder first and stops if it cannot; relative paths in the snippet start here.") : tr("没填目录：在登录后的默认目录执行。", "No folder: runs in the default folder after signing in.")}</span>
          </div>
        )}
        <div className="ssh-field">
          <label className="ssh-field-label" htmlFor="ssh-task-tags">
            {tr("标签（可不填）", "Tags (optional)")}
          </label>
          <input id="ssh-task-tags" value={tags} placeholder={tr("部署, 生产", "deploy, production")} onChange={(event) => setTags(event.target.value)} />
          {known.length > 0 && (
            <span className="ssh-tag-suggest">
              {known.map((tag) => (
                <button key={tag} type="button" className="ssh-tag-chip" onClick={() => setTags([...typed, tag].join(", "))}>
                  + {tag}
                </button>
              ))}
            </span>
          )}
        </div>
        <div className="ssh-modal-actions">
          <button type="button" className="quiet-button" onClick={onClose}>
            {tr("取消", "Cancel")}
          </button>
          <button type="submit" className="quiet-button is-primary" disabled={busy || !form.hostId || !form.snippetId}>
            {busy && <Spinner />}
            {tr("保存任务", "Save task")}
          </button>
        </div>
      </form>
    </div>
  );
}

function TasksSection({
  state,
  onChange,
  onError,
  onHostKey,
  onSnippets,
  headerSlot = null,
}: {
  state: SshState;
  onChange: () => void;
  onError: (text: string) => void;
  onHostKey: (question: SshHostKeyQuestion, retry: () => void) => void;
  onSnippets: () => void;
  /** Phone: 新建任务 goes into the page's top bar, opposite "SSH 连接", instead of a row of its own. */
  headerSlot?: HTMLElement | null;
}) {
  const [form, setForm] = useState<Partial<SshTask> | null>(null);
  /** The tag picked above the list; picking it again shows every task. */
  const [tag, setTag] = useState<string | null>(null);
  /** The task whose output is open, and which run of it. */
  const [open, setOpen] = useState<{ taskId: string; runId: string } | null>(null);
  const [starting, setStarting] = useState("");
  const [now, setNow] = useState(Date.now());
  const hosts = useMemo(() => new Map(state.hosts.map((host) => [host.id, host])), [state.hosts]);
  const snippets = useMemo(() => new Map(state.snippets.map((snippet) => [snippet.id, snippet])), [state.snippets]);
  const latest = useMemo(() => new Map(state.taskRuns.map((run) => [run.taskId, run])), [state.taskRuns]);
  const anyRunning = state.taskRuns.some((run) => run.state === "running");
  useEffect(() => {
    if (!anyRunning) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [anyRunning]);
  const closeForm = useCallback(() => setForm(null), []);

  const run = async (task: SshTask) => {
    setStarting(task.id);
    try {
      const started = await ssh.runTask(task.id);
      setOpen({ taskId: task.id, runId: started.id });
      onChange();
    } catch (error) {
      const fail = error as Fail;
      if (fail.question) onHostKey(fail.question, () => void run(task));
      else onError(tr(`${task.name}：${explain(error)}`, `${task.name}: ${explain(error)}`));
    } finally {
      setStarting("");
    }
  };

  const tagsOf = (task: SshTask) => task.tags ?? [];
  const allTags = [...new Set(state.tasks.flatMap(tagsOf))].sort((a, b) => a.localeCompare(b));
  // A tag no task carries any more stops filtering.
  const picked = tag && allTags.includes(tag) ? tag : null;
  const shown = state.tasks.filter((task) => !picked || tagsOf(task).includes(picked));
  const missing = !state.hosts.length ? tr("先在“主机”里添加一台主机。", "Add a host under Hosts first.") : !state.snippets.length ? tr("先在“代码片段”里写好要执行的命令。", "Write the command to run under Snippets first.") : "";
  const newTask = (
    <button type="button" className="quiet-button is-primary ssh-new-task" disabled={Boolean(missing)} onClick={() => setForm({})}>
      <PlusIcon />
      {tr("新建任务", "New task")}
    </button>
  );

  return (
    <div className="ssh-section">
      {/* Only what is missing before a task can be made gets a line; the button sits at the right end. */}
      {(missing || !headerSlot) && (
        <div className="ssh-toolbar ssh-task-toolbar">
          {missing ? (
            <p className="ssh-field-hint">
              {missing}
              {!!state.hosts.length && (
                <button type="button" className="link-button" onClick={onSnippets}>
                  {tr("去写代码片段", "Write a snippet")}
                </button>
              )}
            </p>
          ) : (
            <span className="ssh-spacer" />
          )}
          {!headerSlot && newTask}
        </div>
      )}
      {headerSlot && createPortal(newTask, headerSlot)}

      {allTags.length > 0 && (
        <div className="ssh-tag-filter" role="group" aria-label={tr("按标签筛选", "Filter by tag")}>
          <button type="button" className={picked ? "ssh-tag-chip" : "ssh-tag-chip is-on"} aria-pressed={!picked} onClick={() => setTag(null)}>
            {tr("全部", "All")}
            <span>{state.tasks.length}</span>
          </button>
          {allTags.map((item) => (
            <button
              key={item}
              type="button"
              className={item === picked ? "ssh-tag-chip is-on" : "ssh-tag-chip"}
              aria-pressed={item === picked}
              onClick={() => setTag(item === picked ? null : item)}
            >
              {item}
              <span>{state.tasks.filter((task) => tagsOf(task).includes(item)).length}</span>
            </button>
          ))}
        </div>
      )}

      {form && (
        <TaskDialog
          key={form.id ?? "new"}
          state={state}
          task={form}
          onClose={closeForm}
          onSaved={() => {
            setForm(null);
            onChange();
          }}
          onError={onError}
        />
      )}
      {shown.length === 0 ? (
        <p className="blank">{missing ? "" : tr("还没有任务。", "No tasks yet.")}</p>
      ) : (
        <ul className="ssh-tasks">
          {shown.map((task) => {
            const host = hosts.get(task.hostId);
            const snippet = snippets.get(task.snippetId);
            const last = latest.get(task.id);
            const running = last?.state === "running";
            const isOpen = open?.taskId === task.id;
            return (
              <li key={task.id} className={`ssh-task${running ? " is-running" : ""}`}>
                <div className="ssh-task-row">
                  <span className="ssh-task-main">
                    <span className="ssh-task-line">
                      <strong>{task.name}</strong>
                      {tagsOf(task).length > 0 && (
                        <span className="ssh-tags">
                          {tagsOf(task).map((item) => (
                            <em key={item}>{item}</em>
                          ))}
                        </span>
                      )}
                    </span>
                    <span className="ssh-task-where">
                      <span className={host ? "ssh-task-host" : "ssh-task-host is-gone"}>
                        {host ? <Avatar host={host} /> : null}
                        {host ? host.label : tr("主机已删除", "Host deleted")}
                      </span>
                      <code title={task.dir || tr("登录后的默认目录", "The default folder after signing in")}>{task.dir || tr("默认目录", "Default folder")}</code>
                      {!snippet && <span className="ssh-task-gone">{tr("片段已删除", "Snippet deleted")}</span>}
                    </span>
                  </span>
                  <span className="ssh-task-side">
                    {last && (
                      <button
                        type="button"
                        className="ssh-task-last"
                        aria-expanded={isOpen}
                        title={isOpen ? tr("收起输出", "Hide output") : tr("展开输出", "Show output")}
                        onClick={() => setOpen(isOpen ? null : { taskId: task.id, runId: last.id })}
                      >
                        <RunBadge run={last} now={now} />
                        <span className="ssh-task-toggle">
                          {/* ">" turns to point down while the output is open below. */}
                          <ChevronIcon />
                          {isOpen ? tr("收起输出", "Hide output") : tr("展开输出", "Show output")}
                        </span>
                      </button>
                    )}
                    <button
                      type="button"
                      className="ssh-task-run"
                      disabled={running || starting === task.id || !host || !snippet}
                      aria-label={tr(`执行 ${task.name}`, `Run ${task.name}`)}
                      title={running ? tr("正在执行", "Running") : tr("执行", "Run")}
                      onClick={() => void run(task)}
                    >
                      {running || starting === task.id ? <Spinner /> : <PlayIcon />}
                    </button>
                    <button type="button" className="icon-button ssh-task-icon" aria-label={tr(`编辑 ${task.name}`, `Edit ${task.name}`)} title={tr("编辑", "Edit")} onClick={() => setForm(task)}>
                      <EditIcon />
                    </button>
                    <button
                      type="button"
                      className="icon-button ssh-task-icon is-delete"
                      aria-label={tr(`删除 ${task.name}`, `Delete ${task.name}`)}
                      title={tr("删除", "Delete")}
                      onClick={async () => {
                        if (!window.confirm(tr(`删除任务“${task.name}”？${running ? "正在执行的这一次会被停止。" : ""}`, `Delete the task "${task.name}"?${running ? " The run in progress will be stopped." : ""}`))) return;
                        try {
                          await ssh.deleteTask(task.id);
                          if (isOpen) setOpen(null);
                          onChange();
                        } catch (error) {
                          onError(explain(error));
                        }
                      }}
                    >
                      <TrashIcon />
                    </button>
                  </span>
                </div>
                {isOpen && <RunOutput key={open.runId} runId={open.runId} onError={onError} />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- the plugin

type Tab = { kind: "vault" } | { kind: "terminal"; tid: string } | { kind: "sftp"; hostId: string };

export function SshPlugin({ mobile = false, headerSlot = null }: { mobile?: boolean; headerSlot?: HTMLElement | null }) {
  const [state, setState] = useState<SshState | null>(null);
  const [section, setSection] = useState<Section>("hosts");
  const [tab, setTab] = useState<Tab>({ kind: "vault" });
  const [sftpHosts, setSftpHosts] = useState<string[]>([]);
  const [editing, setEditing] = useState<{ host: SshHostView | null; groupId?: string } | null>(null);
  const [error, setError] = useState("");
  const [connecting, setConnecting] = useState("");
  const [question, setQuestion] = useState<{ question: SshHostKeyQuestion; retry: () => void } | null>(null);
  const [snippetMenu, setSnippetMenu] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await ssh.state();
      // A MirrorMix that has not reloaded since 任务 arrived sends no tasks; the page still opens.
      setState({ ...next, tasks: next.tasks ?? [], taskRuns: next.taskRuns ?? [] });
    } catch (caught) {
      setError(explain(caught));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 4000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const showError = useCallback((text: string) => {
    setError(text);
    window.setTimeout(() => setError((current) => (current === text ? "" : current)), 8000);
  }, []);
  const askHostKey = useCallback((next: SshHostKeyQuestion, retry: () => void) => setQuestion({ question: next, retry }), []);

  // A session that ended elsewhere disappears from the tabs.
  useEffect(() => {
    if (tab.kind === "terminal" && state && !state.sessions.some((session) => session.tid === tab.tid)) setTab({ kind: "vault" });
  }, [state, tab]);

  const connect = async (host: SshHostView) => {
    setConnecting(host.id);
    setError("");
    try {
      const session = await ssh.openSession(host.id);
      await refresh();
      setTab({ kind: "terminal", tid: session.tid });
    } catch (caught) {
      const fail = caught as Fail;
      if (fail.question) askHostKey(fail.question, () => void connect(host));
      else showError(tr(`${host.label}：${explain(caught)}`, `${host.label}: ${explain(caught)}`));
    } finally {
      setConnecting("");
    }
  };

  /** Connects and leaves again, asking about an unknown host key first. */
  const testHost = (host: SshHostView): Promise<boolean> =>
    ssh.testHost(host.id).then(
      () => true,
      (caught) => {
        const fail = caught as Fail;
        if (fail.question) {
          return new Promise<boolean>((resolve) => askHostKey(fail.question!, () => void testHost(host).then(resolve)));
        }
        showError(tr(`${host.label}：${explain(caught)}`, `${host.label}: ${explain(caught)}`));
        return false;
      },
    );

  const openSftp = (host: SshHostView) => {
    setSftpHosts((current) => (current.includes(host.id) ? current : [...current, host.id]));
    setTab({ kind: "sftp", hostId: host.id });
  };

  const closeTerminal = async (tid: string) => {
    try {
      await ssh.closeSession(tid);
    } catch {
      /* already gone */
    }
    if (tab.kind === "terminal" && tab.tid === tid) setTab({ kind: "vault" });
    void refresh();
  };

  const hostsById = useMemo(() => new Map((state?.hosts ?? []).map((host) => [host.id, host])), [state?.hosts]);
  const currentSession = tab.kind === "terminal" ? state?.sessions.find((session) => session.tid === tab.tid) : undefined;
  const currentSftpHost = tab.kind === "sftp" ? hostsById.get(tab.hostId) : undefined;

  if (!state) {
    return <div className="ssh">{error ? <p className="banner is-warning">{error}</p> : <p className="blank">{tr("正在读取…", "Loading…")}</p>}</div>;
  }

  return (
    <div className={mobile ? "ssh is-mobile" : "ssh"}>
      {/* On a phone the strip appears only once a terminal or SFTP tab is open: a lone 主机库 tab says nothing. */}
      {(!mobile || state.sessions.length > 0 || sftpHosts.length > 0 || connecting) && (
      <div className="ssh-tabs" role="tablist" aria-label="SSH">
        <button type="button" role="tab" aria-selected={tab.kind === "vault"} className={tab.kind === "vault" ? "ssh-tab active" : "ssh-tab"} onClick={() => setTab({ kind: "vault" })}>
          {tr("主机库", "Hosts")}
        </button>
        {state.sessions.map((session, index) => {
          const host = hostsById.get(session.hostId);
          const active = tab.kind === "terminal" && tab.tid === session.tid;
          const same = state.sessions.filter((item) => item.hostId === session.hostId);
          const number = same.length > 1 ? ` ${same.indexOf(session) + 1}` : "";
          return (
            <span key={session.tid} className={active ? "ssh-tab active" : "ssh-tab"}>
              <button type="button" role="tab" aria-selected={active} onClick={() => setTab({ kind: "terminal", tid: session.tid })}>
                <span className="ssh-tab-dot" style={{ background: host?.color ?? "var(--signal)" }} />
                {session.label}
                {number}
              </button>
              <button type="button" className="ssh-tab-close" aria-label={tr(`关闭 ${session.label}`, `Close ${session.label}`)} onClick={() => void closeTerminal(session.tid)}>
                <CloseIcon />
              </button>
            </span>
          );
        })}
        {sftpHosts.map((hostId) => {
          const host = hostsById.get(hostId);
          if (!host) return null;
          const active = tab.kind === "sftp" && tab.hostId === hostId;
          return (
            <span key={`sftp-${hostId}`} className={active ? "ssh-tab active" : "ssh-tab"}>
              <button type="button" role="tab" aria-selected={active} onClick={() => setTab({ kind: "sftp", hostId })}>
                <FolderIcon />
                {host.label}
              </button>
              <button
                type="button"
                className="ssh-tab-close"
                aria-label={tr(`关闭 ${host.label} 的 SFTP`, `Close ${host.label}'s SFTP`)}
                onClick={() => {
                  setSftpHosts((current) => current.filter((item) => item !== hostId));
                  if (active) setTab({ kind: "vault" });
                }}
              >
                <CloseIcon />
              </button>
            </span>
          );
        })}
        {connecting && (
          <span className="ssh-tab is-pending">
            <Spinner />
            {tr(`正在连接 ${hostsById.get(connecting)?.label ?? ""}`, `Connecting ${hostsById.get(connecting)?.label ?? ""}`)}
          </span>
        )}
      </div>
      )}

      {error && (
        <p className="banner is-warning ssh-banner" role="alert">
          {error}
        </p>
      )}

      {tab.kind === "vault" && (
        <div className="ssh-vault">
          <nav className="ssh-nav" aria-label={tr("主机库", "Hosts")}>
            {SECTIONS().map(([key, label]) => (
              <button key={key} type="button" className={section === key ? "active" : ""} aria-current={section === key ? "page" : undefined} onClick={() => setSection(key)}>
                {label}
                <span className="ssh-nav-count">
                  {key === "hosts"
                    ? state.hosts.length
                    : key === "keychain"
                      ? state.keys.length + state.identities.length
                      : key === "tasks"
                        ? state.tasks.length
                        : state.snippets.length}
                </span>
              </button>
            ))}
          </nav>
          <div className="ssh-main">
            {section === "hosts" && (
              <HostsSection
                state={state}
                onConnect={(host) => void connect(host)}
                onEdit={(host) => setEditing({ host })}
                onNew={(groupId) => setEditing({ host: null, groupId })}
                onChange={() => void refresh()}
                onError={showError}
              />
            )}
            {section === "keychain" && <KeychainSection state={state} onChange={() => void refresh()} onError={showError} />}
            {section === "snippets" && <SnippetsSection state={state} onChange={() => void refresh()} onError={showError} />}
            {section === "tasks" && (
              <TasksSection
                state={state}
                onChange={() => void refresh()}
                onError={showError}
                onHostKey={askHostKey}
                onSnippets={() => setSection("snippets")}
                headerSlot={mobile ? headerSlot : null}
              />
            )}
          </div>
          {editing && (
            <HostEditor
              state={state}
              host={editing.host}
              groupId={editing.groupId}
              onClose={() => setEditing(null)}
              onSaved={() => {
                setEditing(null);
                void refresh();
              }}
              onTest={editing.host ? () => testHost(editing.host!) : undefined}
              onDuplicate={
                editing.host
                  ? async () => {
                      try {
                        const copy = await ssh.duplicateHost(editing.host!.id);
                        await refresh();
                        setEditing({ host: copy });
                      } catch (caught) {
                        showError(explain(caught));
                      }
                    }
                  : undefined
              }
              onSftp={
                editing.host
                  ? () => {
                      const host = editing.host!;
                      setEditing(null);
                      openSftp(host);
                    }
                  : undefined
              }
              onDelete={
                editing.host
                  ? async () => {
                      const target = editing.host!;
                      if (!window.confirm(tr(`删除主机“${target.label}”？它的终端、SFTP 和端口转发规则也会一起关闭和删除。`, `Delete the host "${target.label}"? Its terminals, SFTP and port forwarding rules are closed and deleted too.`))) return;
                      try {
                        await ssh.deleteHost(target.id);
                        setEditing(null);
                        setSftpHosts((current) => current.filter((item) => item !== target.id));
                        void refresh();
                      } catch (caught) {
                        showError(explain(caught));
                      }
                    }
                  : undefined
              }
            />
          )}
        </div>
      )}

      {tab.kind === "terminal" && currentSession && (
        <div className="ssh-terminal">
          <div className="ssh-terminal-bar">
            <span className="ssh-terminal-title">
              {(() => {
                const host = hostsById.get(currentSession.hostId);
                return host ? `${host.username ? `${host.username}@` : ""}${host.host}${host.port !== 22 ? `:${host.port}` : ""}` : currentSession.label;
              })()}
            </span>
            <span className="ssh-spacer" />
            <span className="ssh-menu-wrap">
              <button type="button" className="quiet-button" aria-expanded={snippetMenu} onClick={() => setSnippetMenu((open) => !open)}>
                {tr("片段", "Snippets")}
              </button>
              {snippetMenu && (
                <div className="ssh-menu" role="menu">
                  {state.snippets.length === 0 ? (
                    <p className="blank">{tr("还没有片段，到“主机库 → 代码片段”添加。", "No snippets yet; add them under Hosts → Snippets.")}</p>
                  ) : (
                    state.snippets.map((snippet) => (
                      <button
                        key={snippet.id}
                        type="button"
                        role="menuitem"
                        onClick={async () => {
                          setSnippetMenu(false);
                          try {
                            await ssh.runSnippet(currentSession.tid, snippet.id);
                          } catch (caught) {
                            showError(explain(caught));
                          }
                        }}
                      >
                        <strong>{snippet.label}</strong>
                        <code>{snippet.command.split("\n")[0]}</code>
                      </button>
                    ))
                  )}
                </div>
              )}
            </span>
            <button
              type="button"
              className="quiet-button"
              onClick={() => {
                const host = hostsById.get(currentSession.hostId);
                if (host) openSftp(host);
              }}
            >
              SFTP
            </button>
            <button
              type="button"
              className="quiet-button"
              onClick={() => {
                const host = hostsById.get(currentSession.hostId);
                if (host) void connect(host);
              }}
            >
              {tr("再开一个", "Open another")}
            </button>
          </div>
          <SshScreen key={currentSession.tid} tid={currentSession.tid} mobile={mobile} onGone={() => void refresh()} />
        </div>
      )}

      {tab.kind === "sftp" && currentSftpHost && (
        <SftpPanel key={currentSftpHost.id} host={currentSftpHost} onError={showError} onHostKey={askHostKey} />
      )}

      {question && (
        <HostKeyDialog
          question={question.question}
          onCancel={() => setQuestion(null)}
          onTrust={async () => {
            const { question: asked, retry } = question;
            setQuestion(null);
            try {
              await ssh.trust(asked);
              retry();
            } catch (caught) {
              showError(explain(caught));
            }
          }}
        />
      )}
    </div>
  );
}
