import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ALL_TOOLS, type ToolId, type ToolPrefs } from "./api";
import { HelpContent } from "./Help";
import {
  BackIcon,
  ChevronIcon,
  CloseIcon,
  ComputerIcon,
  ContrastIcon,
  GlobeIcon,
  HelpIcon,
  LeaveIcon,
  Mark,
  PuzzleIcon,
  SlidersIcon,
  Spinner,
  StoreIcon,
} from "./icons";
import { RemotePanel } from "./Remote";
import { ToolIcon } from "./ToolIcon";
import { toolName } from "./text";
import { PLUGINS, PluginMarket, type PluginId } from "./Plugins";
import { THEME_LABEL, useTheme, type Theme } from "./theme";

export type Section = "general" | "market" | "help";

const HEADINGS: Record<Section, { title: string; lead: string }> = {
  general: { title: "通用设置", lead: "选择要显示的 AI 工具，查看它们在本机是否开启，选择浅色或深色，设置外网访问。" },
  market: { title: "插件市场", lead: "把需要的插件添加到“我的插件”，从左下角的菜单打开使用。" },
  help: { title: "帮助", lead: "MirrorMix 每个功能怎么用，以及常见问题。" },
};

/** On a phone, settings open as a menu; each entry is a page of its own. */
export type MenuPage = "tools" | "appearance" | "remote" | "market" | "help";

const PAGES: Record<MenuPage, { title: string; lead: string; Icon: () => ReactNode }> = {
  tools: { title: "AI 工具", lead: "", Icon: SlidersIcon },
  appearance: { title: "外观", lead: "选择浅色或深色。只影响这个浏览器，手机和电脑可以各选各的。", Icon: ContrastIcon },
  remote: { title: "外网访问", lead: "", Icon: GlobeIcon },
  market: { title: HEADINGS.market.title, lead: "把需要的插件添加到“我的插件”，在底部的“插件”页打开使用。", Icon: StoreIcon },
  help: { title: HEADINGS.help.title, lead: HEADINGS.help.lead, Icon: HelpIcon },
};

const MENU: MenuPage[] = ["tools", "appearance", "remote", "help"];

const toolNote: Record<ToolId, string> = {
  claude: "Claude 桌面客户端",
  codex: "Codex 桌面客户端",
  cursor: "Cursor 编辑器",
  deepseek: "DSH 桌面客户端",
};

