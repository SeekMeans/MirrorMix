import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { insideFolder, type OpenFileRequest } from "./openFile";
import { api, type FolderEntry, type ToolId } from "./api";
import { AddToBrowserDialog, ListAddIcon } from "./AddToBrowser";
import { BackIcon, ChevronIcon, CloseIcon, CollapseIcon, DownloadIcon, FileIcon, FolderIcon, GlobeIcon, RefreshIcon, SearchIcon, Spinner } from "./icons";

const IMAGE = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".svg", ".bmp"]);
const VIDEO = new Set([".mp4", ".webm"]);
const AUDIO = new Set([".mp3", ".wav", ".ogg"]);
const MARKDOWN = new Set([".md", ".markdown"]);
const HTML = new Set([".html", ".htm"]);
const TEXT = new Set([
  ".txt", ".log", ".csv", ".tsv", ".json", ".jsonl", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".env", ".xml",
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".css", ".scss", ".less", ".html", ".htm", ".vue", ".svelte",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".c", ".h", ".cpp", ".hpp", ".cs", ".php", ".swift", ".sql", ".sh",
  ".bash", ".ps1", ".bat", ".cmd", ".lua", ".r", ".m", ".dart", ".gradle", ".properties", ".gitignore", ".editorconfig",
  ".lock", ".svg", ".md", ".markdown",
]);
/** Larger text is not shown inline; it can still be downloaded. */
const MAX_TEXT = 2 * 1024 * 1024;

const LIST_WIDTH_KEY = "mirrormix.files.listWidth";
const LIST_WIDTH = 300;
const LIST_MIN = 180;
/** The preview keeps at least this much room whatever the list is dragged to. */
const PREVIEW_MIN = 280;

function readListWidth(): number {
  try {
    const saved = Number(localStorage.getItem(LIST_WIDTH_KEY));
    if (Number.isFinite(saved) && saved >= LIST_MIN) return saved;
  } catch {
    /* no saved width: the default */
  }
  return LIST_WIDTH;
}

function saveListWidth(width: number) {
  try {
    localStorage.setItem(LIST_WIDTH_KEY, String(Math.round(width)));
  } catch {
    /* kept for this page only */
  }
}

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : name.startsWith(".") ? name.toLowerCase() : "";
}

