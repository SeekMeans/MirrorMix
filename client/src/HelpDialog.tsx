import { useEffect, useRef, useState } from "react";
import { BackIcon, ChevronIcon, CloseIcon, HelpIcon, Mark, ShieldQuestionIcon } from "./icons";
import { tr } from "./i18n";

type HelpSection = "security" | "feedback";

function SecurityContent() {
  return (
    <div className="help">
      <section className="help-topic">
        <h3>{tr("本机数据", "Local data")}</h3>
        <p>{tr(
          "MirrorMix 在本机运行，默认只监听 127.0.0.1:4789。它不调用模型 API，会读取和写入本机 AI 工具的会话记录，并在需要时与桌面应用交互。",
          "MirrorMix runs on this computer and listens on 127.0.0.1:4789 by default. It does not call model APIs. It reads and writes local AI tool session records and may interact with desktop apps.",
        )}</p>
      </section>
      <section className="help-topic">
        <h3>{tr("外网访问", "Remote access")}</h3>
        <p>{tr(
          "外网访问会让你通过隧道或反向代理连接本机。MirrorMix 可以向 AI 应用发送内容，也可以在项目文件夹中打开终端，因此暴露到公网相当于把这台电脑的操作权限交给访问者。",
          "Remote access connects to this computer through a tunnel or reverse proxy. MirrorMix can send content to AI apps and open terminals in project folders, so exposing it publicly can give visitors control over actions on this computer.",
        )}</p>
        <ul>
          <li>{tr("只通过可信网络或额外的访问控制开放。", "Use a trusted network or add an access control gate.")}</li>
          <li>{tr("外部连接使用 HTTPS，并保留登录保护。", "Use HTTPS for outside connections and keep login protection enabled.")}</li>
          <li>{tr("不要把隧道的原始端口直接暴露到公网。", "Do not expose the raw tunnel port directly to the public internet.")}</li>
        </ul>
      </section>
    </div>
  );
}

function FeedbackContent() {
  return (
    <div className="help">
      <section className="help-topic">
        <h3>{tr("提交问题", "Report an issue")}</h3>
        <p>{tr("请通过 GitHub 提交问题反馈。描述问题时，附上 MirrorMix 版本、系统版本、复现步骤和预期结果，有助于尽快定位。", "Please submit feedback on GitHub. Include the MirrorMix version, operating system, steps to reproduce, and expected result so the issue can be investigated.")}</p>
        <p><a href="https://github.com/SeekMeans/MirrorMix/issues" target="_blank" rel="noreferrer">{tr("打开 GitHub 问题反馈", "Open GitHub issue tracker")}</a></p>
        <p>{tr("分享日志或截图前，请先移除密码、连接口令和其他隐私信息。", "Remove passwords, connection tokens, and other private information before sharing logs or screenshots.")}</p>
      </section>
    </div>
  );
}

export function HelpDialog({ variant = "dialog", onClose }: { variant?: "dialog" | "page"; onClose: () => void }) {
  const [section, setSection] = useState<HelpSection | null>(variant === "page" ? null : "security");
  const closeButton = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const page = variant === "page";
  const title = section === "feedback" ? tr("问题反馈", "Problem feedback") : tr("安全说明", "Security information");

  useEffect(() => {
    if (page) return;
    closeButton.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [page]);

  if (page) {
    return (
      <section className={section ? "settings-page is-sub" : "settings-page"} aria-labelledby="help-title">
        <header className={`settings-head${section ? " settings-subhead" : ""}`}>
          {section && <button type="button" className="icon-button settings-back" aria-label={tr("返回帮助", "Back to help")} onClick={() => setSection(null)}><BackIcon /></button>}
          <div><h2 id="help-title">{section ? title : tr("帮助与产品支持", "Help and product support")}</h2></div>
          {!section && <button type="button" className="quiet-button" onClick={onClose}>{tr("返回", "Back")}</button>}
        </header>
        {!section ? (
          <div className="settings-body">
            <button type="button" className="pref-row" onClick={() => setSection("security")}><span className="pref-icon"><ShieldQuestionIcon /></span><span className="pref-title">{tr("安全说明", "Security information")}</span><span className="pref-caret"><ChevronIcon /></span></button>
            <button type="button" className="pref-row" onClick={() => setSection("feedback")}><span className="pref-icon"><HelpIcon /></span><span className="pref-title">{tr("问题反馈", "Problem feedback")}</span><span className="pref-caret"><ChevronIcon /></span></button>
          </div>
        ) : <div className="settings-body"><HelpSectionContent section={section} /></div>}
      </section>
    );
  }

  const navItem = (key: HelpSection, Icon: typeof ShieldQuestionIcon, label: string) => (
    <button type="button" className={section === key ? "settings-tab active" : "settings-tab"} aria-current={section === key ? "page" : undefined} onClick={() => setSection(key)}>
      <Icon />{label}
    </button>
  );

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="settings" role="dialog" aria-modal="true" aria-labelledby="help-title">
        <nav className="settings-nav" aria-label={tr("帮助菜单", "Help menu")}>
          <div className="brand"><Mark /><span>MirrorMix</span></div>
          {navItem("security", ShieldQuestionIcon, tr("安全说明", "Security information"))}
          {navItem("feedback", HelpIcon, tr("问题反馈", "Problem feedback"))}
        </nav>
        <div className="settings-main">
          <header className="settings-head">
            <div><h2 id="help-title">{title}</h2></div>
            <button type="button" className="icon-button" ref={closeButton} onClick={onClose} aria-label={tr("关闭", "Close")}><CloseIcon /></button>
          </header>
          <div className="settings-body"><HelpSectionContent section={section ?? "security"} /></div>
        </div>
      </section>
    </div>
  );
}

function HelpSectionContent({ section }: { section: HelpSection }) {
  return section === "security" ? <SecurityContent /> : <FeedbackContent />;
}
