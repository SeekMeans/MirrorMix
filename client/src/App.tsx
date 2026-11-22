import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ALL_TOOLS, api, type Catalog, type ScheduleJob, type ToolId, type ToolPrefs, type WorkspaceGroup } from "./api";
import { CmdBox } from "./CmdBox";
import { ActionDock } from "./ActionDock";
import { RUN_COMMAND, type RunRequest } from "./runCommand";
import { OPEN_FILE, type OpenFileRequest } from "./openFile";
import { workspaceTerminalKey } from "../../src/shared/terminalScope";

import { ModelChip } from "./ModelChip";
import { FileBrowser } from "./FileBrowser";
import { Composer, MessageList } from "./Conversation";
import { BackIcon, ChatsIcon, GearIcon, MenuIcon, PuzzleIcon, PushpinIcon, Spinner, TrashIcon, WorkbenchIcon } from "./icons";
import { PluginsDialog, type PluginId } from "./Plugins";
import { SettingsDialog, type MenuPage, type Section } from "./Settings";
import { Sidebar, type RailView } from "./Sidebar";
import { TodayStats } from "./TodayStats";
import { isWorkbenchQuiet } from "./workbench";
import { errorText, oneLine, toolName } from "./text";
import { useFinished } from "./useFinished";
import { useMobile } from "./useMobile";
import { useSession, type SessionState } from "./useSession";

/** On a phone one screen shows at a time. The conversation is pushed on top of the list and has no tab bar. */
type Screen = "list" | "chat" | "plugins" | "settings";

type Tone = "busy" | "ready" | "working" | "attention" | "off";

/** One line that says what the session is doing right now, and how the strip under the header should look. */
function describe(state: SessionState | null): { tone: Tone; text: string } {
  if (!state || state.phase === "loading") return { tone: "busy", text: "正在读取会话" };
  if (state.phase === "missing") return { tone: "attention", text: "会话不在了" };
  if (state.opening) return { tone: "busy", text: "正在接入进程" };
  if (state.link === "reconnecting") return { tone: "busy", text: "连接断开，正在重连" };
  if (state.link === "polling") return { tone: "ready", text: "正在通过轮询更新会话" };
  const meta = state.meta;
  if (!meta) return { tone: "off", text: "" };
  if (meta.readOnlyReason) return { tone: "off", text: "历史记录 · 仅查看" };
  if (meta.status === "running") {
    // Following Claude Code keeps the steady signal. The pulsing control beside the title says it is live.
    if (meta.attached !== "process") return { tone: "ready", text: "" };
    if (turnOpen(state) || !meta.sendEnabled) return { tone: "working", text: "" };
    return { tone: "ready", text: "" };
  }
  if (meta.status === "starting") return { tone: "busy", text: "正在创建" };
  if (meta.status === "occupied") return { tone: "off", text: "未接入" };
  if (meta.status === "exited") return { tone: "off", text: "进程已退出" };
  if (meta.status === "failed" || meta.status === "create_failed") return { tone: "attention", text: "启动失败" };
  return { tone: "off", text: "未接入" };
}

function turnOpen(state: SessionState | null): boolean {
  return Boolean(state?.messages.some((message) => message.role === "turn" && !message.endedAt));
}

function composerHint(state: SessionState | null, mobile: boolean): string {
  const hint = desktopHint(state);
  // A phone keyboard's return key makes a new line; the button sends.
  return mobile ? hint.replace("。Enter 发送，Shift+Enter 换行", "") : hint;
}

function desktopHint(state: SessionState | null): string {
  if (!state || state.phase === "loading") return "正在读取会话";
  if (state.opening) return "正在接入进程，接上后就能发送";
  const meta = state.meta;
  if (meta?.readOnlyReason === "deepseek_app_session") return "打开 DSH 后才能从这里继续这条会话";
  if (meta?.readOnlyReason) return "这条历史记录目前只能查看，请在桌面端打开对应会话后刷新";
  if (!meta || meta.status !== "running") return "进程没有在运行，重新接入后才能发送";
  if (meta.takenOver) {
    return turnOpen(state)
      ? "已由 MirrorMix 接管。这一轮还在进行，现在发送会排进队列"
      : meta.tool === "deepseek"
        ? "这条由 DSH 的命令行在后台回复。桌面端要重新打开这条会话才看得到新内容"
        : meta.tool === "cursor"
        ? "Cursor 窗口发不出去（比如锁屏了），这条由 Cursor 命令行在后台回复。Cursor 窗口里可能看不到"
        : "Claude 桌面版发不出去（比如锁屏了），已由 MirrorMix 接管。桌面版要重新点开这条会话才看得到新内容";
  }
  if (meta.inputPrompt) return "终端正在等待确认，请查看上方提示";
  if (meta.attached !== "process" && turnOpen(state)) return "消息响应中...";
  if (meta.attached !== "process") return `写到 ${toolName[meta.tool]} 桌面端的同一条会话。Enter 发送，Shift+Enter 换行`;
  if (meta.sendEnabled && turnOpen(state)) return "这一轮还在进行。现在发送会排进队列";
  if (meta.sendEnabled) return "写给这个会话。Enter 发送，Shift+Enter 换行";
  return "这一轮结束后才能发送";
}