function join(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

function parentOf(dir: string): string {
  const cut = dir.lastIndexOf("/");
  return cut < 0 ? "" : dir.slice(0, cut);
}

function sizeText(entry: FolderEntry): string {
  if (entry.dir) return "";
  if (entry.size < 1024) return `${entry.size} 字节`;
  const kb = Math.ceil(entry.size / 1024);
  return kb < 10_240 ? `${kb.toLocaleString("zh-CN")} KB` : `${(entry.size / 1024 / 1024).toFixed(1)} MB`;
}

function typeText(entry: FolderEntry): string {
  if (entry.dir) return "文件夹";
  const ext = extOf(entry.name);
  return ext ? `${ext.slice(1).toUpperCase()} 文件` : "文件";
}

function dateText(ms: number): string {
  return new Date(ms).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** What the preview pane shows for one file. */
function FilePreview({
  tool,
  id,
  path,
  entry,
  onBack,
  phone = false,
}: {
  tool: ToolId;
  id: string;
  path: string;
  entry: FolderEntry;
  onBack?: () => void;
  /** A phone shows it over the tree, with a header sized for fingers. */
  phone?: boolean;
}) {
  const ext = extOf(entry.name);
  const url = api.fileUrl(tool, id, path);
  const [text, setText] = useState<string | null>(null);
  const [problem, setProblem] = useState("");
  const [opening, setOpening] = useState(false);
  const [adding, setAdding] = useState(false);
  const textual = (TEXT.has(ext) || !ext || !/^\.[a-z0-9]+$/.test(ext)) && !IMAGE.has(ext);
  const showText = textual && entry.size <= MAX_TEXT;
  // An unknown kind of file is tried as text, and given up on if it turns out to be binary.
  const unknown = !TEXT.has(ext) && !IMAGE.has(ext) && !VIDEO.has(ext) && !AUDIO.has(ext) && ext !== ".pdf";

  useEffect(() => {
    setText(null);
    setProblem("");
    if (!showText && !(unknown && entry.size <= MAX_TEXT)) return;
    let live = true;
    fetch(url, { credentials: "same-origin" })
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.text();
      })
      .then((body) => {
        if (!live) return;
        if (body.slice(0, 8_000).includes("\u0000")) setProblem("binary");
        else setText(body);
      })
      .catch(() => live && setProblem("failed"));
    return () => {
      live = false;
    };
  }, [url, showText, unknown, entry.size]);

  const openPage = async () => {
    // Opened at once, before waiting, so the browser does not treat it as an unasked pop-up.
    const tab = window.open("", "_blank");
    setOpening(true);
    try {
      const { url: page } = await api.openPreview({ tool, id, file: path });
      if (tab) tab.location.href = page;
      else window.location.href = page;
    } catch {
      tab?.close();
      setProblem("page");
    } finally {
      setOpening(false);
    }
  };

  let body: React.ReactNode;
  if (IMAGE.has(ext)) body = <div className="file-image"><img src={url} alt={entry.name} /></div>;
  else if (VIDEO.has(ext)) body = <video className="file-media" src={url} controls />;
  else if (AUDIO.has(ext)) body = <audio className="file-audio" src={url} controls />;
  else if (ext === ".pdf") body = <iframe className="file-frame" src={url} title={entry.name} />;
  else if (problem === "binary" || (!showText && !(unknown && entry.size <= MAX_TEXT)))
    body = <p className="file-note">{entry.size > MAX_TEXT && textual ? "文件太大，不在这里显示。可以下载后查看。" : "这种文件没法在这里预览，可以下载后打开。"}</p>;
  else if (problem === "failed") body = <p className="file-note">没有读到这个文件，它可能刚被移走或改名了。</p>;
  else if (text === null) body = <p className="file-note"><Spinner /> 正在读取…</p>;
  else if (MARKDOWN.has(ext)) body = <div className="file-markdown markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown></div>;
  else {
    const lines = text.split(/\r?\n/);
    body = (
      <pre className="file-code">
        <code>
          {lines.map((line, index) => (
            <span className="file-line" key={index}>
              <span className="file-line-no">{index + 1}</span>
              {line || " "}
              {"\n"}
            </span>
          ))}
        </code>
      </pre>
    );
  }

  return (
    <section className={phone ? "file-preview is-overlay" : "file-preview"} aria-label={`预览 ${entry.name}`}>
      <header className="file-preview-head">
        {onBack && (
          <button type="button" className="icon-button" aria-label="返回文件列表" onClick={onBack}>
            <BackIcon />
          </button>
        )}
        <div className="file-preview-title">
          <strong title={path}>{entry.name}</strong>
          {phone ? (
            // The folder it is in matters more on a phone than the type: the tree is out of sight.
            <span>{[parentOf(path) || "根目录", sizeText(entry)].join(" · ")}</span>
          ) : (
            <span>{typeText(entry)} · {sizeText(entry)} · {dateText(entry.mtime)}</span>
          )}
        </div>
        {(HTML.has(ext) || MARKDOWN.has(ext)) &&
          (phone ? (
            <button type="button" className="icon-button" disabled={opening} onClick={() => void openPage()} aria-label="当网页打开" title="当网页打开">
              <GlobeIcon />
            </button>
          ) : (
            <button type="button" className="quiet-button" disabled={opening} onClick={() => void openPage()} title="在新标签页里当网页打开">
              <GlobeIcon />
              <span>当网页打开</span>
            </button>
          ))}
        {(HTML.has(ext) || MARKDOWN.has(ext)) && (
          <button
            type="button"
            className="icon-button"
            aria-label={`把 ${entry.name} 加入浏览器列表`}
            title="加入悬浮操作里浏览器的文件列表"
            onClick={() => setAdding(true)}
          >
            <ListAddIcon />
          </button>
        )}
        <a className="icon-button" href={api.fileUrl(tool, id, path, true)} aria-label={`下载 ${entry.name}`} title="下载">
          <DownloadIcon />
        </a>
      </header>
      {adding && <AddToBrowserDialog tool={tool} id={id} path={path} name={entry.name} onClose={() => setAdding(false)} />}
      {problem === "page" && <p className="file-note">网页没有打开。回到这里再试一次。</p>}
      <div className="file-preview-body">{body}</div>
    </section>
  );
}

