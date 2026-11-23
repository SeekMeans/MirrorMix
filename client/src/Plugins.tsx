import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { ScheduleJob } from "./api";
import { CommandTasks } from "./CommandTasks";
import { BackIcon, ChevronIcon, ClockIcon, CloseIcon, ConsoleIcon, PuzzleIcon, ServerIcon, StoreIcon } from "./icons";
import { SshPlugin } from "./SshPlugin";
import { jobStatus, oneLine, toolName } from "./text";

export type PluginId = "commands" | "schedules" | "ssh";

const LAST_PLUGIN = "mirrormix.plugin";

/** What a plugin needs from the page around it. */
export interface PluginContext {
  jobs: ScheduleJob[];
  placeOf: (job: ScheduleJob) => string;
  /** Laid out for a phone. */
  mobile?: boolean;
  /** Phone: the right end of the bar with the plugin's name, where it may put its main button. */
  headerSlot?: HTMLElement | null;
}

interface PluginInfo {
  id: PluginId;
  name: string;
  /** One line on the market card and in the plugin's header. */
  lead: string;
  Icon: () => ReactNode;
  render: (context: PluginContext) => ReactNode;
  /** Needs the room of a whole window (terminals): the dialog grows and the page has no padding. */
  wide?: boolean;
}

/** Scheduled tasks Claude and Codex created, read from their own files. */
function JobList({ jobs, placeOf }: PluginContext) {
  if (jobs.length === 0) return <p className="blank">Claude 和 Codex 都还没有定时任务。在它们各自的界面里创建后，会列在这里。</p>;
  return (
    <>
      {jobs.map((job) => (
        <details className="job" key={`${job.tool}:${job.id}`}>
          <summary className="job-summary">
            <span className="job-head">
              <strong title={job.name}>{job.name}</strong>
              <span className="job-indicators">
                <span className={job.status.toUpperCase() === "ACTIVE" ? "job-state on" : "job-state"}>{jobStatus(job.status)}</span>
                <span className="job-chevron" aria-hidden="true">
                  <ChevronIcon />
                </span>
              </span>
            </span>
            <span className="job-meta">
              {toolName[job.tool]}，{job.cadence || "没有排期"}
            </span>
            <span className="job-toggle">
              <span className="job-expand">展开详情</span>
              <span className="job-collapse">收起详情</span>
            </span>
          </summary>
          <div className="job-details">
            <h3>任务内容</h3>
            <p className="job-prompt">{job.prompt.trim() ? job.prompt : "没有任务说明"}</p>
            {job.location && (
              <>
                <h3>运行位置</h3>
                <p className="job-location" title={job.location}>
                  {placeOf(job)}
                </p>
              </>
            )}
          </div>
        </details>
      ))}
    </>
  );
}

/** Everything the plugin market offers. */
export const PLUGINS: PluginInfo[] = [
  {
    id: "commands",
    name: "命令任务",
    lead: "在指定目录里执行命令：一次性的跑完就结束，持续运行的（如 npm run dev）会显示进程号和状态。",
    Icon: ConsoleIcon,
    render: () => <CommandTasks />,
  },
  {
    id: "schedules",
    name: "定时任务",
    lead: "Claude 和 Codex 里创建的定时任务会列在这里。",
    Icon: ClockIcon,
    render: (context) => <JobList {...context} />,
  },
  {
    id: "ssh",
    name: "SSH 连接",
    lead: "连接服务器：多标签终端、SFTP 文件、密钥和代码片段。密码和私钥加密保存在这台电脑上。",
    Icon: ServerIcon,
    render: (context) => <SshPlugin mobile={context.mobile} headerSlot={context.headerSlot} />,
    wide: true,
  },
];

const byId = (id: string) => PLUGINS.find((plugin) => plugin.id === id);

