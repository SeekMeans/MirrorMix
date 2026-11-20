import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { api, type HtmlFile, type ListeningPort, type PreviewPickView, type PreviewRequest, type ToolId } from "./api";
import { CloseIcon, GlobeIcon, PlusIcon, Spinner, TrashIcon } from "./icons";

function ago(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86_400)} 天前`;
}

export function pageName(item: Pick<HtmlFile, "path" | "title">): string {
  if (item.title) return item.title;
  const parts = item.path.replace(/\\/g, "/").split("/");
  const name = parts.pop() ?? item.path;
  if (!/^index\.html?$/i.test(name)) return name;
  return parts.reverse().find((part) => !/^(dist(?:\.bak)?|build|out|public|html)$/i.test(part)) ?? parts[0] ?? name;
}

type PickedPort = { port: number; name?: string };

/**
 * The browser button of the session tools. It lists what this project folder keeps for previewing, shared by every
 * session in the folder: HTML files (added from the file browser's preview) and local services by name and port
 * (added here). Picking one opens it in a new tab through MirrorMix, so it works from a phone and the tunnel too.
 */
export function PreviewButton({ tool, id }: { tool: ToolId; id: string }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<PreviewPickView | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [running, setRunning] = useState<ListeningPort[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [tab, setTab] = useState<"files" | "services">("files");
  const [newName, setNewName] = useState("");
  const [newPort, setNewPort] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [fallback, setFallback] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  /** The conversation area: the panel opens at its top right, under the header, where the command line opens. */
  const [stage, setStage] = useState<HTMLElement | null>(null);

  const refresh = async () => {
    setView(null);
    setLoadFailed(false);
    setRunning(null);
    api
      .previewPorts()
      .then((result) => setRunning(result.ports))
      .catch(() => setRunning([]));
    try {
      setView(await api.previewPicks(tool, id));
    } catch {
      setLoadFailed(true);
    }
  };

  useEffect(() => {
    if (!open) return;
    setStage(box.current?.closest<HTMLElement>(".thread-stage") ?? null);
    setError("");
    setFallback(null);
    setAdding(false);
    void refresh();
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!box.current?.contains(target) && !menu.current?.contains(target)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => setOpen(false), [tool, id]);

  const pickedFiles = view?.picks?.files ?? [];
  const pickedPorts: PickedPort[] = view?.picks?.ports ?? [];

  const save = async (files: string[], ports: PickedPort[]) => {
    setSaving(true);
    setError("");
    try {
      setView(await api.savePreviewPicks(tool, id, { files, ports }));
      return true;
    } catch (failure) {
      const code = (failure as { code?: string }).code;
      setError(
        code === "picks_bad_port"
          ? "这个端口不能预览：要在 1024 到 65535 之间，且不是 MirrorMix 自己的端口。"
          : "没有保存。确认 MirrorMix 还在运行。",
      );
      return false;
    } finally {
      setSaving(false);
    }
  };

  const show = async (key: string, what: PreviewRequest) => {
    setError("");
    setFallback(null);
    // The tab is opened inside the click itself, or the browser would block it as a pop-up; its address follows.
    const tab = window.open("about:blank", "_blank");
    setOpening(key);
    try {
      const { url } = await api.openPreview(what);
      if (tab) {
        tab.opener = null;
        tab.location.href = url;
        setOpen(false);
      } else {
        setFallback(url);
      }
    } catch (failure) {
      tab?.close();
      const code = (failure as { code?: string }).code;
      setError(
        code === "preview_unavailable"
          ? "外网访问下的预览地址还没准备好。确认外网访问已开启，子域名不超过 55 个字符。"
          : code === "bad_port"
            ? "这个端口不能预览。端口要在 1024 到 65535 之间，且不是 MirrorMix 自己的端口。"
            : code === "no_file"
              ? "找不到这个文件，它可能被移走或改名了。"
              : "没有打开预览。确认 MirrorMix 还在运行。",
      );
    } finally {
      setOpening(null);
    }
  };

  const addService = async (event: FormEvent) => {
    event.preventDefault();
    const name = newName.trim();
    const text = newPort.trim();
    const port = Number(text);
    if (!name) {
      setError("请给服务起个名字，比如“前端页面”。");
      return;
    }
    if (!/^\d{4,5}$/.test(text) || port < 1024 || port > 65535) {
      setError("端口要在 1024 到 65535 之间，比如 5173。");
      return;
    }
    // The same port again takes the new name.
    const ports = [...pickedPorts.filter((item) => item.port !== port), { port, name }].sort((a, b) => a.port - b.port);
    if (await save(pickedFiles, ports)) {
      setAdding(false);
      setNewName("");
      setNewPort("");
    }
  };

  const live = new Set((running ?? []).map((item) => item.port));
  const busy = opening !== null || saving;
  const fileRows = view?.files ?? [];

  return (
    <div className="preview" ref={box}>
      <button
        type="button"
        className={open ? "icon-button is-on" : "icon-button"}
        aria-label="浏览器：打开这个项目的网页文件和本地服务"
        aria-expanded={open}
        aria-haspopup="dialog"
        title="浏览器：这个项目的网页文件和本地服务"
        onClick={() => setOpen((value) => !value)}
      >
        <GlobeIcon />
      </button>
      {open && (
        <PanelHost stage={stage}>
        <div className={stage ? "preview-menu is-docked" : "preview-menu"} role="dialog" aria-label="浏览器" ref={menu} data-dock-panel="">
          <div className="preview-bar">
            <div className="preview-tabs" role="tablist" aria-label="浏览器列表">
              {(["files", "services"] as const).map((key) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={tab === key}
                  className={tab === key ? "preview-tab is-on" : "preview-tab"}
                  onClick={() => { setTab(key); setError(""); }}
                >
                  {key === "files" ? "文件" : "服务"}
                  {view && <span className="preview-tab-count">{key === "files" ? fileRows.length : pickedPorts.length}</span>}
                </button>
              ))}
            </div>
            <button type="button" className="icon-button preview-close" aria-label="关闭浏览器面板" title="关闭" onClick={() => setOpen(false)}>
              <CloseIcon />
            </button>
          </div>
          <div className="preview-body">
          {loadFailed ? (
            <p className="preview-empty">
              没有读到这个项目的浏览器列表。确认 MirrorMix 还在运行。
              <button type="button" className="link-button" onClick={() => void refresh()}>
                重试
              </button>
            </p>
          ) : view === null ? (
            <div className="preview-empty">
              <Spinner />
            </div>
          ) : (
            <>
              {tab === "files" && (fileRows.length === 0 ? (
                <p className="preview-empty">还没有文件。在资源管理器里预览 HTML 或 Markdown 文件时，点右上角的 ＋ 加到这里。</p>
              ) : (
                <ul className="preview-list">
                  {fileRows.map((item) => {
                    const missing = "missing" in item;
                    const name = missing ? pageName({ path: item.path }) : pageName(item);
                    const key = `file:${item.path}`;
                    return (
                      <li key={item.path} className="preview-row">
                        <button
                          type="button"
                          disabled={busy || missing}
                          className={missing ? "is-off" : undefined}
                          title={missing ? `${item.path}\n文件已经不在这个文件夹里了` : `${name}\n${item.path}`}
                          onClick={() => void show(key, { tool, id, file: item.path })}
                        >
                          <span className="preview-file">
                            <span className="preview-title">{name}</span>
                            <span className="preview-folder">{item.path}</span>
                          </span>
                          <span className="preview-name">{missing ? "文件不在了" : "modifiedAt" in item && item.modifiedAt ? ago(item.modifiedAt) : ""}</span>
                          {opening === key && <Spinner />}
                        </button>
                        <button
                          type="button"
                          className="preview-remove"
                          disabled={busy}
                          aria-label={`从列表移除 ${name}`}
                          title="从列表移除"
                          onClick={() => void save(pickedFiles.filter((file) => file !== item.path), pickedPorts)}
                        >
                          <TrashIcon />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ))}

              {tab === "services" && (pickedPorts.length === 0 && !adding ? (
                <p className="preview-empty">还没有服务。添加一个，填上名字和端口。</p>
              ) : (
                <ul className="preview-list">
                  {pickedPorts.map((item) => {
                    const key = `port:${item.port}`;
                    const checking = running === null;
                    const stopped = !checking && !live.has(item.port);
                    return (
                      <li key={item.port} className="preview-row">
                        <button
                          type="button"
                          disabled={busy || checking || stopped}
                          className={stopped ? "is-off" : undefined}
                          title={stopped ? `localhost:${item.port} 现在没有运行，启动后再打开。` : `localhost:${item.port}`}
                          onClick={() => void show(key, { port: item.port })}
                        >
                          <span className={stopped ? "preview-dot" : checking ? "preview-dot is-checking" : "preview-dot is-on"} aria-hidden="true" />
                          <span className="preview-file">
                            <span className="preview-title">{item.name || "未命名服务"}</span>
                            <span className="preview-folder">localhost:{item.port}</span>
                          </span>
                          <span className="preview-name">{checking ? "" : stopped ? "未运行" : "运行中"}</span>
                          {opening === key && <Spinner />}
                        </button>
                        <button
                          type="button"
                          className="preview-remove"
                          disabled={busy}
                          aria-label={`移除服务 ${item.name || item.port}`}
                          title="移除服务"
                          onClick={() => void save(pickedFiles, pickedPorts.filter((row) => row.port !== item.port))}
                        >
                          <TrashIcon />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ))}
              {tab === "services" && (adding ? (
                <form className="preview-add" onSubmit={(event) => void addService(event)}>
                  <strong className="preview-add-title">添加服务</strong>
                  <label className="preview-field">
                    <span>名字</span>
                    <input placeholder="比如 前端页面" maxLength={80} value={newName} autoFocus enterKeyHint="next" onChange={(event) => setNewName(event.target.value)} />
                  </label>
                  <label className="preview-field">
                    <span>端口</span>
                    <input
                      placeholder="比如 5173"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      maxLength={5}
                      enterKeyHint="done"
                      value={newPort}
                      onChange={(event) => setNewPort(event.target.value.replace(/\D/g, ""))}
                    />
                  </label>
                  <div className="preview-add-actions">
                    <button type="button" className="quiet-button" disabled={saving} onClick={() => { setAdding(false); setError(""); }}>
                      取消
                    </button>
                    <button type="submit" className="quiet-button is-primary" disabled={saving || !newName.trim() || !newPort.trim()}>
                      {saving ? "保存中…" : "保存"}
                    </button>
                  </div>
                </form>
              ) : (
                <button type="button" className="preview-add-open" disabled={busy} onClick={() => { setAdding(true); setError(""); }}>
                  <PlusIcon />
                  添加服务
                </button>
              ))}
            </>
          )}
          </div>
          {error && <p className="preview-error">{error}</p>}
          {fallback && (
            <p className="preview-error">
              浏览器拦下了新窗口。
              <a href={fallback} target="_blank" rel="noreferrer" onClick={() => setOpen(false)}>
                点这里打开
              </a>
            </p>
          )}
        </div>
        </PanelHost>
      )}
    </div>
  );
}

/** Puts the panel into the conversation area when there is one; otherwise it stays beside its button. */
function PanelHost({ stage, children }: { stage: HTMLElement | null; children: React.ReactNode }) {
  return stage ? createPortal(children, stage) : <>{children}</>;
}