export function App({ onLogout }: { onLogout?: () => void }) {
  const [tool, setTool] = useState<ToolId>("claude");
  // The list opens on the sessions still replying, across all tools.
  const [railView, setRailView] = useState<RailView>("running");
  /** The tab last used inside 会话 on a phone (钉住 or a tool), so returning to 会话 lands on it again. */
  const sessionsView = useRef<RailView>("tool");
  if (railView !== "running") sessionsView.current = railView;
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [offline, setOffline] = useState(false);
  const [notice, setNotice] = useState("");
  const [jobs, setJobs] = useState<ScheduleJob[]>([]);
  const [creatingPath, setCreatingPath] = useState<string | null>(null);
  const [railOpen, setRailOpen] = useState(false);
  const [prefs, setPrefs] = useState<ToolPrefs | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const [settingsError, setSettingsError] = useState("");
  const [cmdOpen, setCmdOpenState] = useState(false);
  /** Projects whose terminal panel was left open. */
  const cmdShown = useRef(new Set<string>());
  const [cmdMode, setCmdMode] = useState<"cmd" | "terminal">("cmd");
  const [filesOpen, setFilesOpen] = useState(false);
  const mobile = useMobile();
  const [screen, setScreen] = useState<Screen>("list");
  const session = useSession();
  const { state, target, select, clear } = session;
  const meta = state?.meta ?? null;
  const toolRef = useRef(tool);
  toolRef.current = tool;

  const refreshCatalog = useCallback(async () => {
    try {
      setCatalog(await api.catalog());
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, []);

  // The list is re-read every two seconds, but only while the tab is on screen.
  useEffect(() => {
    void refreshCatalog();
    const timer = window.setInterval(() => {
      if (!document.hidden) void refreshCatalog();
    }, 2000);
    const onVisible = () => {
      if (!document.hidden) void refreshCatalog();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refreshCatalog]);

  useEffect(() => {
    let stopped = false;
    const load = () =>
      api.schedules().then(
        (next) => !stopped && setJobs(next),
        () => !stopped && setJobs([]),
      );
    void load();
    // Only read again while the 定时任务 plugin can be on screen.
    if (!pluginsOpen && screen !== "plugins") return () => void (stopped = true);
    const timer = window.setInterval(load, 10_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [pluginsOpen, screen]);

  const refreshPrefs = useCallback(async () => {
    try {
      setPrefs(await api.settings());
      setCheckedAt(new Date());
      return true;
    } catch {
      return false;
    }
  }, []);

  // Whether each tool's app is open is checked every five seconds while the tab is on screen.
  useEffect(() => {
    void refreshPrefs();
    const timer = window.setInterval(() => {
      if (!document.hidden) void refreshPrefs();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [refreshPrefs]);

  const shownTools = prefs?.tools ?? ALL_TOOLS;
  const offlineTools = useMemo(() => (prefs ? ALL_TOOLS.filter((item) => !prefs.status[item].running) : []), [prefs]);
  const usable = shownTools.includes(tool) && !offlineTools.includes(tool);

  // When the tool on screen is switched off or its app is closed, move to one that can be used.
  useEffect(() => {
    if (!prefs || usable) return;
    const next = prefs.tools.find((item) => prefs.status[item].running);
    clear();
    setNotice("");
    if (next) setTool(next);
    else if (prefs.tools.length && !prefs.tools.includes(tool)) setTool(prefs.tools[0]);
  }, [prefs, usable, tool, clear]);

  // Read through a ref so two switches flipped in quick succession both count.
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  /** Pins or unpins a session in MirrorMix (never in the tool itself). Shown at once, undone if it was not saved. */
  const togglePin = useCallback((item: ToolId, id: string) => {
    const before = prefsRef.current;
    if (!before) return;
    const key = `${item}:${id}`;
    const current = before.pinned ?? [];
    const pinned = current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key];
    const next = { ...before, pinned };
    prefsRef.current = next;
    setPrefs(next);
    api.saveSettings({ pinned }).then(
      (saved) => {
        if (prefsRef.current === next) setPrefs(saved);
      },
      () => {
        if (prefsRef.current === next) setPrefs(before);
        setNotice("没有钉住。确认 MirrorMix 进程还在运行，再试一次。");
      },
    );
  }, []);
  const toggleTool = useCallback((item: ToolId, shown: boolean) => {
    const before = prefsRef.current;
    if (!before) return;
    const tools = ALL_TOOLS.filter((candidate) => (candidate === item ? shown : before.tools.includes(candidate)));
    const next = { ...before, tools };
    prefsRef.current = next;
    setSettingsError("");
    setPrefs(next);
    api.saveSettings({ tools }).then(
      (saved) => {
        // An older save answering late must not undo a newer choice.
        if (prefsRef.current === next) setPrefs(saved);
      },
      () => {
        if (prefsRef.current === next) setPrefs(before);
        setSettingsError("设置没有保存。确认 MirrorMix 进程还在运行，再试一次。");
      },
    );
  }, []);

  const checkNow = useCallback(async () => {
    setChecking(true);
    setSettingsError("");
    const reached = await refreshPrefs();
    if (!reached) setSettingsError("检测没有完成。确认 MirrorMix 进程还在运行，再试一次。");
    setChecking(false);
  }, [refreshPrefs]);

  /** Where settings open: usually the first section, the plugin market when 我的插件 sends the person there. */
  const [settingsStart, setSettingsStart] = useState<Section | MenuPage | undefined>(undefined);
  const openSettings = useCallback(() => {
    setSettingsStart(undefined);
    setSettingsOpen(true);
  }, []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  // 我的插件: what was added from the plugin market, kept on the PC so every device sees the same list.
  const [installed, setInstalled] = useState<string[] | null>(null);
  const [pluginBusy, setPluginBusy] = useState(false);
  useEffect(() => {
    api.plugins().then(
      (result) => setInstalled(result.installed),
      () => setInstalled([]),
    );
  }, []);
  const changePlugin = useCallback(
    async (id: PluginId, add: boolean) => {
      if (!installed) return;
      const next = add ? [...installed.filter((item) => item !== id), id] : installed.filter((item) => item !== id);
      setPluginBusy(true);
      try {
        setInstalled((await api.setPlugins(next)).installed);
      } catch (error) {
        setSettingsError(errorText((error as { code?: string }).code));
      } finally {
        setPluginBusy(false);
      }
    },
    [installed],
  );
  const openMarket = useCallback(() => {
    if (mobile) setPluginsOpen(false);
    setSettingsStart("market");
    if (mobile) setScreen("settings");
    else setSettingsOpen(true);
  }, [mobile]);

  const summary = useMemo(() => {
    if (!catalog || !target) return null;
    for (const group of catalog[target.tool]) {
      const found = group.sessions.find((item) => item.id === target.id);
      if (found) return { title: found.title, path: group.path };
    }
    return null;
  }, [catalog, target]);

  // The conversation screen is a history entry of its own, so the phone's back gesture returns to the list.
  const chatEntry = useRef(false);
  const showChat = useCallback(() => {
    setScreen("chat");
    if (!chatEntry.current) {
      try {
        window.history.pushState({ mirrormix: "chat" }, "");
        chatEntry.current = true;
      } catch {
        /* history is not available in this frame: the back button still works */
      }
    }
  }, []);
  const leaveChat = useCallback(() => {
    if (chatEntry.current) window.history.back();
    else setScreen("list");
  }, []);
  useEffect(() => {
    const onPop = () => {
      if (!chatEntry.current) return;
      chatEntry.current = false;
      setScreen("list");
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const pluginsEntry = useRef(false);
  // The plugin chosen from a row of 设置.
  const [pluginStart, setPluginStart] = useState<PluginId | undefined>(undefined);
  const showPlugins = useCallback((id?: PluginId) => {
    setPluginStart(id);
    setScreen("plugins");
    if (pluginsEntry.current) return;
    try {
      window.history.pushState({ mirrormix: "plugins" }, "");
      pluginsEntry.current = true;
    } catch {
      /* no history here: the back button on the page still works */
    }
  }, []);
  const leavePlugins = useCallback(() => {
    if (pluginsEntry.current) window.history.back();
    else setScreen("settings");
  }, []);
  useEffect(() => {
    const onPop = () => {
      if (!pluginsEntry.current) return;
      // Closing a plugin inside the page lands back on this entry: still on 插件.
      const state = window.history.state as { mirrormix?: string } | null;
      if (state?.mirrormix === "plugins" || state?.mirrormix === "plugin") return;
      pluginsEntry.current = false;
      setScreen("settings");
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Sessions the person closed by hand stay closed; everything else is joined again without being asked.
  const closedByHand = useRef(new Set<string>());
  const autoJoins = useRef(new Map<string, number>());

  const choose = useCallback(
    (id: string) => {
      setNotice("");
      setRailOpen(false);
      const key = `${toolRef.current}:${id}`;
      closedByHand.current.delete(key);
      autoJoins.current.delete(key);
      select(toolRef.current, id, { open: true });
      showChat();
    },
    [select, showChat],
  );

  // A session on screen whose process is not running is joined automatically. Two tries in a row,
  // so a process that keeps dying does not loop; a spell of running normally resets the count.
  const joinKey = state?.key ?? "";
  const joinStatus = meta?.status;
  const joinable = Boolean(target && state?.phase === "ready" && !state.opening && !state.openError && !meta?.readOnlyReason);
  const settled = joinStatus === "running" && Boolean(meta?.sendEnabled);
  useEffect(() => {
    if (!target || !joinKey) return;
    if (settled) {
      autoJoins.current.delete(joinKey);
      return;
    }
    if (!joinable || (joinStatus !== "idle" && joinStatus !== "exited")) return;
    if (closedByHand.current.has(joinKey)) return;
    const tries = autoJoins.current.get(joinKey) ?? 0;
    if (tries >= 2) return;
    autoJoins.current.set(joinKey, tries + 1);
    select(target.tool, target.id, { open: true });
  }, [target, joinKey, joinStatus, joinable, settled, select]);

  const switchTool = useCallback(
    (next: ToolId) => {
      setPluginsOpen(false);
      setRailView("tool");
      if (next === toolRef.current) return;
      setTool(next);
      clear();
      setNotice("");
    },
    [clear],
  );

  const showRunning = useCallback(() => {
    setPluginsOpen(false);
    setRailView("running");
    clear();
  }, [clear]);

  const showPinned = useCallback(() => {
    setPluginsOpen(false);
    setRailView("pinned");
  }, []);

  // A row in the running list may belong to another tool: switch to it without closing anything, then open the row.
  const chooseIn = useCallback(
    (next: ToolId, id: string) => {
      if (next !== toolRef.current) {
        toolRef.current = next;
        setTool(next);
      }
      choose(id);
    },
    [choose],
  );

  const createSession = useCallback(
    async (group: WorkspaceGroup) => {
      if (prefs?.capabilities?.create[toolRef.current] === false) {
        setNotice(errorText("desktop_create_required"));
        return;
      }
      setCreatingPath(group.path);
      setNotice("");
      try {
        const created = await api.create(toolRef.current, group.path);
        setRailOpen(false);
        select(created.tool, created.id, { seed: created });
        showChat();
        await refreshCatalog();
      } catch (error) {
        setNotice(errorText((error as { code?: string }).code));
      } finally {
        setCreatingPath(null);
      }
    },
    [select, refreshCatalog, showChat, prefs],
  );

  const dismissRail = useCallback(() => setRailOpen(false), []);

  // A new Codex session goes by a stand-in id until its first message is written; then the page follows the real one.
  const shownId = meta?.id;
  useEffect(() => {
    if (!meta || !target || meta.tool !== target.tool || meta.id === target.id) return;
    select(meta.tool, meta.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownId]);

  const [answering, setAnswering] = useState(false);
  async function answerTrust(choice: "trust" | "cancel") {
    if (!meta) return;
    setAnswering(true);
    try {
      await api.answer(meta.tool, meta.id, choice);
      setNotice("");
    } catch (error) {
      setNotice(errorText((error as { code?: string }).code));
    } finally {
      setAnswering(false);
    }
  }

  /** Asked first: the confirmation says what deleting does for this kind of session. */
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  useEffect(() => setConfirmingDelete(false), [target?.tool, target?.id]);
  async function deleteSession() {
    if (!target || deleting) return;
    setDeleting(true);
    try {
      const { removed } = await api.deleteSession(target.tool, target.id);
      setConfirmingDelete(false);
      clear();
      await refreshCatalog();
      setNotice(removed === "trash" ? "会话已删除，文件放进了回收站。" : "会话已从列表移除。它在原来的应用里还在。");
      if (mobile) leaveChat();
    } catch (error) {
      setNotice(errorText((error as { code?: string }).code));
    } finally {
      setDeleting(false);
    }
  }

  async function closeSession() {
    if (state) closedByHand.current.add(state.key);
    try {
      await session.close();
    } catch (error) {
      setNotice(errorText((error as { code?: string }).code));
    }
  }

  const [stopping, setStopping] = useState(false);
  async function interrupt() {
    if (!meta || stopping) return;
    setStopping(true);
    try {
      await api.interrupt(meta.tool, meta.id);
      setNotice("");
    } catch (error) {
      setNotice(errorText((error as { code?: string }).code));
    } finally {
      setStopping(false);
    }
  }

  async function send(text: string): Promise<boolean> {
    if (!meta) return false;
    try {
      await api.send(meta.tool, meta.id, text);
      setNotice("");
      return true;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "not_idle") {
        setNotice(meta.attached === "claude" ? "Claude 正在回复，等这一轮结束再发。" : "消息没有发出。这一轮还没结束，等它完成再发。");
      } else {
        setNotice(errorText(code));
      }
      return false;
    }
  }

  async function sendNow(text: string): Promise<boolean> {
    if (!meta) return false;
    try {
      await api.sendNow(meta.tool, meta.id, text);
      setNotice("");
      return true;
    } catch (error) {
      setNotice(errorText((error as { code?: string }).code));
      return false;
    }
  }

  function placeOf(job: ScheduleJob): string {
    if (!catalog) return job.location;
    for (const group of [...catalog.claude, ...catalog.codex, ...catalog.cursor, ...(catalog.deepseek ?? [])]) {
      const found = group.sessions.find((item) => item.id === job.location);
      if (found) return found.title;
    }
    return job.location;
  }

  const status = describe(state);
  const title = meta?.title || summary?.title || "会话";
  const workspacePath = meta?.workspacePath || summary?.path || "";
  const sessionKey = target ? `${target.tool}:${target.id}` : "";
  const terminalPanelKey = workspacePath ? workspaceTerminalKey(workspacePath) : "";

  // Coming back to a session shows its command lines again if they were showing when it was left.
  useEffect(() => {
    setCmdOpenState(cmdShown.current.has(terminalPanelKey));
    setFilesOpen(false);
    setCmdMode("cmd");
  }, [sessionKey, terminalPanelKey]);

  const setCmdOpen = (next: boolean | ((open: boolean) => boolean)) => {
    setCmdOpenState((current) => {
      const value = typeof next === "function" ? next(current) : next;
      if (value) cmdShown.current.add(terminalPanelKey);
      else cmdShown.current.delete(terminalPanelKey);
      return value;
    });
  };
  const setCmdOpenRef = useRef(setCmdOpen);
  setCmdOpenRef.current = setCmdOpen;

  // A file named in a reply: open the file browser at it.
  const [fileRequest, setFileRequest] = useState<OpenFileRequest | null>(null);
  useEffect(() => {
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<OpenFileRequest>).detail;
      if (!detail?.path) return;
      setFileRequest(detail);
      setFilesOpen(true);
    };
    window.addEventListener(OPEN_FILE, onOpen);
    return () => window.removeEventListener(OPEN_FILE, onOpen);
  }, []);
  useEffect(() => setFileRequest(null), [sessionKey]);

  // A reply's "运行" button: open the command line and hand it the command, which it types once connected.
  const [runRequest, setRunRequest] = useState<RunRequest | null>(null);
  useEffect(() => {
    const onRun = (event: Event) => {
      const detail = (event as CustomEvent<RunRequest>).detail;
      if (!detail?.command) return;
      setRunRequest(detail);
      setCmdMode("cmd");
      setCmdOpenRef.current(true);
    };
    window.addEventListener(RUN_COMMAND, onRun);
    return () => window.removeEventListener(RUN_COMMAND, onRun);
  }, []);
  // A request belongs to the session it was clicked in.
  useEffect(() => setRunRequest(null), [sessionKey]);

  // A conversation that went away (its tool was switched off or closed) takes its screen with it.
  useEffect(() => {
    if (screen === "chat" && !target) leaveChat();
  }, [screen, target, leaveChat]);

  const conversationShown = !mobile || screen === "chat";
  const listShown = !mobile || screen === "list";
  // On a phone, going back to the list leaves the session even though it stays selected.
  // On a phone the last session stays chosen after going back to the list; it is only seen while its page is showing.
  const finished = useFinished(catalog, conversationShown ? sessionKey : "");
  // Today's figures only when the workbench is quiet: nothing replying and no finished reply waiting to be read.
  const workbenchQuiet = useMemo(() => isWorkbenchQuiet(catalog, shownTools, offlineTools, finished), [catalog, shownTools, offlineTools, finished]);
  const homeCount = useMemo(() => {
    if (!catalog) return { all: 0, live: 0 };
    let all = 0;
    let live = 0;
    for (const item of shownTools) {
      if (offlineTools.includes(item)) continue;
      const seen = new Set<string>();
      for (const group of catalog[item] ?? []) {
        for (const session of group.sessions) {
          if (seen.has(session.id)) continue;
          if (session.working) {
            seen.add(session.id);
            all += 1;
            live += 1;
          } else if (finished.has(`${item}:${session.id}`)) {
            seen.add(session.id);
            all += 1;
          }
        }
      }
    }
    return { all, live };
  }, [catalog, shownTools, offlineTools, finished]);
  const tabs = mobile && screen !== "chat";
  const loadingId = target && (!state || state.phase === "loading" || state.opening) ? target.id : null;
  const canReopen = Boolean(
    target && state?.phase === "ready" && !state.opening && meta && !meta.readOnlyReason && meta.status !== "running" && meta.status !== "starting",
  );

  return (
    <div className={`shell${railOpen && !mobile ? " rail-shown" : ""}${mobile ? ` is-mobile on-${screen}` : ""}${!mobile && pluginsOpen ? " on-plugins" : ""}`}>
      {listShown && (
      <Sidebar
        mobile={mobile}
        view={railView}
        tool={tool}
        catalog={catalog}
        finished={finished}
        offline={offline}
        selectedId={target?.id ?? null}
        selectedTool={target?.tool ?? null}
        loadingId={loadingId}
        creatingPath={creatingPath}
        canCreate={prefs?.capabilities?.create[tool] ?? true}
        host={prefs?.host ?? ""}
        tools={shownTools}
        offlineTools={offlineTools}
        onSettings={openSettings}
        onPlugins={() => setPluginsOpen(true)}
        pluginsActive={!mobile && pluginsOpen}
        onLogout={onLogout}
        onRunning={showRunning}
        pinned={prefs?.pinned ?? []}
        onPinned={showPinned}
        onTool={switchTool}
        onChoose={choose}
        onChooseIn={chooseIn}
        today={mobile && workbenchQuiet ? <TodayStats tools={shownTools} onOpen={chooseIn} compact /> : undefined}
        onCreate={createSession}
        onDismiss={dismissRail}
      />
      )}
      {!mobile && <div className="rail-backdrop" onClick={dismissRail} />}

      {!mobile && pluginsOpen && (
        <main className="conversation plugin-page">
          <PluginsDialog variant="desk" installed={installed} context={{ jobs, placeOf }} onOpenMarket={openMarket} onClose={() => setPluginsOpen(false)} />
        </main>
      )}

      {conversationShown && !(!mobile && pluginsOpen) && (
      <main className="conversation">
        {!target && (
          <div className="welcome">
            <button type="button" className="quiet-button rail-open" onClick={() => setRailOpen(true)}>
              <MenuIcon />
              会话列表
            </button>
            {workbenchQuiet && <TodayStats tools={shownTools} onOpen={chooseIn} />}
            {railView === "pinned" ? (
              <>
                <h1>钉住的会话</h1>
                <p>左侧是你在各个 AI 工具里钉住的会话，按工具分组。点开一条就能接着聊。</p>
                <p>要钉住一条会话，打开它，点右上角的钉；再点一次取消。钉只记在 MirrorMix 里，不会改动 AI 工具自己的置顶。</p>
              </>
            ) : railView === "running" ? null : usable ? (
              <>
                <h1>选一条会话，接着聊</h1>
                <p>
                  左侧按工作区列出了这台机器上 {toolName[tool]} 的会话。打开其中一条，MirrorMix
                  会在它的工作区里接入进程，你在这里写的话会直接送进去。
                </p>
                <p>想从头开始，点工作区名字右边的加号。</p>
              </>
            ) : shownTools.length === 0 ? (
              <>
                <h1>先选择要用的 AI 工具</h1>
                <p>设置里一个工具都没有打开。选中的工具会显示在左侧。</p>
                <button type="button" className="quiet-button" onClick={openSettings}>
                  打开设置
                </button>
              </>
            ) : (
              <>
                <h1>没有检测到开启的 AI 工具</h1>
                <p>
                  {shownTools.map((item) => toolName[item]).join("、")} 的客户端都没有在本机开启。打开其中一个，
                  这里会在几秒内自动恢复。
                </p>
                <button type="button" className="quiet-button" disabled={checking} onClick={() => void checkNow()}>
                  {checking && <Spinner />}
                  {checking ? "正在检测" : "重新检测"}
                </button>
              </>
            )}
            {notice && <p className="banner is-warning">{notice}</p>}
          </div>
        )}

        {target && (
          <>
            <header className="session-head">
              {mobile ? (
                <button type="button" className="icon-button back-button" aria-label="返回会话列表" onClick={leaveChat}>
                  <BackIcon />
                </button>
              ) : (
                <button type="button" className="icon-button rail-open" aria-label="打开会话列表" onClick={() => setRailOpen(true)}>
                  <MenuIcon />
                </button>
              )}
              <div className="session-actions">
                {status.text && (
                  <span className={`status is-${status.tone}`} role="status" aria-live="polite">
                    {status.tone === "busy" ? <Spinner /> : <span className="dot" />}
                    {status.text}
                  </span>
                )}
                {canReopen && (
                  <button type="button" className="quiet-button" onClick={() => choose(target.id)}>
                    重新接入
                  </button>
                )}
                {meta?.status === "running" && (
                  <button
                    type="button"
                    className="follow-button"
                    aria-label={meta.attached !== "process" ? "停止跟随" : "关闭进程"}
                    title={meta.attached !== "process" ? "正在跟随桌面端里的这条会话。点击停止跟随" : "运行中。放上去后点击，关闭进程"}
                    onClick={() => void closeSession()}
                  >
                    <span className="follow-ring" aria-hidden="true" />
                    <span className="follow-ring late" aria-hidden="true" />
                    <span className="follow-core" aria-hidden="true" />
                  </button>
                )}
              </div>
              <div className="session-name">
                <h1 title={title}>{oneLine(title)}</h1>
              </div>
              {(() => {
                const isPinned = Boolean(prefs?.pinned?.includes(`${target.tool}:${target.id}`));
                return (
                  <button
                    type="button"
                    className={isPinned ? "icon-button session-pin is-on" : "icon-button session-pin"}
                    aria-pressed={isPinned}
                    aria-label={isPinned ? "取消钉住" : "钉住这条会话"}
                    title={isPinned ? "取消钉住" : "钉住：放到左侧“钉住”里，随时打开"}
                    disabled={!prefs}
                    onClick={() => togglePin(target.tool, target.id)}
                  >
                    <PushpinIcon size={18} filled={isPinned} />
                  </button>
                );
              })()}
              {/* Last in the row, apart from the session's other controls. Only sessions created here. */}
              {meta?.deletable && (
                <button
                  type="button"
                  className={confirmingDelete ? "icon-button session-delete is-on" : "icon-button session-delete"}
                  aria-label="删除会话"
                  title="删除会话"
                  disabled={!state || state.phase !== "ready"}
                  onClick={() => setConfirmingDelete((value) => !value)}
                >
                  <TrashIcon />
                </button>
              )}
            </header>
            <div className={`signal is-${status.tone}`} aria-hidden="true" />

            <div className="thread-stage">
              {notice && <p className="banner is-warning">{notice}</p>}
              {confirmingDelete && target && meta?.deletable && (
                <div className="banner is-question" role="alertdialog" aria-label="删除会话">
                  <p>
                    删除“{oneLine(title)}”？
                    {target.tool === "cursor" || target.tool === "deepseek"
                      ? `${toolName[target.tool]} 的会话只会从这里的列表移除，${toolName[target.tool]} 里还在。`
                      : "如果它在桌面版里，只会从这里的列表移除；只在命令行用过的，会把记录文件移到回收站，需要时可以从回收站还原。"}
                  </p>
                  <div className="banner-actions">
                    <button type="button" className="quiet-button is-danger" disabled={deleting} onClick={() => void deleteSession()}>
                      {deleting ? "正在删除…" : "删除"}
                    </button>
                    <button type="button" className="quiet-button" disabled={deleting} onClick={() => setConfirmingDelete(false)}>
                      取消
                    </button>
                  </div>
                </div>
              )}
              {meta?.question === "trust" && (
                <div className="banner is-question" role="alertdialog" aria-label="是否信任这个文件夹">
                  <p>
                    {meta.tool === "codex" ? "Codex" : "Claude"} 第一次在这个文件夹里以命令行运行，先确认是否信任
                    <code>{workspacePath}</code>。信任后它可以读写、执行这个文件夹里的文件，以后不会再问。
                  </p>
                  <div className="banner-actions">
                    <button type="button" className="quiet-button is-primary" disabled={answering} onClick={() => void answerTrust("trust")}>
                      信任并继续
                    </button>
                    <button type="button" className="quiet-button" disabled={answering} onClick={() => void answerTrust("cancel")}>
                      不信任
                    </button>
                  </div>
                </div>
              )}
              {state?.openError && <p className="banner is-warning">{errorText(state.openError)}</p>}
              {meta?.readOnlyReason && <p className="banner">{errorText(meta.readOnlyReason)}</p>}
              {meta?.inputPrompt && (
                <div className="banner is-warning">
                  <p>终端正在等待你的选择，请在会话终端处理后继续聊天。</p>
                  <pre style={{ whiteSpace: "pre-wrap", maxHeight: 220, overflow: "auto" }}>{meta.inputPrompt}</pre>
                  <button type="button" onClick={() => { setCmdMode("terminal"); setCmdOpen(true); }}>打开会话终端</button>
                </div>
              )}
              {meta?.exitNote && meta.status !== "running" && !state?.opening && (
                <p className="banner is-warning">进程启动后就退出了，它最后输出的是：{meta.exitNote}</p>
              )}

              <MessageList session={session} state={state ?? PLACEHOLDER} />

              <ActionDock
                tool={target.tool}
                id={target.id}
                workspacePath={workspacePath}
                cmdOpen={cmdOpen && cmdMode === "cmd"}
                filesOpen={filesOpen}
                onCmd={() => { setCmdMode("cmd"); setCmdOpen((open) => cmdMode === "cmd" ? !open : true); }}
                onFiles={() => setFilesOpen((open) => !open)}
              />

              {filesOpen && target && workspacePath && (
                <FileBrowser tool={target.tool} id={target.id} cwd={workspacePath} mobile={mobile} reveal={fileRequest} onClose={() => setFilesOpen(false)} />
              )}

              {cmdOpen && target && workspacePath && (
                <CmdBox
                  tool={target.tool}
                  id={target.id}
                  cwd={workspacePath}
                  mobile={mobile}
                  mode={cmdMode}
                  runRequest={runRequest}
                  onRan={(seq) => setRunRequest((current) => (current?.seq === seq ? null : current))}
                  onClose={() => setCmdOpen(false)}
                />
              )}

              <Composer
              key={`${target.tool}:${target.id}`}
              sessionKey={`${target.tool}:${target.id}`}
              enabled={Boolean(meta?.sendEnabled && state?.phase === "ready" && !state.opening)}
              placeholder={composerHint(state, mobile)}
              mobile={mobile}
              clearOnSend={target.tool === "cursor"}
              respondingPlaceholder={target.tool === "cursor" ? "消息响应中" : undefined}
              queue={
                target.tool === "cursor"
                  ? state?.messages.filter((message) => message.id.startsWith("queued-")).map((message) => message.text)
                  : undefined
              }
              onSend={send}
              busy={meta?.status === "running" && turnOpen(state)}
              stopping={stopping}
              onStop={() => void interrupt()}
              onSendNow={target.tool === "cursor" ? sendNow : undefined}
              loadCommands={() => api.slashCommands(target.tool, target.id).then((result) => result.commands)}
              tools={
                meta && (
                  <ModelChip
                    tool={meta.tool}
                    model={meta.model}
                    effort={meta.effort}
                    canSwitch={Boolean(meta.modelSwitch && meta.sendEnabled)}
                    busy={turnOpen(state)}
                    onSwitch={send}
                  />
                )
              }
            />
            </div>
          </>
        )}
      </main>
      )}

      {mobile && screen === "plugins" && (
        <PluginsDialog key={pluginStart ?? "list"} variant="page" startWith={pluginStart} installed={installed} context={{ jobs, placeOf, mobile: true }} onOpenMarket={openMarket} onClose={leavePlugins} />
      )}

      {mobile && screen === "settings" && (
        <SettingsDialog
          key={settingsStart ?? "settings"}
          variant="page"
          host={prefs?.host ?? ""}
          onLogout={onLogout}
          onPlugins={showPlugins}
          pluginCount={installed?.length ?? null}
          prefs={prefs}
          checking={checking}
          checkedAt={checkedAt}
          error={settingsError}
          installed={installed}
          pluginBusy={pluginBusy}
          onPlugin={(id, add) => void changePlugin(id, add)}
          startAt={settingsStart}
          onToggle={toggleTool}
          onCheck={() => void checkNow()}
          onClose={() => setScreen("list")}
        />
      )}


      {tabs && (
        <nav className="tabbar" aria-label="主导航">
          {TABS.map(({ key, label, Icon }) => {
            const on = screen === "list" ? key === LIST_TAB[railView] : screen === key || (key === "settings" && screen === "plugins");
            return (
              <button
                key={key}
                type="button"
                className={on ? "tab is-on" : "tab"}
                aria-current={on ? "page" : undefined}
                aria-label={key === "home" && homeCount.all ? `${label}，${homeCount.all} 个会话正在回复或有新回复` : label}
                onClick={() => {
                  if (key === "home") {
                    showRunning();
                    setScreen("list");
                  } else if (key === "sessions") {
                    setPluginsOpen(false);
                    // 会话 comes back to the tab last used inside it: 钉住 or a tool.
                    setRailView(sessionsView.current);
                    setScreen("list");
                  } else {
                    pluginsEntry.current = false;
                    // The 设置 tab always opens on its first page, not on 插件市场 where the market icon last sent it.
                    if (key === "settings") setSettingsStart(undefined);
                    setScreen(key);
                  }
                }}
              >
                <span className="tab-icon">
                  <Icon />
                  {key === "home" && homeCount.all > 0 && (
                    <span className={homeCount.live ? "tab-badge is-live" : "tab-badge"}>{homeCount.all > 99 ? "99+" : homeCount.all}</span>
                  )}
                </span>
                <span className="tab-label">{label}</span>
              </button>
            );
          })}
        </nav>
      )}

      {!mobile && settingsOpen && (
        <SettingsDialog
          prefs={prefs}
          checking={checking}
          checkedAt={checkedAt}
          error={settingsError}
          installed={installed}
          pluginBusy={pluginBusy}
          onPlugin={(id, add) => void changePlugin(id, add)}
          startAt={settingsStart}
          onToggle={toggleTool}
          onCheck={() => void checkNow()}
          onClose={closeSettings}
        />
      )}

    </div>
  );
}

/** The phone's tab bar, in the desktop bar's order: what spans every tool first, then the tools, then the rest. */
const TABS = [
  { key: "home", label: "工作台", Icon: () => <WorkbenchIcon /> },
  { key: "sessions", label: "会话", Icon: ChatsIcon },
  { key: "settings", label: "设置", Icon: GearIcon },
] as const;

/** Which tab the list screen belongs to, by what it is showing. */
const LIST_TAB: Record<RailView, (typeof TABS)[number]["key"]> = { running: "home", tool: "sessions", pinned: "sessions" };

const PLACEHOLDER: SessionState = {
  key: "",
  phase: "loading",
  meta: null,
  messages: [],
  offset: 0,
  total: 0,
  link: "connecting",
  opening: false,
  openError: null,
  older: "idle",
};