export function SettingsDialog({
  variant = "dialog",
  host = "",
  onLogout,
  onPlugins,
  pluginCount = null,
  prefs,
  checking,
  checkedAt,
  error,
  installed,
  pluginBusy,
  onPlugin,
  startAt,
  onToggle,
  onCheck,
  onClose,
}: {
  /** `page` is the phone's settings tab: a menu of sections instead of a dialog with a side list. */
  variant?: "dialog" | "page";
  /** This computer's name and the way out, which a phone has nowhere else to put. */
  host?: string;
  onLogout?: () => void;
  /** Phone: opens one added plugin, listed as a row of 设置 there. */
  onPlugins?: (id: PluginId) => void;
  /** How many plugins are added, shown on that row; null while unknown. */
  pluginCount?: number | null;
  prefs: ToolPrefs | null;
  checking: boolean;
  checkedAt: Date | null;
  error: string;
  /** Plugins added to 我的插件; null while they are read. */
  installed: string[] | null;
  pluginBusy: boolean;
  onPlugin: (id: PluginId, add: boolean) => void;
  /** Opened straight at this section (a computer) or page (a phone), e.g. the plugin market from 我的插件. */
  startAt?: Section | MenuPage;
  onToggle: (tool: ToolId, shown: boolean) => void;
  onCheck: () => void;
  onClose: () => void;
}) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const [theme, setTheme] = useTheme();
  const [section, setSection] = useState<Section>(startAt === "market" || startAt === "help" ? startAt : "general");
  const page = variant === "page";

  // A phone page opened from the menu is a history entry, so the back gesture returns to the menu.
  const [sub, setSub] = useState<MenuPage | null>(page && startAt && startAt in PAGES ? (startAt as MenuPage) : null);
  const subEntry = useRef(false);
  const openSub = useCallback((next: MenuPage) => {
    setSub(next);
    if (subEntry.current) return;
    try {
      window.history.pushState({ mirrormix: "settings" }, "");
      subEntry.current = true;
    } catch {
      /* no history in this frame: the back button still works */
    }
  }, []);
  const closeSub = useCallback(() => {
    if (subEntry.current) window.history.back();
    else setSub(null);
  }, []);
  useEffect(() => {
    if (!page) return;
    const onPop = () => {
      if (!subEntry.current) return;
      subEntry.current = false;
      setSub(null);
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      // Leaving settings by the tab bar takes the page's history entry with it.
      if (subEntry.current) {
        subEntry.current = false;
        window.history.back();
      }
    };
  }, [page]);

  // Focus the close button once on open; on every render it would pull focus out of a field being typed in.
  useEffect(() => {
    if (!page) closeButton.current?.focus();
  }, [page]);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (page) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [page]);

  const tools = (
    <>
      <div className="setting is-stacked">
        <div className="setting-label">
          <h3>AI 工具</h3>
        </div>
        <ul className="tool-cards">
          {ALL_TOOLS.map((tool) => {
            const shown = prefs ? prefs.tools.includes(tool) : true;
            const running = prefs?.status[tool].running;
            return (
              <li key={tool} className={shown ? "tool-card is-shown" : "tool-card"}>
                <div className="tool-card-head">
                  <div className="tool-text">
                    <strong>{toolName[tool]}</strong>
                    <span>{toolNote[tool]}</span>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={shown}
                    aria-label={`显示 ${toolName[tool]}`}
                    className="switch"
                    disabled={!prefs}
                    onClick={() => onToggle(tool, !shown)}
                  >
                    <span />
                  </button>
                </div>
                {prefs ? (
                  <span className={running ? "link-state on" : "link-state"}>
                    <span className="dot" />
                    {running ? "客户端已开启" : "客户端未开启"}
                  </span>
                ) : (
                  <span className="link-state">
                    <Spinner />
                    检测中
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      <div className="setting">
        <div className="setting-label">
          <h3>连通性检测</h3>
          <p>
            每 5 秒自动检测一次各工具的客户端是否开启。
            {checkedAt && ` 上次检测 ${checkedAt.toLocaleTimeString("zh-CN", { hour12: false })}。`}
          </p>
        </div>
        <div className="setting-control">
          <button type="button" className="quiet-button" disabled={checking} onClick={onCheck}>
            {checking && <Spinner />}
            {checking ? "正在检测" : "重新检测"}
          </button>
        </div>
      </div>
    </>
  );

  const appearance = (
    <div className="setting">
      <div className="setting-label">
        <h3>外观</h3>
        <p>{page ? "跟随系统时，手机切换深色模式这里也跟着变。" : "只影响这个浏览器，手机和电脑可以各选各的。"}</p>
      </div>
      <div className="setting-control">
        <div className="theme-choice" role="radiogroup" aria-label="外观">
          {(["system", "light", "dark"] as Theme[]).map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={theme === option}
              className={theme === option ? "active" : ""}
              onClick={() => setTheme(option)}
            >
              {THEME_LABEL[option]}
            </button>
          ))}
        </div>
      </div>
    </div>
  );

  const remote = (
    <div className="setting is-stacked">
      {!page && (
        <div className="setting-label">
          <h3>外网访问</h3>
        </div>
      )}
      <RemotePanel />
    </div>
  );

  const market = <PluginMarket installed={installed} busy={pluginBusy} onChange={onPlugin} />;

  if (page) {
    /** What each menu entry says about its page before it is opened. */
    const summary: Record<MenuPage, string> = {
      tools: prefs
        ? prefs.tools.length
          ? `显示 ${prefs.tools.map((tool) => toolName[tool]).join("、")}`
          : "没有显示任何工具"
        : "正在读取",
      appearance: THEME_LABEL[theme],
      remote: "从手机或别的电脑打开",
      market: installed ? `已添加 ${installed.length} / ${PLUGINS.length} 个插件` : "正在读取",
      help: "功能说明和常见问题",
    };

    if (sub) {
      const info = PAGES[sub];
      return (
        <section className="settings-page is-sub" aria-labelledby="settings-title">
          <header className="settings-head settings-subhead">
            <button type="button" className="icon-button settings-back" aria-label="返回设置" onClick={closeSub}>
              <BackIcon />
            </button>
            <div>
              <h2 id="settings-title">{info.title}</h2>
              {/* The market's cards say what each plugin does; a line above them adds nothing. */}
              {sub !== "market" && info.lead && <p>{info.lead}</p>}
            </div>
          </header>
          <div className="settings-body">
            {error && sub === "tools" && <p className="banner is-warning">{error}</p>}
            {sub === "tools"
              ? tools
              : sub === "appearance"
                ? appearance
                : sub === "remote"
                  ? remote
                  : sub === "market"
                    ? market
                    : <HelpContent />}
          </div>
        </section>
      );
    }

    return (
      <section className="settings-page" aria-labelledby="settings-title">
        <header className="settings-head">
          <div>
            <h2 id="settings-title">设置</h2>
          </div>
        </header>
        <div className="settings-body">
          {error && <p className="banner is-warning">{error}</p>}

          {/* This computer first: what the phone is driving, whether its AI tools are up, and the way out. */}
          <section className="me-card" aria-label="这台电脑">
            <span className="me-card-icon">
              <ComputerIcon />
            </span>
            <span className="me-card-text">
              <strong>{host || "正在读取计算机名"}</strong>
              <span className={(prefs ? prefs.tools.filter((tool) => prefs.status[tool]?.running).length : 0) ? "me-card-state is-on" : "me-card-state"}>
                {prefs ? ((prefs ? prefs.tools.filter((tool) => prefs.status[tool]?.running).length : 0) ? `${prefs ? prefs.tools.filter((tool) => prefs.status[tool]?.running).length : 0} 个 AI 工具在线` : "没有 AI 工具在线") : "正在检测"}
              </span>
            </span>
            {onLogout && (
              <button type="button" className="me-card-leave" onClick={onLogout}>
                退出登录
              </button>
            )}
          </section>

          <div className="pref-group">
            <button type="button" className="pref-row" onClick={() => openSub("tools")}>
              <span className="pref-title">AI 工具</span>
              <span className="pref-marks" aria-label={summary.tools}>
                {(prefs?.tools ?? []).map((tool) => (
                  <span key={tool} className={prefs?.status[tool]?.running ? "pref-mark" : "pref-mark is-off"} data-tool={tool} title={toolName[tool]}>
                    <ToolIcon tool={tool} size={18} />
                  </span>
                ))}
              </span>
              <span className="pref-caret">
                <ChevronIcon />
              </span>
            </button>
            {/* Three choices fit in the row: switched here, no page to open. */}
            <div className="pref-row is-static">
              <span className="pref-title">外观</span>
              <span className="pref-segment" role="radiogroup" aria-label="外观">
                {(["system", "light", "dark"] as Theme[]).map((option) => (
                  <button key={option} type="button" role="radio" aria-checked={theme === option} className={theme === option ? "is-on" : ""} onClick={() => setTheme(option)}>
                    {THEME_LABEL[option]}
                  </button>
                ))}
              </span>
            </div>
          </div>

          {/* Each added plugin is a row of its own, opened straight from here; the market adds more. */}
          {onPlugins && (
            <div className="pref-group">
              {PLUGINS.filter((plugin) => installed?.includes(plugin.id)).map(({ id, name, Icon }) => (
                <button key={id} type="button" className="pref-row" onClick={() => onPlugins(id)}>
                  <span className="pref-icon">
                    <Icon />
                  </span>
                  <span className="pref-title">{name}</span>
                  <span className="pref-value" />
                  <span className="pref-caret">
                    <ChevronIcon />
                  </span>
                </button>
              ))}
              <button type="button" className="pref-row" onClick={() => openSub("market")}>
                <span className="pref-icon">
                  <StoreIcon />
                </span>
                <span className="pref-title">插件市场</span>
                <span className="pref-value">{pluginCount == null ? "" : `已添加 ${pluginCount} 个`}</span>
                <span className="pref-caret">
                  <ChevronIcon />
                </span>
              </button>
            </div>
          )}

          <div className="pref-group">
            {(["help"] as MenuPage[]).map((key) => {
              const { title, Icon } = PAGES[key];
              return (
                <button key={key} type="button" className="pref-row" onClick={() => openSub(key)}>
                  <span className="pref-icon">
                    <Icon />
                  </span>
                  <span className="pref-title">{title}</span>
                  <span className="pref-value" />
                  <span className="pref-caret">
                    <ChevronIcon />
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </section>
    );
  }

  const body = (
    <div className="settings-body">
      {section === "help" ? (
        <HelpContent />
      ) : section === "market" ? (
        market
      ) : (
        <>
          {error && <p className="banner is-warning">{error}</p>}
          {tools}
          {appearance}
          {remote}
        </>
      )}
    </div>
  );

  const tab = (key: Section, Icon: () => ReactNode, label: string) => (
    <button
      type="button"
      className={section === key ? "settings-tab active" : "settings-tab"}
      aria-current={section === key ? "page" : undefined}
      onClick={() => setSection(key)}
    >
      <Icon />
      {label}
    </button>
  );

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="settings" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <nav className="settings-nav" aria-label="设置分类">
          <div className="brand">
            <Mark />
            <span>MirrorMix</span>
          </div>
          {tab("general", SlidersIcon, "通用设置")}
          {tab("help", HelpIcon, "帮助")}
        </nav>

        <div className="settings-main">
          <header className="settings-head">
            <div>
              <h2 id="settings-title">{HEADINGS[section].title}</h2>
              <p>{HEADINGS[section].lead}</p>
            </div>
            <button type="button" className="icon-button" aria-label="关闭设置" ref={closeButton} onClick={onClose}>
              <CloseIcon />
            </button>
          </header>
          {body}
        </div>
      </section>
    </div>
  );
}
