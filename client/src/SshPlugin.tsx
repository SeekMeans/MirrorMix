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
} from "../../src/shared/ssh";
import { apiFetch, apiRequest } from "./api";
import { CloseIcon, EditIcon, FileIcon, FolderIcon, PlusIcon, RefreshIcon, SearchIcon, ShieldQuestionIcon, Spinner, UpIcon } from "./icons";

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

const MESSAGES: Record<string, string> = {
  host_required: "请填写主机地址。",
  bad_host: "主机地址里不能有空格。",
  bad_port: "端口要在 1–65535 之间。",
  key_required: "选择一把密钥，或者改用密码登录。",
  identity_required: "选择一个身份。",
  username_required: "请填写用户名。",
  unknown_host: "这台主机已经不在了，刷新一下。",
  jump_loop: "跳板机绕回了自己，换一台跳板机。",
  auth_failed: "登录被拒绝：用户名、密码或密钥不对。",
  timeout: "连接超时，检查地址、端口和网络。",
  host_not_found: "找不到这个主机名，检查地址拼写或 DNS。",
  connection_refused: "对方拒绝连接：端口没开或 SSH 服务没运行。",
  connect_failed: "连不上这台主机。",
  jump_failed: "跳板机连上了，但它到不了目标主机。",
  agent_failed: "没连上 SSH Agent：先在 Windows 里启动 OpenSSH Authentication Agent 服务，或打开 Pageant。",
  shell_failed: "连上了，但对方没有开出终端。",
  too_many_sessions: "这台主机已经开了 8 个终端，先关掉几个。",
  bad_key: "这不是一把能识别的私钥。",
  needs_passphrase: "这把密钥有口令保护，请填写口令。",
  bad_passphrase: "密钥口令不对。",
  not_private_key: "这是公钥，请粘贴私钥。",
  key_in_use: "还有主机或身份在用这把密钥，先换掉再删除。",
  key_file_missing: "密钥文件找不到了（它是从 ~/.ssh 引用的）。",
  identity_in_use: "还有主机在用这个身份，先换掉再删除。",
  command_required: "请填写命令。",
  no_ssh_config: "没有找到 ~/.ssh/config。",
  not_found: "文件或文件夹不存在。",
  permission_denied: "没有权限。",
  is_directory: "这是文件夹，不能下载。",
  sftp_failed: "SFTP 打不开：对方可能没有启用 SFTP。",
  bad_mode: "权限要写成 755 这样的八进制数字。",
  group_loop: "分组不能放进自己的子分组。",
};
const explain = (error: unknown) => {
  const code = (error as Fail)?.code ?? "";
  return MESSAGES[code] ?? (code ? `操作失败（${code}）` : "操作失败，稍后再试。");
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

const when = (ms?: number) => (ms ? new Date(ms).toLocaleString("zh-CN", { hour12: false }) : "—");

// ---------------------------------------------------------------- host key question

function HostKeyDialog({ question, onTrust, onCancel }: { question: SshHostKeyQuestion; onTrust: () => void; onCancel: () => void }) {
  return (
    <div className="ssh-modal" role="alertdialog" aria-labelledby="ssh-hostkey-title">
      <div className="ssh-modal-card">
        <h3 id="ssh-hostkey-title">{question.previous ? "主机密钥变了" : "第一次连接这台主机"}</h3>
        {question.previous ? (
          <p className="ssh-warning">
            {question.address} 的主机密钥和之前保存的不一样。可能是服务器重装了，也可能有人在中间冒充它。确认是你自己换的再继续。
          </p>
        ) : (
          <p>确认下面的指纹和服务器上 <code>ssh-keygen -lf /etc/ssh/ssh_host_*_key.pub</code> 显示的一致，再信任它。</p>
        )}
        <dl className="ssh-hostkey">
          <dt>主机</dt>
          <dd>{question.address}</dd>
          <dt>类型</dt>
          <dd>{question.keyType}</dd>
          <dt>指纹</dt>
          <dd>
            <code>{question.fingerprint}</code>
          </dd>
          {question.previous && (
            <>
              <dt>之前的</dt>
              <dd>
                <code>{question.previous}</code>
              </dd>
            </>
          )}
        </dl>
        <div className="ssh-modal-actions">
          <button type="button" className="quiet-button" onClick={onCancel}>
            取消
          </button>
          <button type="button" className={question.previous ? "quiet-button is-danger" : "quiet-button is-primary"} onClick={onTrust}>
            {question.previous ? "替换并连接" : "信任并连接"}
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
          term.write("\r\n\x1b[90m[连接已结束]\x1b[0m\r\n");
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
          <div className="cmd-line-keys" aria-label="快捷键">
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
              aria-label="要执行的命令"
              placeholder={ready ? "输入命令，回车执行" : "正在连接 SSH"}
              value={line}
              enterKeyHint="send"
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setLine(event.target.value)}
            />
            <button type="submit" disabled={!ready}>执行</button>
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
      setUploading(`正在上传 ${index + 1}/${list.length}：${file.name}`);
      try {
        await ssh.sftpUpload(host.id, join(dir, file.name), file);
      } catch (error) {
        onError(`${file.name}：${explain(error)}`);
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
        <button type="button" className="icon-button" title="上一级" disabled={!dir || dir === "/"} onClick={() => void load(parent(dir))}>
          <UpIcon />
        </button>
        <nav className="sftp-crumbs" aria-label="路径">
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
          <input className="ssh-search-input" placeholder="筛选" value={filter} onChange={(event) => setFilter(event.target.value)} />
          <button type="button" className="icon-button" title="刷新" onClick={() => void load(dir)}>
            {busy ? <Spinner /> : <RefreshIcon />}
          </button>
          <button
            type="button"
            className="quiet-button"
            onClick={() => {
              const name = window.prompt("新文件夹名称");
              if (name?.trim()) void act(() => ssh.sftpMkdir(host.id, join(dir, name.trim())));
            }}
          >
            新建文件夹
          </button>
          <button type="button" className="quiet-button is-primary" onClick={() => fileInput.current?.click()}>
            上传
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
      <div className="sftp-table" role="table" aria-label={`${host.label} 的文件`}>
        <div className="sftp-row sftp-head" role="row">
          <span>名称</span>
          <span>大小</span>
          <span>修改时间</span>
          <span>权限</span>
          <span />
        </div>
        {entries === null ? (
          <p className="blank">{busy ? "正在打开…" : "没有打开"}</p>
        ) : shown.length === 0 ? (
          <p className="blank">{filter ? "没有匹配的文件" : "空文件夹。把文件拖到这里即可上传。"}</p>
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
                  {entry.link && <em className="sftp-link">链接</em>}
                </span>
                <span>{entry.dir ? "—" : size(entry.size)}</span>
                <span>{when(entry.mtime)}</span>
                <span className="sftp-mode">{entry.mode}</span>
                <span className="sftp-actions">
                  {!entry.dir && (
                    <a className="quiet-button" href={ssh.downloadUrl(host.id, full)} download={entry.name}>
                      下载
                    </a>
                  )}
                  <button
                    type="button"
                    className="quiet-button"
                    onClick={() => {
                      const name = window.prompt("新名称", entry.name);
                      if (name?.trim() && name.trim() !== entry.name) void act(() => ssh.sftpRename(host.id, full, join(dir, name.trim())));
                    }}
                  >
                    重命名
                  </button>
                  <button
                    type="button"
                    className="quiet-button"
                    onClick={() => {
                      const mode = window.prompt("权限（八进制，例如 755）", "");
                      if (mode?.trim()) void act(() => ssh.sftpChmod(host.id, full, mode.trim()));
                    }}
                  >
                    权限
                  </button>
                  <button
                    type="button"
                    className="quiet-button is-danger"
                    onClick={() => {
                      if (window.confirm(entry.dir ? `删除文件夹“${entry.name}”和里面的所有内容？不能恢复。` : `删除“${entry.name}”？不能恢复。`)) {
                        void act(() => ssh.sftpRemove(host.id, full));
                      }
                    }}
                  >
                    删除
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

const AUTH_LABEL: Record<SshAuth, string> = { password: "密码", key: "密钥", identity: "身份", agent: "SSH Agent" };

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
        <h3>{host ? "编辑主机" : "新建主机"}</h3>
        <button type="button" className="icon-button" aria-label="关闭" onClick={onClose}>
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
                if (ok) setTested("连接正常");
              }}
            >
              {testing && <Spinner />}测试连接
            </button>
            {onDuplicate && (
              <button type="button" className="quiet-button" onClick={onDuplicate}>
                复制一份
              </button>
            )}
            {onSftp && (
              <button type="button" className="quiet-button" onClick={onSftp}>
                打开 SFTP
              </button>
            )}
            {tested && <span className="ssh-editor-ok">{tested}</span>}
          </div>
        )}
        <Field label="地址">
          <input required autoFocus={!host} placeholder="example.com 或 10.0.0.5" value={form.host} onChange={(event) => set({ host: event.target.value })} />
        </Field>
        <div className="ssh-field-row">
          <Field label="名称">
            <input placeholder="不填就用地址" value={form.label} onChange={(event) => set({ label: event.target.value })} />
          </Field>
          <Field label="端口">
            <input type="number" min={1} max={65535} value={form.port ?? 22} onChange={(event) => set({ port: Number(event.target.value) })} />
          </Field>
        </div>
        <Field label="标签">
          <input placeholder="生产, 数据库" value={tags} onChange={(event) => setTags(event.target.value)} />
        </Field>
        <Field label="颜色">
          <span className="ssh-colors">
            {COLORS.map((color) => (
              <button
                key={color}
                type="button"
                className={form.color === color ? "ssh-color is-on" : "ssh-color"}
                style={{ background: color }}
                aria-label={`颜色 ${color}`}
                onClick={() => set({ color: form.color === color ? null : color })}
              />
            ))}
          </span>
        </Field>

        <fieldset className="ssh-fieldset">
          <legend>登录</legend>
          <div className="theme-choice ssh-auth" role="radiogroup" aria-label="登录方式">
            {(Object.keys(AUTH_LABEL) as SshAuth[]).map((auth) => (
              <button key={auth} type="button" role="radio" aria-checked={form.auth === auth} className={form.auth === auth ? "active" : ""} onClick={() => set({ auth })}>
                {AUTH_LABEL[auth]}
              </button>
            ))}
          </div>
          {form.auth !== "identity" && (
            <Field label="用户名">
              <input value={form.username ?? ""} onChange={(event) => set({ username: event.target.value })} />
            </Field>
          )}
          {form.auth === "password" && (
            <Field label="密码" hint={host?.hasPassword ? "已保存。留空则不修改。" : "加密保存在这台电脑上，只有你的 Windows 账户能解开。"}>
              <input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} />
              {host?.hasPassword && (
                <label className="ssh-check">
                  <input type="checkbox" checked={clearPassword} onChange={(event) => setClearPassword(event.target.checked)} /> 删除已保存的密码
                </label>
              )}
            </Field>
          )}
          {form.auth === "key" && (
            <Field label="密钥" hint={state.keys.length ? undefined : "钥匙串里还没有密钥，先到“钥匙串”生成或导入一把。"}>
              <select value={form.keyId ?? ""} onChange={(event) => set({ keyId: event.target.value || null })}>
                <option value="">选择密钥</option>
                {state.keys.map((key) => (
                  <option key={key.id} value={key.id}>
                    {key.label}（{key.type}）
                  </option>
                ))}
              </select>
            </Field>
          )}
          {form.auth === "identity" && (
            <Field label="身份" hint={state.identities.length ? undefined : "还没有身份，先到“钥匙串”添加。"}>
              <select value={form.identityId ?? ""} onChange={(event) => set({ identityId: event.target.value || null })}>
                <option value="">选择身份</option>
                {state.identities.map((identity) => (
                  <option key={identity.id} value={identity.id}>
                    {identity.label}（{identity.username}）
                  </option>
                ))}
              </select>
            </Field>
          )}
          {form.auth === "agent" && <p className="ssh-field-hint">使用 Windows 的 OpenSSH Authentication Agent（或 Pageant）里已经加载的密钥。</p>}
        </fieldset>

        <fieldset className="ssh-fieldset">
          <legend>高级</legend>
          <Field label="连接后运行" hint="终端打开后自动输入的代码片段。">
            <select value={form.startupSnippetId ?? ""} onChange={(event) => set({ startupSnippetId: event.target.value || null })}>
              <option value="">不运行</option>
              {state.snippets.map((snippet) => (
                <option key={snippet.id} value={snippet.id}>
                  {snippet.label}
                </option>
              ))}
            </select>
          </Field>
          <div className="ssh-field-row">
            <Field label="保活（秒）">
              <input type="number" min={0} max={600} value={form.keepAlive ?? 30} onChange={(event) => set({ keepAlive: Number(event.target.value) })} />
            </Field>
            <Field label="退格键发送">
              <select value={form.backspace ?? "del"} onChange={(event) => set({ backspace: event.target.value === "bs" ? "bs" : "del" })}>
                <option value="del">DEL（多数系统）</option>
                <option value="bs">Ctrl+H</option>
              </select>
            </Field>
          </div>
          <Field label="备注">
            <textarea rows={3} value={form.notes ?? ""} onChange={(event) => set({ notes: event.target.value })} />
          </Field>
        </fieldset>
        {error && <p className="banner is-warning">{error}</p>}
      </div>
      <footer className="ssh-editor-foot">
        {host && onDelete && (
          <button type="button" className="quiet-button is-danger" onClick={onDelete}>
            删除主机
          </button>
        )}
        <span className="ssh-spacer" />
        <button type="button" className="quiet-button" onClick={onClose}>
          取消
        </button>
        <button type="submit" className="quiet-button is-primary" disabled={busy}>
          {busy && <Spinner />}保存
        </button>
      </footer>
    </form>
  );
}