/** The plugin market in settings: one card per plugin, added to or removed from 我的插件. */
export function PluginMarket({
  installed,
  busy,
  onChange,
}: {
  installed: string[] | null;
  busy: boolean;
  onChange: (id: PluginId, add: boolean) => void;
}) {
  return (
    <ul className="plugin-cards">
      {PLUGINS.map(({ id, name, lead, Icon }) => {
        const added = installed?.includes(id) ?? false;
        return (
          <li key={id} className={added ? "plugin-card is-added" : "plugin-card"}>
            <div className="plugin-card-head">
              <span className="plugin-card-icon">
                <Icon />
              </span>
              <strong>{name}</strong>
              {added && <span className="plugin-badge">已添加</span>}
            </div>
            <p>{lead}</p>
            <div className="plugin-card-foot">
              <button
                type="button"
                className={added ? "quiet-button" : "quiet-button is-primary"}
                disabled={busy || installed === null}
                onClick={() => onChange(id, !added)}
              >
                {added ? "从我的插件移除" : "添加到我的插件"}
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * 我的插件. On a computer a dialog laid out like settings, but turned around: the plugin's page on the left, the
 * list of added plugins on the right. On a phone a page with the list, each plugin opening as a page of its own.
 */
export function PluginsDialog({
  variant = "dialog",
  installed,
  context,
  onOpenMarket,
  onClose,
  startWith,
}: {
  /** Phone: the plugin to open at once (chosen from 设置); going back from it leaves the page. */
  startWith?: PluginId;
  /** "desk": a computer's page beside the left bar (list in the middle column, plugin on the right). */
  variant?: "dialog" | "page" | "desk";
  installed: string[] | null;
  context: PluginContext;
  /** Goes to the plugin market in settings, for when nothing has been added yet. */
  onOpenMarket: () => void;
  onClose: () => void;
}) {
  const page = variant === "page";
  /** The phone bar's right end, handed to the plugin open below it. */
  const [headerSlot, setHeaderSlot] = useState<HTMLDivElement | null>(null);
  const list = (installed ?? []).map(byId).filter((plugin): plugin is PluginInfo => Boolean(plugin));
  // The page reopens on the plugin used last (per browser); the dialog and the phone start from their list.
  const [chosen, setChosen] = useState<PluginId | null>(() => {
    if (startWith) return startWith;
    if (variant !== "desk") return null;
    try {
      return (localStorage.getItem(LAST_PLUGIN) as PluginId | null) ?? null;
    } catch {
      return null;
    }
  });
  const pickOnDesk = (id: PluginId) => {
    setChosen(id);
    try {
      localStorage.setItem(LAST_PLUGIN, id);
    } catch {
      /* private mode: remembered for this visit only */
    }
  };
  const current = list.find((plugin) => plugin.id === chosen) ?? (page ? null : list[0] ?? null);
  const closeButton = useRef<HTMLButtonElement>(null);

  // A phone page opened from the list is a history entry, so the back gesture returns to the list.
  const subEntry = useRef(false);
  const openPlugin = useCallback(
    (id: PluginId) => {
      setChosen(id);
      if (!page || subEntry.current) return;
      try {
        window.history.pushState({ mirrormix: "plugin" }, "");
        subEntry.current = true;
      } catch {
        /* no history here: the back button still works */
      }
    },
    [page],
  );
  const closePlugin = useCallback(() => {
    if (startWith) onClose();
    else if (subEntry.current) window.history.back();
    else setChosen(null);
  }, [startWith, onClose]);
  useEffect(() => {
    if (!page) return;
    const onPop = () => {
      if (!subEntry.current) return;
      subEntry.current = false;
      setChosen(null);
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      if (subEntry.current) {
        subEntry.current = false;
        window.history.back();
      }
    };
  }, [page]);

  // Focus goes to the close button once, when the dialog opens. Doing it on every render would pull it out of a
  // terminal or a form each time the page around it refreshes (and Enter would then close the dialog).
  useEffect(() => {
    if (variant === "dialog") closeButton.current?.focus();
  }, [variant]);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (variant !== "dialog") return;
    const onKey = (event: KeyboardEvent) => {
      // Esc typed into a terminal (vim, less…) belongs to the terminal, not the dialog.
      const target = event.target as HTMLElement | null;
      if (target?.closest?.(".xterm, .ssh-modal")) return;
      if (event.key === "Escape") closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [variant]);

  const empty = (
    <div className="plugins-empty">
      <span className="plugins-empty-icon">
        <PuzzleIcon />
      </span>
      <p>还没有添加插件。到设置里的“插件市场”挑选需要的插件。</p>
      <button type="button" className="quiet-button is-primary" onClick={onOpenMarket}>
        打开插件市场
      </button>
    </div>
  );

  if (variant === "desk") {
    const shown = list.find((plugin) => plugin.id === chosen) ?? list[0] ?? null;
    return (
      <div className="plugin-desk">
        <nav className="plugin-desk-nav" aria-label="我的插件">
          <header className="plugin-desk-head">
            <h2>我的插件</h2>
            <span>{list.length ? `${list.length} 个` : ""}</span>
          </header>
          <ul className="plugin-desk-list">
            {list.map(({ id, name, lead, Icon }) => (
              <li key={id}>
                <button
                  type="button"
                  className={shown?.id === id ? "plugin-desk-item active" : "plugin-desk-item"}
                  aria-current={shown?.id === id ? "page" : undefined}
                  onClick={() => pickOnDesk(id)}
                >
                  <span className="plugin-desk-icon">
                    <Icon />
                  </span>
                  <span className="plugin-desk-text">
                    <strong>{name}</strong>
                    <span>{lead}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className="plugin-desk-market" onClick={onOpenMarket}>
            <PuzzleIcon />
            插件市场
            <ChevronIcon />
          </button>
        </nav>
        <section className="plugin-desk-main" aria-labelledby="plugin-title">
          {installed === null ? (
            <p className="blank">正在读取…</p>
          ) : shown ? (
            <>
              {/* The plugin starts right at its own content: the list beside it already names it and says what it does.
                  The name stays for screen readers. */}
              <h2 id="plugin-title" className="visually-hidden">
                {shown.name}
              </h2>
              <div className={shown.wide ? "plugin-desk-body is-flush" : "plugin-desk-body"}>{shown.render(context)}</div>
            </>
          ) : (
            empty
          )}
        </section>
      </div>
    );
  }

  if (page) {
    if (current) {
      return (
        <section className="settings-page is-sub" aria-labelledby="plugin-title">
          <header className="settings-head settings-subhead">
            <button type="button" className="icon-button settings-back" aria-label={startWith ? "返回设置" : "返回我的插件"} onClick={closePlugin}>
              <BackIcon />
            </button>
            {/* A phone's bar: back and the name. What the plugin does was on the row that opened it. */}
            <div>
              <h2 id="plugin-title">{current.name}</h2>
            </div>
            <div className="plugin-head-actions" ref={setHeaderSlot} />
          </header>
          <div className={current.wide ? "settings-body is-flush" : "settings-body"}>{current.render({ ...context, headerSlot })}</div>
        </section>
      );
    }
    return (
      <section className="settings-page is-sub" aria-labelledby="plugin-title">
        <header className="settings-head settings-subhead">
          <button type="button" className="icon-button settings-back" aria-label="返回设置" onClick={onClose}>
            <BackIcon />
          </button>
          <div>
            <h2 id="plugin-title">插件</h2>
          </div>
          {/* The market sits opposite the title: one tap from the list to more plugins. */}
          <button type="button" className="icon-button plugins-market" aria-label="插件市场" title="插件市场" onClick={onOpenMarket}>
            <StoreIcon />
          </button>
        </header>
        <div className="settings-body">
          {installed === null ? (
            <p className="blank">正在读取…</p>
          ) : list.length === 0 ? (
            empty
          ) : (
            <ul className="mine-cards">
              {list.map(({ id, name, lead, Icon }) => {
                const active = context.jobs.filter((job) => job.status.toUpperCase() === "ACTIVE").length;
                const fact =
                  id === "schedules"
                    ? context.jobs.length
                      ? `${context.jobs.length} 个定时任务${active ? `，${active} 个已启用` : ""}`
                      : "还没有定时任务"
                    : "";
                return (
                  <li key={id}>
                    <button type="button" className="mine-card" onClick={() => openPlugin(id)}>
                      <span className="mine-card-head">
                        <span className="mine-card-icon">
                          <Icon />
                        </span>
                        <strong>{name}</strong>
                        <span className="mine-card-caret">
                          <ChevronIcon />
                        </span>
                      </span>
                      <span className="mine-card-lead">{lead}</span>
                      {fact && <span className={active ? "mine-card-fact is-on" : "mine-card-fact"}>{fact}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>
    );
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className={current?.wide ? "settings is-plugins is-wide" : "settings is-plugins"} role="dialog" aria-modal="true" aria-labelledby="plugin-title">
        <div className="settings-main">
          <header className="settings-head">
            <div>
              <h2 id="plugin-title">{current ? current.name : "我的插件"}</h2>
              <p>{current ? current.lead : "从插件市场添加的插件会列在右侧。"}</p>
            </div>
            <button type="button" className="icon-button" aria-label="关闭我的插件" ref={closeButton} onClick={onClose}>
              <CloseIcon />
            </button>
          </header>
          <div className={current?.wide ? "settings-body is-flush" : "settings-body"}>
            {installed === null ? <p className="blank">正在读取…</p> : current ? current.render(context) : empty}
          </div>
        </div>

        <nav className="settings-nav" aria-label="我的插件">
          <div className="brand plugins-brand">
            <PuzzleIcon />
            <span>我的插件</span>
          </div>
          {list.map(({ id, name, Icon }) => (
            <button
              key={id}
              type="button"
              className={current?.id === id ? "settings-tab active" : "settings-tab"}
              aria-current={current?.id === id ? "page" : undefined}
              onClick={() => setChosen(id)}
            >
              <Icon />
              {name}
            </button>
          ))}
          <button type="button" className="settings-tab plugins-market-link" onClick={onOpenMarket}>
            <ChevronIcon />
            插件市场
          </button>
        </nav>
      </section>
    </div>
  );
}
