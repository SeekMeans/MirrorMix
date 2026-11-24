import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { tr, uiLocale, useLanguage, type UiLanguage } from "./i18n";
import { ALL_TOOLS, type ToolId, type ToolPrefs } from "./api";
import { HelpContent } from "./Help";
import { ModelManager } from "./Models";
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
  ModelIcon,
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
import { WORKFLOWS_SHOWN } from "./features";

export type Section = "general" | "models" | "market" | "help";

const HEADINGS = (): Record<Section, { title: string; lead: string }> => ({
  general: {
    title: tr("通用设置", "General settings"),
    lead: tr(
      "选择界面语言和要显示的 AI 工具，查看它们在本机是否开启，选择浅色或深色，设置外网访问。",
      "Choose the interface language and which AI tools to show, check whether they are open on this computer, choose a theme, and set up remote access.",
    ),
  },
  models: { title: tr("模型管理", "Models"), lead: "" },
  market: { title: tr("插件市场", "Plugin market"), lead: tr("把需要的插件添加到“我的插件”，从左下角的菜单打开使用。", "Add the plugins you need to My plugins, then open them from the menu at the bottom left.") },
  help: { title: tr("帮助", "Help"), lead: tr("MirrorMix 每个功能怎么用，以及常见问题。", "How each MirrorMix feature works, and common questions.") },
});

/** On a phone, settings open as a menu; each entry is a page of its own. */
export type MenuPage = "tools" | "appearance" | "remote" | "models" | "market" | "help";

const PAGES = (): Record<MenuPage, { title: string; lead: string; Icon: () => ReactNode }> => {
  const headings = HEADINGS();
  return {
    tools: { title: tr("AI 工具", "AI tools"), lead: "", Icon: SlidersIcon },
    appearance: {
      title: tr("外观", "Appearance"),
      lead: tr("选择浅色或深色。只影响这个浏览器，手机和电脑可以各选各的。", "Choose light or dark. It only affects this browser, so a phone and a computer can each have their own."),
      Icon: ContrastIcon,
    },
    remote: { title: tr("外网访问", "Remote access"), lead: "", Icon: GlobeIcon },
    models: { title: headings.models.title, lead: headings.models.lead, Icon: ModelIcon },
    market: { title: headings.market.title, lead: tr("把需要的插件添加到“我的插件”，在底部的“插件”页打开使用。", "Add the plugins you need to My plugins, then open them from the Plugins tab at the bottom."), Icon: StoreIcon },
    help: { title: headings.help.title, lead: headings.help.lead, Icon: HelpIcon },
  };
};

const MENU_PAGES: MenuPage[] = ["tools", "appearance", "remote", "models", "market", "help"];

/** Each language is named in its own words, so it can be found whichever language the page is in. */
const LANGUAGES: { id: UiLanguage; label: string }[] = [
  { id: "zh-CN", label: "中文" },
  { id: "en", label: "English" },
];

const MENU: MenuPage[] = ["tools", "appearance", "remote", "help"];