// ---------------------------------------------------------------- vault sections

type Section = "hosts" | "keychain" | "snippets";
const SECTIONS: Array<[Section, string]> = [
  ["hosts", "主机"],
  ["keychain", "钥匙串"],
  ["snippets", "代码片段"],
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
      <button type="button" className="ssh-host-main" title="连接" onClick={() => onConnect(host)}>
        <Avatar host={host} />
        <span className="ssh-host-text">
          <strong>
            {host.label}
            {!state.knownHosts.some((known) => known.address === `${host.host}:${host.port}`) && (
              <span className="ssh-host-unverified" title="还没确认过这台主机的密钥：第一次连接时会请你核对指纹" aria-label="主机密钥未确认">
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
      <button type="button" className="ssh-host-edit" aria-label={`编辑 ${host.label}`} title="编辑" onClick={() => onEdit(host)}>
        <EditIcon />
      </button>
    </li>
  );

  return (
    <div className="ssh-section">
      <div className="ssh-toolbar">
        <label className="ssh-search">
          <SearchIcon />
          <input placeholder="搜索名称、地址、用户或标签" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <button type="button" className="quiet-button is-primary" onClick={() => onNew()}>
          <PlusIcon />
          新建主机
        </button>
        <button
          type="button"
          className="quiet-button"
          title="读取 ~/.ssh/config 里的 Host"
          onClick={async () => {
            try {
              const result = await ssh.importConfig();
              setNotice(`从 ~/.ssh/config 导入了 ${result.hosts} 台主机、${result.keys} 把密钥${result.skipped.length ? `，${result.skipped.length} 台已存在` : ""}。`);
              onChange();
            } catch (error) {
              onError(explain(error));
            }
          }}
        >
          导入 ~/.ssh/config
        </button>
      </div>
      {notice && <p className="banner">{notice}</p>}

      {allTags.length > 0 && (
        <div className="ssh-tag-filter" role="group" aria-label="按标签筛选">
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
          <p>{state.hosts.length ? "没有匹配的主机。" : "还没有主机。新建一台，或者从 ~/.ssh/config 导入。"}</p>
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
        <h4 className="ssh-title">密钥</h4>
        <button type="button" className="quiet-button is-primary" onClick={() => setMode("generate")}>
          生成密钥
        </button>
        <button type="button" className="quiet-button" onClick={() => setMode("import")}>
          导入私钥
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
            <Field label="名称">
              <input autoFocus placeholder="例如 laptop" value={label} onChange={(event) => setLabel(event.target.value)} />
            </Field>
            <Field label="类型">
              <select value={type} onChange={(event) => setType(event.target.value)}>
                <option value="ed25519">Ed25519（推荐）</option>
                <option value="ecdsa">ECDSA</option>
                <option value="rsa">RSA</option>
              </select>
            </Field>
            {type === "rsa" && (
              <Field label="位数">
                <select value={bits} onChange={(event) => setBits(Number(event.target.value))}>
                  <option value={4096}>4096</option>
                  <option value={2048}>2048</option>
                </select>
              </Field>
            )}
          </div>
          <Field label="口令（可选）" hint="给私钥再加一层保护。">
            <input type="password" autoComplete="new-password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} />
          </Field>
          <div className="ssh-form-actions">
            <button type="button" className="quiet-button" onClick={reset}>
              取消
            </button>
            <button type="submit" className="quiet-button is-primary" disabled={busy}>
              {busy && <Spinner />}生成
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
          <Field label="名称">
            <input autoFocus value={label} onChange={(event) => setLabel(event.target.value)} />
          </Field>
          <Field label="私钥" hint="粘贴 OpenSSH 或 PEM 格式的私钥，或选择文件。">
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
          <Field label="口令（如果有）">
            <input type="password" autoComplete="new-password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} />
          </Field>
          <div className="ssh-form-actions">
            <button type="button" className="quiet-button" onClick={reset}>
              取消
            </button>
            <button type="submit" className="quiet-button is-primary" disabled={busy || !privateKey.trim()}>
              {busy && <Spinner />}导入
            </button>
          </div>
        </form>
      )}

      {state.keys.length === 0 ? (
        <p className="blank">钥匙串里还没有密钥。</p>
      ) : (
        <ul className="ssh-list">
          {state.keys.map((key: SshKeyView) => (
            <li key={key.id} className="ssh-list-row">
              <span className="ssh-list-main">
                <strong>{key.label}</strong>
                <span>
                  {key.type} · {key.fingerprint}
                  {key.hasPassphrase ? " · 有口令" : ""}
                  {key.file ? ` · 引用 ${key.file}` : ""}
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
                  {copied === key.id ? "已复制" : "复制公钥"}
                </button>
                <a className="quiet-button" href={ssh.privateKeyUrl(key.id)} onClick={(event) => !window.confirm("导出私钥文件？拿到它的人可以登录这把钥匙能登录的所有主机。") && event.preventDefault()}>
                  导出私钥
                </a>
                <button
                  type="button"
                  className="quiet-button"
                  onClick={async () => {
                    const name = window.prompt("密钥名称", key.label);
                    if (!name?.trim()) return;
                    try {
                      await ssh.renameKey(key.id, name.trim());
                      onChange();
                    } catch (error) {
                      onError(explain(error));
                    }
                  }}
                >
                  重命名
                </button>
                <button
                  type="button"
                  className="quiet-button is-danger"
                  onClick={() => window.confirm(`从钥匙串删除“${key.label}”？${key.file ? "原文件不会被删除。" : "删除后无法找回，除非你另有备份。"}`) && void run(() => ssh.deleteKey(key.id))}
                >
                  删除
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="ssh-toolbar ssh-toolbar-gap">
        <h4 className="ssh-title">身份</h4>
        <span className="ssh-field-hint">一组用户名和密码（或密钥），多台主机可以共用。</span>
        <button type="button" className="quiet-button" onClick={() => setMode("identity")}>
          添加身份
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
            <Field label="名称">
              <input value={identity.label} onChange={(event) => setIdentity({ ...identity, label: event.target.value })} />
            </Field>
            <Field label="用户名">
              <input required value={identity.username} onChange={(event) => setIdentity({ ...identity, username: event.target.value })} />
            </Field>
          </div>
          <div className="ssh-field-row">
            <Field label="密码" hint={identity.id ? "留空则不修改。" : undefined}>
              <input type="password" autoComplete="new-password" value={identity.password} onChange={(event) => setIdentity({ ...identity, password: event.target.value })} />
            </Field>
            <Field label="密钥">
              <select value={identity.keyId} onChange={(event) => setIdentity({ ...identity, keyId: event.target.value })}>
                <option value="">不用密钥</option>
                {state.keys.map((key) => (
                  <option key={key.id} value={key.id}>
                    {key.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="ssh-form-actions">
            <button type="button" className="quiet-button" onClick={reset}>
              取消
            </button>
            <button type="submit" className="quiet-button is-primary" disabled={busy}>
              保存
            </button>
          </div>
        </form>
      )}
      {state.identities.length === 0 ? (
        <p className="blank">还没有身份。</p>
      ) : (
        <ul className="ssh-list">
          {state.identities.map((item) => (
            <li key={item.id} className="ssh-list-row">
              <span className="ssh-list-main">
                <strong>{item.label}</strong>
                <span>
                  {item.username}
                  {item.hasPassword ? " · 已存密码" : ""}
                  {item.keyId ? ` · 密钥 ${state.keys.find((key) => key.id === item.keyId)?.label ?? ""}` : ""}
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
                  编辑
                </button>
                <button type="button" className="quiet-button is-danger" onClick={() => window.confirm(`删除身份“${item.label}”？`) && void run(() => ssh.deleteIdentity(item.id))}>
                  删除
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SnippetsSection({ state, onChange, onError }: { state: SshState; onChange: () => void; onError: (text: string) => void }) {
  const [form, setForm] = useState<Partial<SshSnippet> | null>(null);
  const [query, setQuery] = useState("");
  const shown = state.snippets.filter((snippet) => !query || `${snippet.label} ${snippet.command}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <div className="ssh-section">
      <div className="ssh-toolbar">
        <label className="ssh-search">
          <SearchIcon />
          <input placeholder="搜索代码片段" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <button type="button" className="quiet-button is-primary" onClick={() => setForm({ label: "", command: "", run: true })}>
          <PlusIcon />
          新建片段
        </button>
      </div>
      <p className="ssh-field-hint">在终端上方的“片段”菜单里一点就输入到当前终端；也可以设为某台主机“连接后运行”。</p>
      {form && (
        <form
          className="ssh-inline-form"
          onSubmit={async (event) => {
            event.preventDefault();
            try {
              await ssh.saveSnippet(form);
              setForm(null);
              onChange();
            } catch (error) {
              onError(explain(error));
            }
          }}
        >
          <Field label="名称">
            <input autoFocus value={form.label ?? ""} onChange={(event) => setForm({ ...form, label: event.target.value })} />
          </Field>
          <Field label="命令" hint="可以多行。">
            <textarea rows={5} className="ssh-mono" value={form.command ?? ""} onChange={(event) => setForm({ ...form, command: event.target.value })} />
          </Field>
          <label className="ssh-check">
            <input type="checkbox" checked={form.run !== false} onChange={(event) => setForm({ ...form, run: event.target.checked })} /> 输入后直接回车执行
          </label>
          <div className="ssh-form-actions">
            <button type="button" className="quiet-button" onClick={() => setForm(null)}>
              取消
            </button>
            <button type="submit" className="quiet-button is-primary">
              保存
            </button>
          </div>
        </form>
      )}
      {shown.length === 0 ? (
        <p className="blank">{state.snippets.length ? "没有匹配的片段。" : "还没有代码片段。"}</p>
      ) : (
        <ul className="ssh-list">
          {shown.map((snippet) => (
            <li key={snippet.id} className="ssh-list-row">
              <span className="ssh-list-main">
                <strong>{snippet.label}</strong>
                <code className="ssh-snippet-code">{snippet.command}</code>
              </span>
              <span className="ssh-row-actions">
                <button type="button" className="quiet-button" onClick={() => setForm(snippet)}>
                  编辑
                </button>
                <button
                  type="button"
                  className="quiet-button is-danger"
                  onClick={async () => {
                    if (!window.confirm(`删除片段“${snippet.label}”？`)) return;
                    try {
                      await ssh.deleteSnippet(snippet.id);
                      onChange();
                    } catch (error) {
                      onError(explain(error));
                    }
                  }}
                >
                  删除
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- the plugin

type Tab = { kind: "vault" } | { kind: "terminal"; tid: string } | { kind: "sftp"; hostId: string };

export function SshPlugin({ mobile = false }: { mobile?: boolean }) {
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
      setState(await ssh.state());
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
      else showError(`${host.label}：${explain(caught)}`);
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
        showError(`${host.label}：${explain(caught)}`);
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
    return <div className="ssh">{error ? <p className="banner is-warning">{error}</p> : <p className="blank">正在读取…</p>}</div>;
  }

  return (
    <div className={mobile ? "ssh is-mobile" : "ssh"}>
      {/* On a phone the strip appears only once a terminal or SFTP tab is open: a lone 主机库 tab says nothing. */}
      {(!mobile || state.sessions.length > 0 || sftpHosts.length > 0 || connecting) && (
      <div className="ssh-tabs" role="tablist" aria-label="SSH">
        <button type="button" role="tab" aria-selected={tab.kind === "vault"} className={tab.kind === "vault" ? "ssh-tab active" : "ssh-tab"} onClick={() => setTab({ kind: "vault" })}>
          主机库
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
              <button type="button" className="ssh-tab-close" aria-label={`关闭 ${session.label}`} onClick={() => void closeTerminal(session.tid)}>
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
                aria-label={`关闭 ${host.label} 的 SFTP`}
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
            正在连接 {hostsById.get(connecting)?.label}
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
          <nav className="ssh-nav" aria-label="主机库">
            {SECTIONS.map(([key, label]) => (
              <button key={key} type="button" className={section === key ? "active" : ""} aria-current={section === key ? "page" : undefined} onClick={() => setSection(key)}>
                {label}
                <span className="ssh-nav-count">
                  {key === "hosts"
                    ? state.hosts.length
                    : key === "keychain"
                      ? state.keys.length + state.identities.length
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
                      if (!window.confirm(`删除主机“${target.label}”？它的终端、SFTP 和端口转发规则也会一起关闭和删除。`)) return;
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
                片段
              </button>
              {snippetMenu && (
                <div className="ssh-menu" role="menu">
                  {state.snippets.length === 0 ? (
                    <p className="blank">还没有片段，到“主机库 → 代码片段”添加。</p>
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
              再开一个
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