/** The session's workspace as a folder tree, with a preview of the file picked in it. */
export function FileBrowser({
  tool,
  id,
  cwd,
  mobile,
  reveal = null,
  onClose,
}: {
  tool: ToolId;
  id: string;
  cwd: string;
  mobile: boolean;
  /** A file named in a reply: shown in the tree, its folders opened, and opened in the preview. */
  reveal?: OpenFileRequest | null;
  onClose: () => void;
}) {
  /** Each folder read so far, by its path ("" is the workspace itself). */
  const [folders, setFolders] = useState<Record<string, FolderEntry[] | "loading" | "error">>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<{ path: string; entry: FolderEntry } | null>(null);
  /** The file in the preview. Opening a folder in the tree leaves it there. */
  const [shownFile, setShownFile] = useState<{ path: string; entry: FolderEntry } | null>(null);
  const [filter, setFilter] = useState("");
  /** A phone keeps the filter box folded away until the search button is tapped. */
  const [searching, setSearching] = useState(false);
  const [listWidth, setListWidth] = useState(readListWidth);
  const mainRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const rootName = cwd.split(/[\\/]/).filter(Boolean).pop() || cwd;

  /** The list's width kept inside the panel, so the preview never disappears. */
  const clampWidth = useCallback((width: number) => {
    const room = mainRef.current?.clientWidth ?? 0;
    const most = room > 0 ? Math.max(LIST_MIN, room - PREVIEW_MIN) : Number.POSITIVE_INFINITY;
    return Math.round(Math.min(most, Math.max(LIST_MIN, width)));
  }, []);

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = listWidth;
    const handle = event.currentTarget;
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      /* the window listeners below still follow the pointer */
    }
    document.body.classList.add("is-resizing-x");
    let latest = startWidth;
    const move = (pointer: PointerEvent) => {
      latest = clampWidth(startWidth + pointer.clientX - startX);
      setListWidth(latest);
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      document.body.classList.remove("is-resizing-x");
      saveListWidth(latest);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };

  const nudgeWidth = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 64 : 16;
    let next: number | null = null;
    if (event.key === "ArrowLeft") next = listWidth - step;
    else if (event.key === "ArrowRight") next = listWidth + step;
    else if (event.key === "Home") next = LIST_MIN;
    if (next === null) return;
    event.preventDefault();
    const width = clampWidth(next);
    setListWidth(width);
    saveListWidth(width);
  };

  const load = useCallback(
    (dir: string) => {
      setFolders((current) => (current[dir] && current[dir] !== "error" ? current : { ...current, [dir]: "loading" }));
      api
        .files(tool, id, dir)
        .then((listing) => setFolders((current) => ({ ...current, [dir]: listing.entries })))
        .catch(() => setFolders((current) => ({ ...current, [dir]: "error" })));
    },
    [tool, id],
  );

  useEffect(() => {
    setFolders({});
    setExpanded(new Set());
    setSelected(null);
    setShownFile(null);
    load("");
  }, [load]);

  const [revealNote, setRevealNote] = useState("");
  useEffect(() => {
    if (!reveal) return;
    const relative = insideFolder(reveal.path, cwd);
    if (relative === null || !relative) {
      setRevealNote(`“${reveal.path}”不在这个会话的文件夹里。`);
      return;
    }
    let live = true;
    setFilter("");
    setRevealNote("");
    void (async () => {
      const parts = relative.split("/");
      const opened: string[] = [];
      let dir = "";
      let target: { path: string; entry: FolderEntry } | null = null;
      // Walk down one folder at a time, reading each, matching names the way Windows does (any case).
      for (let index = 0; index < parts.length; index += 1) {
        let entries: FolderEntry[];
        try {
          entries = (await api.files(tool, id, dir)).entries;
        } catch {
          if (live) setRevealNote(`没找到 ${relative}，它可能已经被移走或改名。`);
          return;
        }
        if (!live) return;
        const here = dir;
        setFolders((current) => ({ ...current, [here]: entries }));
        const name = parts[index];
        const found = entries.find((entry) => entry.name === name) ?? entries.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
        const last = index === parts.length - 1;
        if (!found || (!last && !found.dir)) {
          setRevealNote(`没找到 ${relative}，它可能已经被移走或改名。`);
          return;
        }
        const path = dir ? `${dir}/${found.name}` : found.name;
        if (last) target = { path, entry: found };
        else {
          opened.push(path);
          dir = path;
        }
      }
      if (!target || !live) return;
      const shown = target;
      setExpanded((current) => new Set([...current, ...opened, ...(shown.entry.dir ? [shown.path] : [])]));
      if (shown.entry.dir) load(shown.path);
      setSelected(shown);
      if (!shown.entry.dir) setShownFile(shown);
      // After the opened folders are drawn.
      window.setTimeout(() => {
        treeRef.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(shown.path)}"]`)?.scrollIntoView({ block: "center" });
      }, 60);
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.seq]);

  const toggle = (dir: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(dir)) next.delete(dir);
      else {
        next.add(dir);
        if (!folders[dir] || folders[dir] === "error") load(dir);
      }
      return next;
    });
  };

  /** Reads the workspace and every open folder again; what stays open stays open. */
  const refresh = () => {
    setFolders({});
    load("");
    for (const dir of expanded) load(dir);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /** The rows as shown: open folders' contents under them, indented. A filter keeps matches and the folders leading to them. */
  const rows = useMemo(() => {
    const wanted = filter.trim().toLowerCase();
    type Row =
      | { kind: "entry"; path: string; entry: FolderEntry; depth: number }
      | { kind: "note"; path: string; text: string; depth: number };
    const walk = (dir: string, depth: number): { rows: Row[]; matched: boolean } => {
      const listed = folders[dir];
      if (listed === undefined || listed === "loading") return { rows: [{ kind: "note", path: `${dir}#`, text: "正在读取…", depth }], matched: false };
      if (listed === "error") return { rows: [{ kind: "note", path: `${dir}#`, text: "打不开这个文件夹", depth }], matched: false };
      const out: Row[] = [];
      let matched = false;
      for (const entry of listed) {
        const path = join(dir, entry.name);
        const hit = !wanted || entry.name.toLowerCase().includes(wanted);
        const inner = entry.dir && expanded.has(path) ? walk(path, depth + 1) : null;
        if (hit || inner?.matched) {
          out.push({ kind: "entry", path, entry, depth });
          if (inner) out.push(...(inner.rows.length ? inner.rows : [{ kind: "note" as const, path: `${path}#`, text: "空文件夹", depth: depth + 1 }]));
          matched = true;
        }
      }
      return { rows: out, matched };
    };
    return walk("", 0).rows;
  }, [folders, expanded, filter]);

  const entryRows = rows.filter((row): row is Extract<typeof row, { kind: "entry" }> => row.kind === "entry");

  /** Up and down move through the rows, right opens a folder, left closes it or goes to its parent. */
  const onTreeKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter"].includes(event.key)) return;
    event.preventDefault();
    const at = selected ? entryRows.findIndex((row) => row.path === selected.path) : -1;
    const current = at >= 0 ? entryRows[at] : null;
    const pick = (index: number) => {
      const row = entryRows[Math.max(0, Math.min(entryRows.length - 1, index))];
      if (!row) return;
      setSelected({ path: row.path, entry: row.entry });
      if (!row.entry.dir) setShownFile({ path: row.path, entry: row.entry });
      treeRef.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(row.path)}"]`)?.scrollIntoView({ block: "nearest" });
    };
    if (event.key === "ArrowDown") pick(at + 1);
    else if (event.key === "ArrowUp") pick(at < 0 ? 0 : at - 1);
    else if (!current) pick(0);
    else if (event.key === "ArrowRight" || event.key === "Enter") {
      if (current.entry.dir && !expanded.has(current.path)) toggle(current.path);
      else if (current.entry.dir && event.key === "ArrowRight") pick(at + 1);
    } else if (event.key === "ArrowLeft") {
      if (current.entry.dir && expanded.has(current.path)) toggle(current.path);
      else {
        const parent = parentOf(current.path);
        const index = entryRows.findIndex((row) => row.path === parent);
        if (index >= 0) pick(index);
      }
    }
  };

  const choose = (path: string, entry: FolderEntry) => {
    setSelected({ path, entry });
    if (entry.dir) toggle(path);
    else setShownFile({ path, entry });
  };

  const previewing = shownFile;
  const rootListing = folders[""];

  return (
    <section className={mobile ? "files-box is-sheet" : "files-box"} aria-label="资源管理器">
      {mobile ? (
        // While a file is open its own header (back, name, download) is the only bar: the preview gets the screen.
        !previewing && (
        <>
          <div className="files-mbar">
            <div className="files-mtitle" title={cwd}>
              <strong>{rootName}</strong>
              <span>{Array.isArray(rootListing) ? `${rootListing.length} 个项目` : "正在读取…"}</span>
            </div>
            <button
              type="button"
              className={searching || filter ? "icon-button is-on" : "icon-button"}
              aria-label="筛选"
              aria-pressed={searching || Boolean(filter)}
              onClick={() => {
                if (searching && filter) setFilter("");
                setSearching((value) => !value);
              }}
            >
              <SearchIcon />
            </button>
            <button type="button" className="icon-button" aria-label="全部折叠" disabled={expanded.size === 0} onClick={() => setExpanded(new Set())}>
              <CollapseIcon />
            </button>
            <button type="button" className="icon-button" aria-label="刷新" onClick={refresh}>
              <RefreshIcon />
            </button>
            <button type="button" className="icon-button" aria-label="关闭资源管理器" onClick={onClose}>
              <CloseIcon />
            </button>
          </div>
          {(searching || filter) && (
            <div className="files-msearch">
              <input
                className="files-filter"
                type="search"
                placeholder="筛选已展开的文件"
                aria-label="筛选文件"
                value={filter}
                autoFocus
                enterKeyHint="search"
                onChange={(event) => setFilter(event.target.value)}
              />
            </div>
          )}
        </>
        )
      ) : (
      <div className="files-bar">
        <div className="files-address" title={previewing ? `${cwd}\\${previewing.path.replace(/\//g, "\\")}` : cwd}>
          <FolderIcon />
          <span className="files-root">{rootName}</span>
          {selected && (
            <span className="files-crumb">
              <ChevronIcon />
              <span>{selected.path.split("/").join(" / ")}</span>
            </span>
          )}
        </div>
        <button type="button" className="icon-button" aria-label="刷新" title="刷新" onClick={refresh}>
          <RefreshIcon />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="全部折叠"
          title="全部折叠"
          disabled={expanded.size === 0}
          onClick={() => setExpanded(new Set())}
        >
          <CollapseIcon />
        </button>
        {!mobile && (
          <input
            className="files-filter"
            type="search"
            placeholder="筛选已展开的文件"
            aria-label="筛选文件"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        )}
        <button type="button" className="icon-button" aria-label="关闭资源管理器" title="关闭" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      )}

      <div className="files-main" ref={mainRef}>
        {/* On a phone the tree stays underneath the preview, so coming back finds it as it was left. */}
        <div
          className="files-list ftree"
          role="tree"
          aria-label="文件"
          tabIndex={0}
          ref={treeRef}
          onKeyDown={onTreeKey}
          inert={mobile && Boolean(previewing)}
          style={mobile ? undefined : { width: listWidth, flex: "none" }}
        >
            {revealNote && <p className="file-note is-warning">{revealNote}</p>}
            {rootListing === "error" && <p className="file-note">这个文件夹打不开了，它可能已经被移走或改名。</p>}
            {Array.isArray(rootListing) && rows.length === 0 && <p className="file-note">{filter ? "没有符合的项目" : "此文件夹为空"}</p>}
            {rows.map((row) =>
              row.kind === "note" ? (
                <p key={row.path} className="ftree-note" style={{ paddingLeft: (mobile ? 34 : 28) + row.depth * (mobile ? 14 : 16) }}>
                  {row.text}
                </p>
              ) : (
                <button
                  type="button"
                  role="treeitem"
                  key={row.path}
                  data-path={row.path}
                  aria-expanded={row.entry.dir ? expanded.has(row.path) : undefined}
                  aria-selected={selected?.path === row.path}
                  className={selected?.path === row.path ? "ftree-item is-selected" : "ftree-item"}
                  style={{ paddingLeft: (mobile ? 8 : 6) + row.depth * (mobile ? 14 : 16) }}
                  title={`${row.entry.name}\n${typeText(row.entry)}${row.entry.dir ? "" : ` · ${sizeText(row.entry)}`}\n修改于 ${dateText(row.entry.mtime)}`}
                  onClick={() => choose(row.path, row.entry)}
                >
                  <span className={row.entry.dir && expanded.has(row.path) ? "ftree-caret is-open" : "ftree-caret"} aria-hidden="true">
                    {row.entry.dir && <ChevronIcon />}
                  </span>
                  {row.entry.dir ? <FolderIcon /> : <FileIcon />}
                  <span className="ftree-name">{row.entry.name}</span>
                  {!row.entry.dir && <span className="ftree-size">{sizeText(row.entry)}</span>}
                </button>
              ),
            )}
        </div>

        {!mobile && (
          <div
            className="files-splitter"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整文件列表宽度"
            aria-valuenow={listWidth}
            aria-valuemin={LIST_MIN}
            tabIndex={0}
            title="拖动调整宽度，双击恢复默认"
            onPointerDown={startDrag}
            onKeyDown={nudgeWidth}
            onDoubleClick={() => {
              const width = clampWidth(LIST_WIDTH);
              setListWidth(width);
              saveListWidth(width);
            }}
          />
        )}

        {previewing ? (
          <FilePreview
            key={previewing.path}
            tool={tool}
            id={id}
            path={previewing.path}
            entry={previewing.entry}
            phone={mobile}
            // Back keeps the row highlighted, so it is clear where in the tree the file was.
            onBack={mobile ? () => setShownFile(null) : undefined}
          />
        ) : (
          !mobile && <p className="file-preview file-note is-empty">选择要预览的文件</p>
        )}
      </div>
    </section>
  );
}