const toolNote = (): Record<ToolId, string> => ({
  claude: tr("Claude 桌面客户端", "Claude desktop app"),
  codex: tr("Codex 桌面客户端", "Codex desktop app"),
  cursor: tr("Cursor 编辑器", "Cursor editor"),
  deepseek: tr("DSH 桌面客户端", "DSH desktop app"),
});

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
  onLanguageChange,
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
  onLanguageChange: (language: "zh-CN" | "en") => void;
  onCheck: () => void;
  onClose: () => void;
}) {
  const language = useLanguage();
  const notes = toolNote();
  const closeButton = useRef<HTMLButtonElement>(null);
  const [theme, setTheme] = useTheme();
  const [section, setSection] = useState<Section>(startAt === "market" || startAt === "help" ? startAt : "general");
  const page = variant === "page";

  // A phone page opened from the menu is a history entry, so the back gesture returns to the menu.
  const [sub, setSub] = useState<MenuPage | null>(page && startAt && MENU_PAGES.includes(startAt as MenuPage) ? (startAt as MenuPage) : null);
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
          <h3>{tr("AI 工具", "AI tools")}</h3>
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
                    <span>{notes[tool]}</span>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={shown}
                    aria-label={tr(`显示 ${toolName[tool]}`, `Show ${toolName[tool]}`)}
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
                    {running ? tr("客户端已开启", "App is open") : tr("客户端未开启", "App is not open")}
                  </span>
                ) : (
                  <span className="link-state">
                    <Spinner />
                    {tr("检测中", "Checking")}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      <div className="setting">
        <div className="setting-label">
          <h3>{tr("连通性检测", "Connection check")}</h3>
          <p>
            {tr("每 5 秒自动检测一次各工具的客户端是否开启。", "Checks every 5 seconds whether each tool's app is open.")}
            {checkedAt &&
              tr(
                ` 上次检测 ${checkedAt.toLocaleTimeString(uiLocale(), { hour12: false })}。`,
                ` Last checked ${checkedAt.toLocaleTimeString(uiLocale(), { hour12: false })}.`,
              )}
          </p>
        </div>
        <div className="setting-control">
          <button type="button" className="quiet-button" disabled={checking} onClick={onCheck}>
            {checking && <Spinner />}
            {checking ? tr("正在检测", "Checking") : tr("重新检测", "Check again")}
          </button>
        </div>
      </div>
    </>
  );

  const languageLabel = tr("语言", "Language");
  /** The language buttons; `on` is the selected class of the container they sit in. */
  const languageButtons = (on: string) =>
    LANGUAGES.map(({ id, label }) => (
      <button key={id} type="button" role="radio" lang={id} aria-checked={language === id} className={language === id ? on : ""} onClick={() => onLanguageChange(id)}>
        {label}
      </button>
    ));

  const appearance = (
    <>
    <div className="setting">
      <div className="setting-label">
        <h3>{languageLabel}</h3>
        <p>{tr("选择 MirrorMix 界面的显示语言。保存在这台电脑上，手机和电脑都用这个语言。", "Choose the language MirrorMix shows. It is saved on this computer, so a phone and a computer both use it.")}</p>
      </div>
      <div className="setting-control">
        <div className="theme-choice" role="radiogroup" aria-label={languageLabel}>
          {languageButtons("active")}
        </div>
      </div>
    </div>
    <div className="setting">
      <div className="setting-label">
        <h3>{tr("外观", "Appearance")}</h3>
        <p>
          {page
            ? tr("跟随系统时，手机切换深色模式这里也跟着变。", "When it follows the system, switching the phone to dark mode changes it here too.")
            : tr("只影响这个浏览器，手机和电脑可以各选各的。", "It only affects this browser, so a phone and a computer can each have their own.")}
        </p>
      </div>
      <div className="setting-control">
        <div className="theme-choice" role="radiogroup" aria-label={tr("外观", "Appearance")}>
          {(["system", "light", "dark"] as Theme[]).map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={theme === option}
              className={theme === option ? "active" : ""}
              onClick={() => setTheme(option)}
            >
              {THEME_LABEL()[option]}
            </button>
          ))}
        </div>
      </div>
    </div>
    </>
  );

  const remote = (
    <div className="setting is-stacked">
      {!page && (
        <div className="setting-label">
          <h3>{tr("外网访问", "Remote access")}</h3>
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
          ? tr(`显示 ${prefs.tools.map((tool) => toolName[tool]).join("、")}`, `Shows ${prefs.tools.map((tool) => toolName[tool]).join(", ")}`)
          : tr("没有显示任何工具", "No tools shown")
        : tr("正在读取", "Loading"),
      appearance: THEME_LABEL()[theme],
      remote: tr("从手机或别的电脑打开", "Open from a phone or another computer"),
      models: tr("工作流可以调用的模型", "Models workflows can use"),
      market: installed ? tr(`已添加 ${installed.length} / ${PLUGINS.length} 个插件`, `${installed.length} of ${PLUGINS.length} plugins added`) : tr("正在读取", "Loading"),
      help: tr("功能说明和常见问题", "How things work, and common questions"),
    };

    const online = prefs ? prefs.tools.filter((tool) => prefs.status[tool]?.running).length : 0;

    if (sub) {
      const info = PAGES()[sub];
      return (
        <section className="settings-page is-sub" aria-labelledby="settings-title">
          <header className="settings-head settings-subhead">
            <button type="button" className="icon-button settings-back" aria-label={tr("返回设置", "Back to settings")} onClick={closeSub}>
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
                    : sub === "models"
                      ? <ModelManager />
                      : <HelpContent />}
          </div>
        </section>
      );
    }

    return (
      <section className="settings-page" aria-labelledby="settings-title">
        <header className="settings-head">
          <div>
            <h2 id="settings-title">{tr("设置", "Settings")}</h2>
          </div>
        </header>
        <div className="settings-body">
          {error && <p className="banner is-warning">{error}</p>}

          {/* This computer first: what the phone is driving, whether its AI tools are up, and the way out. */}
          <section className="me-card" aria-label={tr("这台电脑", "This computer")}>
            <span className="me-card-icon">
              <ComputerIcon />
            </span>
            <span className="me-card-text">
              <strong>{host || tr("正在读取计算机名", "Reading the computer's name")}</strong>
              <span className={online ? "me-card-state is-on" : "me-card-state"}>
                {prefs
                  ? online
                    ? tr(`${online} 个 AI 工具在线`, `${online} AI ${online === 1 ? "tool" : "tools"} online`)
                    : tr("没有 AI 工具在线", "No AI tools online")
                  : tr("正在检测", "Checking")}
              </span>
            </span>
            {onLogout && (
              <button type="button" className="me-card-leave" onClick={onLogout}>
                {tr("退出登录", "Sign out")}
              </button>
            )}
          </section>

          <div className="pref-group">
            <button type="button" className="pref-row" onClick={() => openSub("tools")}>
              <span className="pref-title">{tr("AI 工具", "AI tools")}</span>
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
              <span className="pref-title">{tr("外观", "Appearance")}</span>
              <span className="pref-segment" role="radiogroup" aria-label={tr("外观", "Appearance")}>
                {(["system", "light", "dark"] as Theme[]).map((option) => (
                  <button key={option} type="button" role="radio" aria-checked={theme === option} className={theme === option ? "is-on" : ""} onClick={() => setTheme(option)}>
                    {THEME_LABEL()[option]}
                  </button>
                ))}
              </span>
            </div>
            {/* The language sits under 外观 and is switched the same way, in the row itself. */}
            <div className="pref-row is-static">
              <span className="pref-title">{languageLabel}</span>
              <span className="pref-segment" role="radiogroup" aria-label={languageLabel}>
                {languageButtons("is-on")}
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
                <span className="pref-title">{tr("插件市场", "Plugin market")}</span>
                <span className="pref-value">{pluginCount == null ? "" : tr(`已添加 ${pluginCount} 个`, `${pluginCount} added`)}</span>
                <span className="pref-caret">
                  <ChevronIcon />
                </span>
              </button>
            </div>
          )}

          <div className="pref-group">
            {((WORKFLOWS_SHOWN ? ["models", "help"] : ["help"]) as MenuPage[]).map((key) => {
              const { title, Icon } = PAGES()[key];
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
      ) : section === "models" && WORKFLOWS_SHOWN ? (
        <ModelManager />
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
        <nav className="settings-nav" aria-label={tr("设置分类", "Settings sections")}>
          <div className="brand">
            <Mark />
            <span>MirrorMix</span>
          </div>
          {tab("general", SlidersIcon, tr("通用设置", "General"))}
          {WORKFLOWS_SHOWN && tab("models", ModelIcon, tr("模型管理", "Models"))}
          {tab("help", HelpIcon, tr("帮助", "Help"))}
        </nav>

        <div className="settings-main">
          <header className="settings-head">
            <div>
              <h2 id="settings-title">{HEADINGS()[section].title}</h2>
              {HEADINGS()[section].lead && <p>{HEADINGS()[section].lead}</p>}
            </div>
            <button type="button" className="icon-button" aria-label={tr("关闭设置", "Close settings")} ref={closeButton} onClick={onClose}>
              <CloseIcon />
            </button>
          </header>
          {body}
        </div>
      </section>
    </div>
  );
}
