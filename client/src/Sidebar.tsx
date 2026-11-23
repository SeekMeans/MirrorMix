import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  Catalog,
  SessionSummary,
  ToolId,
  ToolQuota,
  WorkspaceGroup,
} from "./api";
import {
  BoltIcon,
  BusyIcon,
  ChevronIcon,
  CloseIcon,
  ComputerIcon,
  GearIcon,
  HomeIcon,
  LeaveIcon,
  PushpinIcon,
  Mark,
  MenuIcon,
  PlusIcon,
  PuzzleIcon,
  Spinner,
} from "./icons";
import { ToolIcon } from "./ToolIcon";
import {
  oneLine,
  relativeTime,
  splitPath,
  statusText,
  timeUntil,
  toolName,
} from "./text";

/**
 * The limit beside 置顶: how long until it resets, then how much is used. Ticks on its own, since the list only
 * re-renders when the sessions change. Without a known reset time it names the window instead ("5小时 63%").
 */
function PinnedQuota({ quota }: { quota: ToolQuota }) {
  const [now, setNow] = useState(() => Date.now());
  const resetsAt = quota.resetsAt ?? null;
  useEffect(() => {
    if (resetsAt == null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [resetsAt]);
  const percent = Math.round(quota.percent ?? 0);
  const ahead = resetsAt != null && resetsAt > now;
  const window_ = quota.label.replace(/\s*(\d+%|已满)$/, "") || "5小时";
  return (
    <span
      className={`pinned-quota is-${quota.level ?? "ok"}`}
      title={quota.title}
    >
      {ahead
        ? `${timeUntil(resetsAt!, now)}后重置 · ${percent}%`
        : quota.resetLabel
          ? `${quota.resetLabel} · ${percent}%`
          : `${window_} ${percent}%`}
    </span>
  );
}

/** Sessions shown per workspace before the rest are folded away. Keeps the list short when a folder has hundreds. */
const FOLD_AFTER = 6;
const COLLAPSED_KEY = "mirrormix.collapsed";

function readCollapsed(): Set<string> {
  try {
    return new Set(
      JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]") as string[],
    );
  } catch {
    return new Set();
  }
}

const SessionRow = memo(function SessionRow({
  session,
  place,
  toolMark,
  done = false,
  current,
  loading,
  onChoose,
}: {
  session: SessionSummary;
  /** The AI tool the session belongs to, shown before its title where tools are mixed. */
  toolMark?: ToolId;
  /** Finished while nobody looked: marked like a new reply even if the tool does not flag it. */
  done?: boolean;
  /** Workspace shown beside the title where the row does not sit inside its group. */
  place?: string;
  current: boolean;
  loading: boolean;
  onChoose: (id: string) => void;
}) {
  const label =
    session.status === "starting" ||
    session.status === "failed" ||
    session.status === "create_failed"
      ? statusText[session.status]
      : "";
  return (
    <div className="session-wrap">
      <button
        type="button"
        title={place ? `${session.title} · ${place}` : session.title}
        className={current ? "session current" : "session"}
        aria-current={current ? "true" : undefined}
        onClick={() => onChoose(session.id)}
      >
        {toolMark && (
          <span
            className="session-tool"
            data-tool={toolMark}
            title={toolName[toolMark]}
          >
            <ToolIcon tool={toolMark} size={15} />
          </span>
        )}
        <span className="session-label">
          <span className="session-title">{oneLine(session.title)}</span>
          {place && <span className="session-place">{place}</span>}
        </span>
        {loading ? (
          <Spinner />
        ) : label ? (
          <span className={`session-state is-${session.status}`}>{label}</span>
        ) : session.working ? (
          <span className="session-state is-running">
            <BusyIcon />
          </span>
        ) : session.unseen || done ? (
          <BoltIcon />
        ) : (
          <time className="session-time">
            {relativeTime(session.updatedAt)}
          </time>
        )}
      </button>
    </div>
  );
});

/**
 * 首页 on a phone: one card per session that is replying or has a reply waiting. The tool, its workspace and when it
 * last moved sit on top; the title gets the room; the state line under it is the card's only colour.
 */
const SessionCard = memo(function SessionCard({
  tool,
  session,
  place,
  done,
  current,
  loading,
  onChoose,
}: {
  tool: ToolId;
  session: SessionSummary;
  place: string;
  done: boolean;
  current: boolean;
  loading: boolean;
  onChoose: (id: string) => void;
}) {
  const live = session.working;
  return (
    <button
      type="button"
      className={`home-card${live ? " is-live" : " is-waiting"}${current ? " is-current" : ""}`}
      aria-current={current ? "true" : undefined}
      onClick={() => onChoose(session.id)}
    >
      <span className="home-card-top">
        <span className="home-card-tool" data-tool={tool}>
          <ToolIcon tool={tool} size={15} />
          {toolName[tool]}
        </span>
        {place && <span className="home-card-place">{place}</span>}
        <time className="home-card-time">
          {relativeTime(session.updatedAt)}
        </time>
      </span>
      <span className="home-card-title">
        {oneLine(session.title) || "新会话"}
      </span>
      <span className="home-card-state">
        {loading ? (
          <Spinner />
        ) : live ? (
          <>
            <BusyIcon label="正在回复" />
            正在回复
          </>
        ) : (
          <>
            <BoltIcon />
            {done || session.unseen ? "回复完了，等你查看" : "回复完了"}
          </>
        )}
      </span>
    </button>
  );
});

/** What the list shows: the sessions still replying in every tool, the ones pinned here, or one tool's workspaces. */
export type RailView = "running" | "pinned" | "tool";

export interface SidebarProps {
  /** Laid out as a phone's list screen: full width, no drawer, the machine menu lives in the Settings tab. */
  mobile?: boolean;
  view: RailView;
  tool: ToolId;
  /** Tools chosen in settings, in display order. */
  tools: ToolId[];
  /** Tools whose app is not open on this machine; they are listed but cannot be entered. */
  offlineTools: ToolId[];
  onSettings: () => void;
  /** 我的插件, from the left bar just above the menu. */
  onPlugins?: () => void;
  /** The plugin page is on screen: 插件 is the lit entry in the bar instead of 首页 or a tool. */
  pluginsActive?: boolean;
  /** Ends this login and returns to the sign-in page. Absent when the desk has no gate. */
  onLogout?: () => void;
  /** This computer's name, shown at the foot of the list. Empty until the server has answered. */
  host: string;
  catalog: Catalog | null;
  /** Sessions (`tool:id`) whose reply finished unseen; they stay in the running list until opened and left. */
  finished: Set<string>;
  offline: boolean;
  selectedId: string | null;
  /** The tool of the open session, so the running list marks the right row. */
  selectedTool: ToolId | null;
  loadingId: string | null;
  creatingPath: string | null;
  canCreate?: boolean;
  onRunning: () => void;
  /** Sessions pinned in MirrorMix (`tool:id`), from any AI tool. */
  pinned: string[];
  onPinned: () => void;
  onTool: (tool: ToolId) => void;
  onChoose: (id: string) => void;
  /** Opens a session from the running list, which may belong to another tool than the one on screen. */
  onChooseIn: (tool: ToolId, id: string) => void;
  onCreate: (group: WorkspaceGroup) => void;
  onDismiss: () => void;
  /** The phone's 工作台 shows today's conversations above the live sessions. */
  today?: ReactNode;
}

export const Sidebar = memo(function Sidebar(props: SidebarProps) {
  const { tool, catalog, offline, selectedId, loadingId, creatingPath } = props;
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [unfolded, setUnfolded] = useState<Set<string>>(() => new Set());

  const running = props.view === "running";
  const pinnedView = props.view === "pinned";
  const unchosen = props.tools.length === 0;
  const down =
    !unchosen && !running && !pinnedView && props.offlineTools.includes(tool);
  const blocked = unchosen || down || running || pinnedView;
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuAt, setMenuAt] = useState<{ left: number; bottom: number } | null>(
    null,
  );
  const foot = useRef<HTMLDivElement>(null);

  // The menu closes on Escape or a click anywhere outside it.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (event: MouseEvent) => {
      if (!foot.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const groups = blocked ? [] : (catalog?.[tool] ?? []);

  // Sessions still replying, under the tool they belong to. Only tools that are chosen and open can be entered.
  const usableTools = useMemo(
    () => props.tools.filter((item) => !props.offlineTools.includes(item)),
    [props.tools, props.offlineTools],
  );
  const { finished } = props;
  const busy = useMemo(() => {
    if (!catalog) return [];
    return usableTools.map((item) => {
      const rows: { session: SessionSummary; place: string; done: boolean }[] =
        [];
      const seen = new Set<string>();
      for (const group of catalog[item]) {
        const place = group.label ?? group.projectName ?? splitPath(group.path).name;
        for (const session of group.sessions) {
          const done =
            !session.working && finished.has(`${item}:${session.id}`);
          if ((!session.working && !done) || seen.has(session.id)) continue;
          seen.add(session.id);
          rows.push({ session, place, done });
        }
      }
      rows.sort((a, b) => (a.session.updatedAt < b.session.updatedAt ? 1 : -1));
      return { tool: item, rows };
    });
  }, [catalog, usableTools, finished]);
  const busyCount = busy.reduce((total, group) => total + group.rows.length, 0);

  // Pinned here, grouped by the folder each session works in, in the order they were pinned (a folder comes where
  // its first pin does). Sessions of different tools in one folder share it. A pin whose session is gone is skipped.
  const { pinned } = props;
  const myPins = useMemo(() => {
    if (!catalog) return [];
    const byKey = new Map<
      string,
      { session: SessionSummary; path: string; label?: string }
    >();
    for (const item of usableTools) {
      for (const group of catalog[item] ?? []) {
        for (const session of group.sessions) {
          const key = `${item}:${session.id}`;
          if (!byKey.has(key))
            byKey.set(key, { session, path: group.path, label: group.label ?? group.projectName });
        }
      }
    }
    const folders = new Map<
      string,
      {
        path: string;
        label?: string;
        rows: { tool: ToolId; session: SessionSummary }[];
      }
    >();
    for (const key of pinned) {
      const found = byKey.get(key);
      if (!found) continue;
      const folderKey = found.path.replace(/[\\/]+$/, "").toLowerCase();
      let folder = folders.get(folderKey);
      if (!folder) {
        folder = { path: found.path, label: found.label, rows: [] };
        folders.set(folderKey, folder);
      }
      folder.rows.push({
        tool: key.slice(0, key.indexOf(":")) as ToolId,
        session: found.session,
      });
    }
    return [...folders.values()];
  }, [catalog, usableTools, pinned]);

  const liveCount = busy.reduce(
    (total, group) => total + group.rows.filter((entry) => !entry.done).length,
    0,
  );

  const pinnedQuota = props.offlineTools.includes(tool)
    ? null
    : (catalog?.quotas?.[tool] ?? null);

  // Sessions pinned in the tool itself are listed once, in 置顶 above the projects, and not again in their project.
  // Projects keep the tool's own order. MirrorMix only reads these pins; they are changed in the tool.
  const pinnedRows = useMemo(() => {
    const found = new Map<string, { session: SessionSummary; place: string }>();
    for (const group of groups) {
      const place = group.label ?? group.projectName ?? splitPath(group.path).name;
      for (const session of group.sessions) {
        if (session.pinned && !found.has(session.id))
          found.set(session.id, { session, place });
      }
    }
    return [...found.values()];
  }, [groups]);
  // A project left with nothing once its pinned sessions move up is hidden, as an empty one is (Codex lists its
  // projects even when empty, so those stay).
  const shown = useMemo(
    () =>
      groups
        .map((group) =>
          group.sessions.some((session) => session.pinned)
            ? {
                ...group,
                sessions: group.sessions.filter((session) => !session.pinned),
              }
            : group,
        )
        .filter((group) => tool === "codex" || group.sessions.length > 0),
    [groups, tool],
  );

  function toggleCollapsed(path: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {
        /* private mode: the choice just lasts for this visit */
      }
      return next;
    });
  }

  const row = (session: SessionSummary) => (
    <li key={session.id}>
      <SessionRow
        session={session}
        current={session.id === selectedId}
        loading={session.id === loadingId}
        onChoose={props.onChoose}
      />
    </li>
  );

  return (
    <aside
      className={props.mobile ? "rail is-screen" : "rail has-bar"}
      aria-label="会话列表"
    >
      {!props.mobile && (
        // The narrow bar on the far left: 工作台 (what every tool is doing now), then one entry per AI tool.
        <nav className="tool-bar" aria-label="导航">
          <button
            type="button"
            className={
              running && !props.pluginsActive ? "bar-item active" : "bar-item"
            }
            aria-current={running && !props.pluginsActive ? "page" : undefined}
            aria-label={`工作台，${busyCount} 个运行中或有新回复的会话`}
            title="工作台：各个 AI 工具里正在回复和回复完还没看的会话"
            onClick={props.onRunning}
          >
            <span className="bar-icon">
              <HomeIcon />
              {busyCount > 0 && (
                <span
                  className={liveCount > 0 ? "bar-badge is-live" : "bar-badge"}
                >
                  {busyCount}
                </span>
              )}
            </span>
            <span className="bar-label">工作台</span>
          </button>
          <button
            type="button"
            className={
              pinnedView && !props.pluginsActive
                ? "bar-item active"
                : "bar-item"
            }
            aria-current={
              pinnedView && !props.pluginsActive ? "page" : undefined
            }
            aria-label="钉住"
            title="钉住：在各个 AI 工具里钉住的会话"
            onClick={props.onPinned}
          >
            <span className="bar-icon">
              <PushpinIcon filled={pinnedView && !props.pluginsActive} />
            </span>
            <span className="bar-label">钉住</span>
          </button>
          {/* 工作台 and 钉住 span every tool; the AI tools themselves follow below the line. */}
          {props.tools.length > 0 && (
            <hr className="bar-divider" aria-hidden="true" />
          )}
          {props.tools.map((item) => {
            const off = props.offlineTools.includes(item);
            const active =
              !running &&
              !pinnedView &&
              item === tool &&
              !off &&
              !props.pluginsActive;
            const quota = off ? null : (props.catalog?.quotas?.[item] ?? null);
            const used = quota?.percent ?? null;
            return (
              <button
                key={item}
                type="button"
                className={active ? "bar-item active" : "bar-item"}
                data-tool={item}
                aria-current={active ? "page" : undefined}
                disabled={off}
                title={
                  off
                    ? `${toolName[item]} 的客户端没有在本机开启`
                    : used != null
                      ? quota?.title
                      : toolName[item]
                }
                onClick={() => props.onTool(item)}
              >
                <span className="bar-icon">
                  <ToolIcon tool={item} size={22} />
                </span>
                <span className="bar-label">{toolName[item]}</span>
                {used != null && (
                  <span
                    className={`tool-quota is-${quota?.level ?? "ok"}`}
                    role="meter"
                    aria-label="限额已用"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={used}
                  >
                    <span style={{ width: `${Math.max(used, 2)}%` }} />
                  </span>
                )}
              </button>
            );
          })}
          {props.onPlugins && (
            <button
              type="button"
              className={
                props.pluginsActive
                  ? "bar-item bar-plugins active"
                  : "bar-item bar-plugins"
              }
              aria-current={props.pluginsActive ? "page" : undefined}
              title="我的插件"
              onClick={props.onPlugins}
            >
              <span className="bar-icon">
                <PuzzleIcon />
              </span>
              <span className="bar-label">插件</span>
            </button>
          )}
          <div className="bar-more" ref={foot}>
            <button
              type="button"
              className={
                menuOpen
                  ? "bar-item bar-more-button active"
                  : "bar-item bar-more-button"
              }
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label="更多"
              title={props.host ? `更多 · ${props.host}` : "更多"}
              onClick={(event) => {
                // The bar scrolls, so the menu is placed on the page beside the button rather than inside the bar.
                const box = event.currentTarget.getBoundingClientRect();
                setMenuAt({
                  left: box.right + 8,
                  bottom: Math.max(8, window.innerHeight - box.bottom),
                });
                setMenuOpen((open) => !open);
              }}
            >
              <span className="bar-icon">
                <MenuIcon />
              </span>
            </button>
            {menuOpen && (
              <div
                className="foot-menu bar-menu"
                role="menu"
                aria-label="本机"
                style={menuAt ?? undefined}
              >
                <div
                  className="bar-menu-host"
                  title={props.host ? `这台计算机：${props.host}` : undefined}
                >
                  <ComputerIcon />
                  <span className="host-name">{props.host || "本机"}</span>
                </div>
                <button
                  type="button"
                  role="menuitem"
                  className="foot-button"
                  onClick={() => {
                    setMenuOpen(false);
                    props.onSettings();
                  }}
                >
                  <GearIcon />
                  <span>设置</span>
                </button>
                {props.onLogout && (
                  <button
                    type="button"
                    role="menuitem"
                    className="foot-button"
                    onClick={() => {
                      setMenuOpen(false);
                      props.onLogout?.();
                    }}
                  >
                    <LeaveIcon />
                    <span>退出登录</span>
                  </button>
                )}
              </div>
            )}
          </div>
        </nav>
      )}
      <div className="rail-main">
        <div className="rail-top">
          {props.mobile ? (
            // The tab bar says which screen this is; the name stays for screen readers only.
            <h1 className="visually-hidden">
              {running ? "工作台" : pinnedView ? "钉住" : "会话"}
            </h1>
          ) : (
            <div className="brand">
              <Mark />
              <span>MirrorMix</span>
              <button
                type="button"
                className="icon-button rail-dismiss"
                aria-label="收起会话列表"
                onClick={props.onDismiss}
              >
                <CloseIcon />
              </button>
            </div>
          )}
          {props.mobile &&
            !running &&
            (props.tools.length > 0 || pinnedView) && (
              // One chip per AI tool, scrolled sideways when they do not fit; the chosen one is filled in.
              <div className="tool-tabs" role="tablist" aria-label="会话">
                <button
                  type="button"
                  role="tab"
                  aria-selected={pinnedView}
                  className={pinnedView ? "tool-tab is-on" : "tool-tab"}
                  data-tool="pinned"
                  onClick={props.onPinned}
                >
                  <PushpinIcon size={16} filled={pinnedView} />
                  <span>钉住</span>
                </button>
                {props.tools.map((item) => {
                  const off = props.offlineTools.includes(item);
                  const active = !pinnedView && item === tool && !off;
                  const quota = off
                    ? null
                    : (props.catalog?.quotas?.[item] ?? null);
                  const used = quota?.percent ?? null;
                  return (
                    <button
                      key={item}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      data-tool={item}
                      className={active ? "tool-tab is-on" : "tool-tab"}
                      disabled={off}
                      title={
                        off
                          ? `${toolName[item]} 的客户端没有在本机开启`
                          : used != null
                            ? quota?.title
                            : toolName[item]
                      }
                      onClick={() => props.onTool(item)}
                    >
                      <ToolIcon tool={item} size={16} />
                      <span>{toolName[item]}</span>
                    </button>
                  );
                })}
              </div>
            )}
        </div>

        <div className="rail-list">
          {offline && (
            <p className="rail-note is-warning">
              连不上本机服务。确认 MirrorMix 进程还在运行，列表会自动恢复。
            </p>
          )}
          {!offline && !blocked && catalog === null && (
            <div className="rail-loading" role="status">
              <span className="visually-hidden">正在读取会话列表</span>
              {[72, 54, 86, 61, 78].map((width, index) => (
                <span
                  className="bone"
                  key={index}
                  style={{ width: `${width}%` }}
                />
              ))}
            </div>
          )}
          {unchosen && (
            <p className="rail-note">
              还没有选择要显示的 AI 工具。
              <button
                type="button"
                className="link-button"
                onClick={props.onSettings}
              >
                到设置里选择
              </button>
            </p>
          )}
          {down && (
            <p className="rail-note is-warning">
              {toolName[tool]}{" "}
              的客户端没有在本机开启。打开它之后，这里会自动恢复。
            </p>
          )}
          {running && !offline && !unchosen && catalog === null && (
            <div className="rail-loading" role="status">
              <span className="visually-hidden">正在读取运行中的任务</span>
              {[72, 54, 86].map((width, index) => (
                <span
                  className="bone"
                  key={index}
                  style={{ width: `${width}%` }}
                />
              ))}
            </div>
          )}
          {running &&
            !offline &&
            !unchosen &&
            catalog &&
            usableTools.length === 0 && (
              <p className="rail-note is-warning">
                选中的 AI 工具都没有在本机开启。打开其中一个，这里会自动恢复。
              </p>
            )}
          {running && props.mobile && !offline && props.today}
          {running &&
            props.mobile &&
            !offline &&
            catalog &&
            usableTools.length > 0 &&
            // Nothing replying: today's figures above already fill the screen, so no note under them.
            (busyCount === 0 ? null : (
              <ul className="home-cards">
                {busy
                  .flatMap(({ tool: item, rows }) =>
                    rows.map((row) => ({ tool: item, ...row })),
                  )
                  .sort((a, b) =>
                    a.session.working !== b.session.working
                      ? a.session.working
                        ? -1
                        : 1
                      : a.session.updatedAt < b.session.updatedAt
                        ? 1
                        : -1,
                  )
                  .map(({ tool: item, session, place, done }) => (
                    <li key={`${item}:${session.id}`}>
                      <SessionCard
                        tool={item}
                        session={session}
                        place={place}
                        done={done}
                        current={
                          item === props.selectedTool &&
                          session.id === selectedId
                        }
                        loading={
                          item === props.selectedTool &&
                          session.id === loadingId
                        }
                        onChoose={(id) => props.onChooseIn(item, id)}
                      />
                    </li>
                  ))}
              </ul>
            ))}
          {running &&
            !props.mobile &&
            !offline &&
            busy.map(({ tool: item, rows }) => {
              const key = `running:${item}`;
              const closed = collapsed.has(key);
              return (
                <section className="workspace running-group" key={key}>
                  <div className="workspace-head">
                    <button
                      type="button"
                      className={
                        closed ? "workspace-toggle" : "workspace-toggle open"
                      }
                      aria-expanded={!closed}
                      onClick={() => toggleCollapsed(key)}
                    >
                      <ChevronIcon />
                      <span className="workspace-text">
                        <span className="workspace-name">{toolName[item]}</span>
                      </span>
                    </button>
                    <span
                      className={
                        rows.length ? "running-count is-busy" : "running-count"
                      }
                    >
                      {rows.length}
                    </span>
                  </div>
                  {!closed &&
                    (rows.length ? (
                      <ul>
                        {rows.map(({ session, place, done }) => (
                          <li key={session.id}>
                            <SessionRow
                              session={session}
                              place={place}
                              done={done}
                              current={
                                item === props.selectedTool &&
                                session.id === selectedId
                              }
                              loading={
                                item === props.selectedTool &&
                                session.id === loadingId
                              }
                              onChoose={(id) => props.onChooseIn(item, id)}
                            />
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="workspace-count">没有运行中的任务</p>
                    ))}
                </section>
              );
            })}
          {pinnedView && !offline && !unchosen && catalog === null && (
            <div className="rail-loading" role="status">
              <span className="visually-hidden">正在读取钉住的会话</span>
              {[72, 54, 86].map((width, index) => (
                <span
                  className="bone"
                  key={index}
                  style={{ width: `${width}%` }}
                />
              ))}
            </div>
          )}
          {pinnedView && !offline && catalog && myPins.length === 0 && (
            <p className="rail-note">
              还没有钉住的会话。打开一条会话，点右上角的钉，它就会出现在这里。
            </p>
          )}
          {pinnedView && !offline && myPins.length > 0 && (
            <div className="pinned-list">
              {myPins.map((folder) => {
                // Folded apart from the same folder in a tool's own list, and remembered with the other folds.
                const foldKey = `pinned:${folder.path}`;
                const closed = collapsed.has(foldKey);
                return (
                  <section
                    className="workspace pinned-folder"
                    key={folder.path}
                  >
                    <div className="workspace-head">
                      <button
                        type="button"
                        className={
                          closed ? "workspace-toggle" : "workspace-toggle open"
                        }
                        aria-expanded={!closed}
                        title={folder.path}
                        onClick={() => toggleCollapsed(foldKey)}
                      >
                        <ChevronIcon />
                        <span className="workspace-text">
                          <span className="workspace-name">
                            {folder.label ??
                              (splitPath(folder.path).name || folder.path)}
                          </span>
                        </span>
                      </button>
                    </div>
                    {!closed && (
                      <ul>
                        {folder.rows.map(({ tool: item, session }) => (
                          <li key={`${item}:${session.id}`}>
                            <SessionRow
                              session={session}
                              toolMark={item}
                              current={
                                item === props.selectedTool &&
                                session.id === selectedId
                              }
                              loading={
                                item === props.selectedTool &&
                                session.id === loadingId
                              }
                              onChoose={(id) => props.onChooseIn(item, id)}
                            />
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                );
              })}
            </div>
          )}
          {!offline && !blocked && catalog && groups.length === 0 && (
            <p className="rail-note">
              {toolName[tool]}{" "}
              还没有会话。先在终端里用它开一条，这里就会出现它的工作区。
            </p>
          )}
          {!offline && !blocked && pinnedRows.length > 0 && (
            <section className="workspace pinned-group">
              <div className="workspace-head project-section-head">
                <h2 className="workspace-name plain">置顶</h2>
                {pinnedQuota?.percent != null && (
                  <PinnedQuota quota={pinnedQuota} />
                )}
              </div>
              <ul>
                {pinnedRows.map(({ session, place }) => (
                  <li key={session.id}>
                    <SessionRow
                      session={session}
                      place={place}
                      current={session.id === selectedId}
                      loading={session.id === loadingId}
                      onChoose={props.onChoose}
                    />
                  </li>
                ))}
              </ul>
            </section>
          )}

          {shown.map((group) => {
            const split = splitPath(group.path);
            const name = group.label ?? group.projectName ?? split.name;
            const parent = group.label ? "" : split.parent;
            const closed = collapsed.has(group.path);
            const holdsSelected = group.sessions.some(
              (session, index) =>
                index >= FOLD_AFTER && session.id === selectedId,
            );
            const showAll = unfolded.has(group.path) || holdsSelected;
            const visible = showAll
              ? group.sessions
              : group.sessions.slice(0, FOLD_AFTER);
            const hidden = group.sessions.length - visible.length;
            const creating = creatingPath === group.path;
            return (
              <section className="workspace" key={group.label ? `${group.path}:${group.label}` : group.path}>
                <div className="workspace-head">
                  <button
                    type="button"
                    className={
                      closed ? "workspace-toggle" : "workspace-toggle open"
                    }
                    aria-expanded={!closed}
                    title={group.path}
                    onClick={() => toggleCollapsed(group.path)}
                  >
                    <ChevronIcon />
                    <span className="workspace-text">
                      <span className="workspace-name">{name}</span>
                      {parent && (
                        <span className="workspace-parent">{parent}</span>
                      )}
                    </span>
                  </button>
                  {group.label ? null : group.missing ? (
                    <span
                      className="workspace-flag"
                      title="这个目录已经不在磁盘上，里面的会话只能查看"
                    >
                      目录不在
                    </span>
                  ) : props.canCreate === false ? null : (
                    <button
                      type="button"
                      className="icon-button new-session"
                      aria-label={`在 ${name} 里新建会话`}
                      title="在这个工作区新建会话"
                      disabled={creatingPath !== null}
                      onClick={() => props.onCreate(group)}
                    >
                      {creating ? <Spinner /> : <PlusIcon />}
                    </button>
                  )}
                </div>
                {!closed && (
                  <>
                    <ul>{visible.map(row)}</ul>
                    {group.sessions.length === 0 && (
                      <p className="workspace-count">无任务</p>
                    )}
                    {hidden > 0 && (
                      <button
                        type="button"
                        className="fold"
                        onClick={() =>
                          setUnfolded((current) =>
                            new Set(current).add(group.path),
                          )
                        }
                      >
                        显示其余 {hidden} 条
                      </button>
                    )}
                  </>
                )}
                {closed && (
                  <p className="workspace-count">
                    {group.sessions.length} 条会话
                  </p>
                )}
              </section>
            );
          })}
        </div>
      </div>
    </aside>
  );
});
