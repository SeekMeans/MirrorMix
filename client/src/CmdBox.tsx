import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useCallback, useEffect, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from "react";
import { api, liveUrl, type ShortcutLibrary, type TerminalInfo, type TerminalList, type TerminalProject, type ToolId } from "./api";
import { workspaceTerminalKey } from "../../src/shared/terminalScope";
import { ChevronIcon, CloseIcon, PlusIcon } from "./icons";
import { ShortcutMenu } from "./ShortcutMenu";
import { ServiceMenu } from "./ServiceMenu";
import type { RunRequest } from "./runCommand";

const SIZE_KEY = "mirrormix.cmd.size";

interface PanelSize {
  width: number;
  height: number;
}

function readSize(): PanelSize {
  try {
    const saved = JSON.parse(localStorage.getItem(SIZE_KEY) ?? "") as Partial<PanelSize>;
    if (typeof saved.width === "number" && typeof saved.height === "number") {
      return { width: saved.width, height: saved.height };
    }
  } catch {
    /* a fresh panel uses the default size */
  }
  return { width: 520, height: 380 };
}

/** The tab last shown for each project, shared across all its conversations and tools. */
const lastTab = new Map<string, string>();

/** Keys a phone keyboard does not have, sent as the bytes a terminal expects. */
const PHONE_KEYS: Array<{ label: string; data: string; title: string }> = [
  { label: "Tab", data: "\t", title: "补全" },
  { label: "↑", data: "\u001b[A", title: "上一条命令" },
  { label: "↓", data: "\u001b[B", title: "下一条命令" },
  { label: "Ctrl+C", data: "\u0003", title: "中断正在运行的命令" },
  { label: "Esc", data: "\u001b", title: "Esc" },
];

/**
 * One command line's screen. Only the screen belongs to the page: the cmd.exe behind it runs on this PC
 * until it is closed with its tab, and what it printed meanwhile is replayed when the screen connects.
 */
function TermScreen({
  tool,
  id,
  tid,
  mode = "cmd",
  mobile,
  windowsPty,
  onSocket,
  onGone,
}: {
  tool: ToolId;
  id: string;
  tid: string;
  /** "terminal" shows the session's own process instead of one of its command lines. */
  mode?: "cmd" | "terminal";
  mobile: boolean;
  windowsPty?: TerminalProject["windowsPty"];
  onSocket: (socket: WebSocket | null, ready: boolean) => void;
  onGone: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const goneRef = useRef(onGone);
  goneRef.current = onGone;
  const socketRef = useRef(onSocket);
  socketRef.current = onSocket;

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const term = new Terminal({
      // A phone types in the line under the screen; the screen itself only shows output and scrolls.
      disableStdin: mobile,
      cursorBlink: !mobile,
      fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace',
      fontSize: mobile ? 12 : 13,
      scrollback: 5000,
      windowsPty,
      theme: { background: "#0f1f26", foreground: "#d7e6ec", cursor: "#5cc4b8" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);
    let closed = false;
    let retry = 0;
    let socket: WebSocket | null = null;
    let sized = "";
    const sendSize = () => {
      if (socket?.readyState !== WebSocket.OPEN) return;
      const next = `${term.cols}x${term.rows}`;
      if (next === sized) return;
      sized = next;
      socket.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    };
    // The phone keyboard opening and closing resizes the panel many times in a row; fit once it settles.
    let resizeTimer = 0;
    const resize = () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        try {
          fit.fit();
        } catch {
          return;
        }
        sendSize();
      }, 120);
    };
    const connect = (attempt: number) => {
      const next = new WebSocket(mode === "terminal" ? liveUrl("terminal", tool, id) : liveUrl("cmd", tool, id, tid));
      socket = next;
      next.onopen = () => {
        attempt = 0;
        // What the command line printed is replayed from the start of what is kept, so the screen starts clean.
        if (mode === "cmd") term.reset();
        sized = "";
        try {
          fit.fit();
        } catch {
          /* not laid out yet; the observer fits it */
        }
        sendSize();
        socketRef.current(next, true);
        if (!mobile) term.focus();
      };
      next.onmessage = (event) => term.write(typeof event.data === "string" ? event.data : String(event.data));
      next.onclose = (event) => {
        if (socket === next) socketRef.current(null, false);
        if (closed) return;
        // Closed from another page, or its cmd.exe exited.
        if (mode === "cmd" && (event.code === 4404 || event.code === 4000)) {
          goneRef.current();
          return;
        }
        // The connection dropped (a phone going to sleep, the tunnel blinking): attach again.
        retry = window.setTimeout(() => connect(attempt + 1), Math.min(5000, 400 * 2 ** attempt));
      };
    };
    connect(0);
    // The panel animates open, so the first fit can catch it mid-way. Once it has settled, fit again, tell the
    // command line its real size and redraw, so what was replayed shows cleanly.
    const settle = window.setTimeout(() => {
      try {
        fit.fit();
      } catch {
        return;
      }
      sendSize();
      term.refresh(0, term.rows - 1);
    }, 260);
    const typed = term.onData((data) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(data);
    });
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => {
      closed = true;
      window.clearTimeout(retry);
      window.clearTimeout(resizeTimer);
      window.clearTimeout(settle);
      observer.disconnect();
      typed.dispose();
      socket?.close();
      socketRef.current(null, false);
      term.dispose();
    };
  }, [tool, id, tid, mode, mobile, windowsPty?.backend, windowsPty?.buildNumber]);

  return <div className="cmd-screen" ref={host} />;
}

