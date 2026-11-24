import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { api, type HtmlFile, type ListeningPort, type PreviewPickView, type PreviewRequest, type ToolId } from "./api";
import { CloseIcon, GlobeIcon, PlusIcon, Spinner, TrashIcon } from "./icons";

import { tr } from "./i18n";
function ago(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return tr("刚刚", "just now");
  if (seconds < 3600) return tr(`${Math.floor(seconds / 60)} 分钟前`, `${Math.floor(seconds / 60)} min ago`);
  if (seconds < 86_400) return tr(`${Math.floor(seconds / 3600)} 小时前`, `${Math.floor(seconds / 3600)} h ago`);
  return tr(`${Math.floor(seconds / 86_400)} 天前`, `${Math.floor(seconds / 86_400)} days ago`);
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
          ? tr("这个端口不能预览：要在 1024 到 65535 之间，且不是 MirrorMix 自己的端口。", "This port cannot be previewed: it must be between 1024 and 65535 and not MirrorMix's own.")
          : tr("没有保存。确认 MirrorMix 还在运行。", "Not saved. Check that MirrorMix is still running."),
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
          ? tr("外网访问下的预览地址还没准备好。确认外网访问已开启，子域名不超过 55 个字符。", "The remote preview address is not ready yet. Check that remote access is on and the subdomain is at most 55 characters.")
          : code === "bad_port"
            ? tr("这个端口不能预览。端口要在 1024 到 65535 之间，且不是 MirrorMix 自己的端口。", "This port cannot be previewed. It must be between 1024 and 65535 and not MirrorMix's own.")
            : code === "no_file"
              ? tr("找不到这个文件，它可能被移走或改名了。", "The file was not found; it may have been moved or renamed.")
              : tr("没有打开预览。确认 MirrorMix 还在运行。", "The preview did not open. Check that MirrorMix is still running."),
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
      setError(tr("请给服务起个名字，比如“前端页面”。", "Give the service a name, such as \"Front end\"."));
      return;
    }
    if (!/^\d{4,5}$/.test(text) || port < 1024 || port > 65535) {
      setError(tr("端口要在 1024 到 65535 之间，比如 5173。", "The port must be between 1024 and 65535, such as 5173."));
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
        aria-label={tr("浏览器：打开这个项目的网页文件和本地服务", "Browser: open this project's web files and local services")}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={tr("浏览器：这个项目的网页文件和本地服务", "Browser: this project's web files and local services")}
        onClick={() => setOpen((value) => !value)}
      >
        <GlobeIcon />
      </button>
      {open && (
        <PanelHost stage={stage}>
        <div className={stage ? "preview-menu is-docked" : "preview-menu"} role="dialog" aria-label={tr("浏览器", "Browser")} ref={menu} data-dock-panel="">
          <div className="preview-bar">
            <div className="preview-tabs" role="tablist" aria-label={tr("浏览器列表", "Browser list")}>
              {(["files", "services"] as const).map((key) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={tab === key}
                  className={tab === key ? "preview-tab is-on" : "preview-tab"}
                  onClick={() => { setTab(key); setError(""); }}
                >
                  {key === "files" ? tr("文件", "Files") : tr("服务", "Services")}
                  {view && <span className="preview-tab-count">{key === "files" ? fileRows.length : pickedPorts.length}</span>}
                </button>
              ))}
            </div>
            <button type="button" className="icon-button preview-close" aria-label={tr("关闭浏览器面板", "Close the browser panel")} title={tr("关闭", "Close")} onClick={() => setOpen(false)}>
              <CloseIcon />
            </button>
          </div>
          <div className="preview-body">
          {loadFailed ? (
            <p className="preview-empty">
              {tr("没有读到这个项目的浏览器列表。确认 MirrorMix 还在运行。", "Could not load this project's browser list. Check that MirrorMix is still running.")}
              <button type="button" className="link-button" onClick={() => void refresh()}>
                {tr("重试", "Retry")}
              </button>
            </p>
          ) : view === null ? (
            <div className="preview-empty">
              <Spinner />
            </div>
          ) : (
            <>
              {tab === "files" && (fileRows.length === 0 ? (
                <p className="preview-empty">{tr("还没有文件。在资源管理器里预览 HTML 或 Markdown 文件时，点右上角的 ＋ 加到这里。", "No files yet. When previewing an HTML or Markdown file in Files, click ＋ at the top right to add it here.")}</p>
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
                          title={missing ? tr(`${item.path}\n文件已经不在这个文件夹里了`, `${item.path}\nThe file is no longer in this folder`) : `${name}\n${item.path}`}
                          onClick={() => void show(key, { tool, id, file: item.path })}
                        >
                          <span className="preview-file">
                            <span className="preview-title">{name}</span>
                            <span className="preview-folder">{item.path}</span>
                          </span>
                          <span className="preview-name">{missing ? tr("文件不在了", "File gone") : "modifiedAt" in item && item.modifiedAt ? ago(item.modifiedAt) : ""}</span>
                          {opening === key && <Spinner />}
                        </button>
                        <button
                          type="button"
                          className="preview-remove"
                          disabled={busy}
                          aria-label={tr(`从列表移除 ${name}`, `Remove ${name} from the list`)}
                          title={tr("从列表移除", "Remove from the list")}
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
                <p className="preview-empty">{tr("还没有服务。添加一个，填上名字和端口。", "No services yet. Add one with a name and a port.")}</p>
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
                          title={stopped ? tr(`localhost:${item.port} 现在没有运行，启动后再打开。`, `localhost:${item.port} is not running; start it, then open it.`) : `localhost:${item.port}`}
                          onClick={() => void show(key, { port: item.port })}
                        >
                          <span className={stopped ? "preview-dot" : checking ? "preview-dot is-checking" : "preview-dot is-on"} aria-hidden="true" />
                          <span className="preview-file">
                            <span className="preview-title">{item.name || tr("未命名服务", "Unnamed service")}</span>
                            <span className="preview-folder">localhost:{item.port}</span>
                          </span>
                          <span className="preview-name">{checking ? "" : stopped ? tr("未运行", "Not running") : tr("运行中", "Running")}</span>
                          {opening === key && <Spinner />}
                        </button>
                        <button
                          type="button"
                          className="preview-remove"
                          disabled={busy}
                          aria-label={tr(`移除服务 ${item.name || item.port}`, `Remove service ${item.name || item.port}`)}
                          title={tr("移除服务", "Remove service")}
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
                  <strong className="preview-add-title">{tr("添加服务", "Add service")}</strong>
                  <label className="preview-field">
                    <span>{tr("名字", "Name")}</span>
                    <input placeholder={tr("比如 前端页面", "e.g. Front end")} maxLength={80} value={newName} autoFocus enterKeyHint="next" onChange={(event) => setNewName(event.target.value)} />
                  </label>
                  <label className="preview-field">
                    <span>{tr("端口", "Port")}</span>
                    <input
                      placeholder={tr("比如 5173", "e.g. 5173")}
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
                      {tr("取消", "Cancel")}
                    </button>
                    <button type="submit" className="quiet-button is-primary" disabled={saving || !newName.trim() || !newPort.trim()}>
                      {saving ? tr("保存中…", "Saving…") : tr("保存", "Save")}
                    </button>
                  </div>
                </form>
              ) : (
                <button type="button" className="preview-add-open" disabled={busy} onClick={() => { setAdding(true); setError(""); }}>
                  <PlusIcon />
                  {tr("添加服务", "Add service")}
                </button>
              ))}
            </>
          )}
          </div>
          {error && <p className="preview-error">{error}</p>}
          {fallback && (
            <p className="preview-error">
              {tr("浏览器拦下了新窗口。", "The browser blocked the new window. ")}
              <a href={fallback} target="_blank" rel="noreferrer" onClick={() => setOpen(false)}>
                {tr("点这里打开", "Open it here")}
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