/** Project command lines. The AI process's own terminal (mode=terminal) remains session-bound. */
export function CmdBox({
  tool,
  id,
  cwd,
  mobile = false,
  mode = "cmd",
  runRequest = null,
  onRan,
  onClose,
}: {
  tool: ToolId;
  id: string;
  cwd: string;
  /** Fills the conversation area as a sheet. A phone has no room for a panel that is dragged to size. */
  mobile?: boolean;
  mode?: "cmd" | "terminal";
  /** A command from a reply's "运行" button, typed into the active command line once it is connected. */
  runRequest?: RunRequest | null;
  onRan?: (seq: number) => void;
  onClose: () => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const keysRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const lineRef = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState("");
  const [ready, setReady] = useState(false);
  const [terminals, setTerminals] = useState<TerminalInfo[] | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [line, setLine] = useState("");
  const [size, setSize] = useState<PanelSize>(readSize);
  /** Which header menu is open: the shortcut list or the project's services. */
  const [open, setOpen] = useState(false);
  const [servicesOpen, setServicesOpen] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  const [project, setProject] = useState<TerminalProject | null>(null);
  const [closingTid, setClosingTid] = useState<string | null>(null);
  // The shortcut list is read again each time the panel opens, so edits made elsewhere show without a refresh.
  const [shortcuts, setShortcuts] = useState<ShortcutLibrary | null>(null);
  useEffect(() => {
    if (mode !== "cmd") return;
    let gone = false;
    api.commands().then((value) => { if (!gone) setShortcuts(value); }, () => undefined);
    return () => { gone = true; };
  }, [mode]);
  const context = `${tool}:${id}:${mode}`;
  const contextRef = useRef(context);
  contextRef.current = context;
  const projectRef = useRef<TerminalProject | null>(null);
  const activeRef = useRef<string | null>(null);
  const readSequence = useRef(0);
  const mutating = useRef(false);

  const choose = useCallback(
    (tid: string) => {
      if (projectRef.current) lastTab.set(projectRef.current.key, tid);
      if (activeRef.current !== tid) { socketRef.current = null; setReady(false); }
      activeRef.current = tid;
      setActive(tid);
    },
    [],
  );

  const applyList = useCallback((result: TerminalList, preferred?: string) => {
    // Old servers did not send project metadata; keep their API usable during an upgrade.
    const scope = result.project ?? { key: workspaceTerminalKey(cwd), root: cwd, elevated: null, survivesRestart: false as const };
    projectRef.current = scope;
    setProject(current => JSON.stringify(current) === JSON.stringify(scope) ? current : scope);
    setTerminals(current => JSON.stringify(current) === JSON.stringify(result.terminals) ? current : result.terminals);
    setClosingTid(current => result.terminals.some(item => item.tid === current) ? current : null);
    const kept = preferred ?? activeRef.current ?? lastTab.get(scope.key);
    const pick = result.terminals.find(item => item.tid === kept) ?? result.terminals[0];
    if (pick) choose(pick.tid);
    else { activeRef.current = null; setActive(null); socketRef.current = null; setReady(false); }
    setProblem("");
  }, [cwd, choose]);

  /** Only the initial open ensures a terminal exists. Polling must not recreate explicitly closed terminals. */
  const load = useCallback(async (ensure = false) => {
    if (mutating.current) return;
    const sequence = ++readSequence.current;
    try {
      let result = await api.terminals(tool, id);
      if (contextRef.current !== context || sequence !== readSequence.current) return;
      if (ensure && !result.terminals.length) result = await api.newTerminal(tool, id, true);
      if (contextRef.current === context && sequence === readSequence.current) applyList(result);
    } catch {
      if (contextRef.current !== context || sequence !== readSequence.current) return;
      setTerminals(current => current ?? []);
      setProblem("项目终端列表没有读取成功。请检查连接和项目目录。");
    }
  }, [tool, id, context, applyList]);

  useEffect(() => {
    setTerminals(null);
    setActive(null);
    activeRef.current = null;
    projectRef.current = null;
    setProject(null);
    socketRef.current = null;
    setReady(false);
    setClosingTid(null);
    setStarting(false);
    mutating.current = false;
    if (mode === "terminal") return;
    void load(true);
    const timer = window.setInterval(() => { if (document.visibilityState !== "hidden") void load(); }, 2000);
    const focus = () => void load();
    window.addEventListener("focus", focus);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", focus); readSequence.current += 1; };
  }, [load, mode]);

  const addTerminal = async () => {
    if (mutating.current) return;
    mutating.current = true;
    readSequence.current += 1;
    setStarting(true);
    try {
      const result = await api.newTerminal(tool, id);
      if (contextRef.current === context) applyList(result, result.terminal.tid);
    } catch (failure) {
      if (contextRef.current === context) setProblem((failure as { code?: string }).code === "too_many" ? "一个项目最多开 8 个终端。" : "没有开出新的项目终端。");
    } finally {
      if (contextRef.current === context) { setStarting(false); mutating.current = false; }
    }
  };

  const closeTerminal = async (tid: string) => {
    if (mutating.current) return;
    mutating.current = true;
    readSequence.current += 1;
    setStarting(true);
    try {
      const result = await api.closeTerminal(tool, id, tid);
      if (contextRef.current === context) {
        if (!result.terminals.length && projectRef.current) lastTab.delete(projectRef.current.key);
        applyList(result);
        setClosingTid(null);
      }
    } catch {
      if (contextRef.current === context) setProblem("终端没有关闭，请刷新列表后重试。");
    } finally {
      if (contextRef.current === context) { mutating.current = false; setStarting(false); }
    }
  };

  const onSocket = useCallback((socket: WebSocket | null, isReady: boolean) => {
    socketRef.current = socket;
    setReady(isReady);
  }, []);
  const socketScope = `${context}:${active ?? ""}`;
  const socketScopeRef = useRef(socketScope);
  socketScopeRef.current = socketScope;
  const scopedSocket = (socket: WebSocket | null, isReady: boolean) => {
    if (socketScopeRef.current === socketScope) onSocket(socket, isReady);
  };

  useEffect(() => {
    setOpen(false);
    setServicesOpen(false);
    setChosen(null);
  }, [cwd]);

  /** A service was started: its tab may be new, so take the list the server sent and show that tab. */
  const adopt = useCallback((result: TerminalList, focus?: string) => {
    if (contextRef.current !== context) return;
    readSequence.current += 1;
    applyList(result, focus);
    if (focus) setServicesOpen(false);
  }, [context, applyList]);

  useEffect(() => {
    if (!open && !servicesOpen) return;
    const onPointer = (event: PointerEvent) => {
      if (keysRef.current?.contains(event.target as Node)) return;
      setOpen(false);
      setServicesOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      setServicesOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, servicesOpen]);

  const sendRaw = (data: string) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(data);
    return true;
  };

  const run = (command: string) => {
    if (!sendRaw(`${command}\r`)) return false;
    if (mobile) lineRef.current?.focus();
    else panel.current?.querySelector<HTMLElement>(".xterm-helper-textarea")?.focus();
    return true;
  };

  // Each line is typed and entered in turn, as if pasted into the prompt.
  const runRef = useRef(run);
  runRef.current = run;
  const ranSeq = useRef(0);
  useEffect(() => {
    if (!runRequest || mode !== "cmd" || !ready || ranSeq.current === runRequest.seq) return;
    if (!runRef.current(runRequest.command.split("\n").join("\r"))) return;
    ranSeq.current = runRequest.seq;
    onRan?.(runRequest.seq);
  }, [runRequest, mode, ready, onRan]);

  /** A phone types the whole line locally and sends it at once, instead of one round trip per key. */
  const submitLine = (event: FormEvent) => {
    event.preventDefault();
    if (!sendRaw(`${line}\r`)) return;
    setLine("");
  };

  const drag = (axis: "x" | "y" | "both") => (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const originX = event.clientX;
    const originY = event.clientY;
    const origin = { width: panel.current?.offsetWidth ?? size.width, height: panel.current?.offsetHeight ?? size.height };
    const bounds = panel.current?.parentElement?.getBoundingClientRect();
    const move = (pointer: PointerEvent) => {
      const maxWidth = bounds ? bounds.width : 960;
      const maxHeight = bounds ? bounds.height : 720;
      const next = { ...origin };
      if (axis !== "y") next.width = origin.width + (originX - pointer.clientX);
      if (axis !== "x") next.height = origin.height + (pointer.clientY - originY);
      next.width = Math.round(Math.min(maxWidth, Math.max(320, next.width)));
      next.height = Math.round(Math.min(maxHeight, Math.max(260, next.height)));
      setSize(next);
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      setSize((current) => {
        localStorage.setItem(SIZE_KEY, JSON.stringify(current));
        return current;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };

  return (
    <section
      className={mobile ? "cmd-box is-sheet" : "cmd-box"}
      aria-label={mode === "terminal" ? "会话终端" : "命令行"}
      ref={panel}
      style={mobile ? undefined : { width: size.width, height: size.height }}
    >
      <div className="cmd-keys" ref={keysRef}>
        {mode === "terminal" && <span>会话终端</span>}
        {mode === "cmd" && (
          <>
        <div className="cmd-tabs" role="tablist" aria-label="命令行">
          {(terminals ?? []).map((item) => {
            const current = item.tid === active;
            return (
              <div className={current ? "cmd-tab is-active" : "cmd-tab"} key={item.tid}>
                <button type="button" role="tab" aria-selected={current} title={`命令行 ${item.label}`} onClick={() => choose(item.tid)}>
                  {item.label}
                </button>
                {current && (
                  <button
                    type="button"
                    className="cmd-tab-close"
                    aria-label={`关闭命令行 ${item.label}`}
                    title="关闭项目终端，会停止其中的程序并影响此项目其他会话"
                    disabled={starting}
                    onClick={() => setClosingTid(item.tid)}
                  >
                    <CloseIcon />
                  </button>
                )}
              </div>
            );
          })}
          <button
            type="button"
            className="cmd-tab-add"
            aria-label="再开一个命令行"
            title="再开一个命令行"
            disabled={starting || terminals === null || (terminals?.length ?? 0) >= 8}
            onClick={() => void addTerminal()}
          >
            <PlusIcon />
          </button>
        </div>
        <button
          type="button"
          className={open ? "cmd-pick is-open" : "cmd-pick"}
          aria-expanded={open}
          aria-controls={open ? "global-shortcut-menu" : undefined}
          onClick={() => { setServicesOpen(false); setOpen((value) => !value); }}
        >
          <span>{chosen ?? "快捷命令"}</span>
          <span className="cmd-chevron"><ChevronIcon /></span>
        </button>
        <button
          type="button"
          className={servicesOpen ? "cmd-pick is-open" : "cmd-pick"}
          aria-expanded={servicesOpen}
          aria-controls={servicesOpen ? "project-service-menu" : undefined}
          title="一键启动、重启项目的前端和后端"
          onClick={() => { setOpen(false); setServicesOpen((value) => !value); }}
        >
          <span>启动服务</span>
          <span className="cmd-chevron"><ChevronIcon /></span>
        </button>
          </>
        )}
        <button
          type="button"
          className="icon-button"
          aria-label={mode === "terminal" ? "收起会话终端" : "收起命令行"}
          title={mode === "terminal" ? cwd : `收起。命令行会在后台继续运行\n${cwd}`}
          onClick={onClose}
        >
          <CloseIcon />
        </button>
        {open && mode === "cmd" && (
          <ShortcutMenu key={`${tool}:${id}:${active}`} cwd={cwd} ready={ready} initial={shortcuts} onRun={run} onChoose={name => { setChosen(name); setOpen(false); }} />
        )}
        {servicesOpen && mode === "cmd" && (
          <ServiceMenu key={`${tool}:${id}`} tool={tool} id={id} onTerminals={adopt} onShow={tid => { choose(tid); setServicesOpen(false); }} />
        )}
      </div>
      {closingTid && mode === "cmd" && <div className="cmd-close-confirm" role="alert">
        <p>关闭项目终端 {terminals?.find(item => item.tid === closingTid)?.label}？会停止其中的程序，并影响此项目其他会话。</p>
        <button type="button" disabled={starting} onClick={() => void closeTerminal(closingTid)}>关闭终端</button>
        <button type="button" disabled={starting} onClick={() => setClosingTid(null)}>取消</button>
      </div>}
      {problem && <p className="cmd-note">{problem}</p>}
      {mode === "cmd" && terminals?.length === 0 && !problem && <p className="cmd-note">项目暂无终端，点击“＋”新建。服务重启后需重新启动原来运行的程序。</p>}
      {mode === "terminal" && (
        <TermScreen key="terminal" tool={tool} id={id} tid="" mode="terminal" mobile={mobile} onSocket={scopedSocket} onGone={() => {}} />
      )}
      {mode === "cmd" && active && (
        <TermScreen key={active} tool={tool} id={id} tid={active} mobile={mobile} windowsPty={project?.windowsPty} onSocket={scopedSocket} onGone={() => void load()} />
      )}
      {mobile && (mode === "terminal" || (active && !problem)) && (
        <div className="cmd-line">
          <div className="cmd-line-keys">
            {PHONE_KEYS.map((key) => (
              <button type="button" key={key.label} title={key.title} disabled={!ready} onClick={() => sendRaw(key.data)}>
                {key.label}
              </button>
            ))}
          </div>
          <form onSubmit={submitLine}>
            <input
              ref={lineRef}
              aria-label="要执行的命令"
              placeholder={ready ? "输入命令，回车执行" : "正在连接命令行"}
              value={line}
              enterKeyHint="send"
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setLine(event.target.value)}
            />
            <button type="submit" disabled={!ready}>
              执行
            </button>
          </form>
        </div>
      )}
      {!mobile && (
        <>
          <button type="button" className="cmd-grip is-x" aria-label="拉宽命令行" onPointerDown={drag("x")} />
          <button type="button" className="cmd-grip is-y" aria-label="拉高命令行" onPointerDown={drag("y")} />
          <button type="button" className="cmd-grip is-both" aria-label="拉宽并拉高命令行" onPointerDown={drag("both")} />
        </>
      )}
    </section>
  );
}
