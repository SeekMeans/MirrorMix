import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api, type RemoteApplication, type RemoteBindCode, type RemoteView } from "./api";
import { CloseIcon, EyeIcon, EyeOffIcon, Spinner, WeChatIcon } from "./icons";

import { tr } from "./i18n";
const STATE_TEXT = (): Record<RemoteView["status"]["state"], string> => ({
  off: tr("未开启", "Off"),
  starting: tr("正在连接", "Connecting"),
  connected: tr("已连接", "Connected"),
  error: tr("没有连上", "Not connected"),
});

const RECORD_TEXT = (): Record<RemoteApplication["status"], string> => ({
  pending: tr("审核中", "Under review"),
  ready: tr("已通过", "Approved"),
  rejected: tr("未通过", "Turned down"),
});

/** Every PC answers under this domain on port 443. The server says so too; this covers an older server. */
const REMOTE_DOMAIN = "mm.seekmeans.cn";
const SUBDOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ACCESS_MIN = 6;

type Failure = { code?: string; detail?: string };

function errorText(failure: Failure | undefined): string {
  const code = failure?.code;
  if (failure?.detail) return failure.detail;
  if (code === "bad_subdomain") return tr("域名标识只能用小写字母、数字和中间的短横线，最长 63 个字符。", "The subdomain can use lowercase letters, digits and inner hyphens, up to 63 characters.");
  if (code === "bad_access_password") return tr(`访问密码至少 ${ACCESS_MIN} 位。`, `The access password needs at least ${ACCESS_MIN} characters.`);
  if (code === "access_password_required") return tr("开启外网访问前要先设置访问密码。", "Set an access password before turning on remote access.");
  if (code === "api_unreachable") return tr("连不上地址服务器，稍后再试。", "Cannot reach the address server. Try again later.");
  return tr("没有完成。确认 MirrorMix 还在运行，再试一次。", "Not done. Check that MirrorMix is still running and try again.");
}

/** The image DNSMgr sends is WeChat's: JPEG as a rule, PNG in local testing. */
function imageUrl(base64: string): string {
  return `data:${base64.startsWith("/9j/") ? "image/jpeg" : "image/png"};base64,${base64}`;
}

/** Checks a subdomain before sending it; returns what is wrong, or "". */
function slugProblem(slug: string): string {
  return SUBDOMAIN.test(slug.trim().toLowerCase()) ? "" : errorText({ code: "bad_subdomain" });
}

/** The subdomain field: the same for binding and for applying. */
function SlugField({
  slug,
  domain,
  disabled,
  onSlug,
  onEnter,
}: {
  slug: string;
  domain: string;
  disabled: boolean;
  onSlug: (value: string) => void;
  onEnter: () => void;
}) {
  return (
    <label className="remote-slug">
      <span>{tr("域名标识", "Subdomain")}</span>
      <div className="remote-suffix">
        <input
          value={slug}
          placeholder={tr("例如 office", "e.g. office")}
          autoComplete="off"
          spellCheck={false}
          maxLength={63}
          disabled={disabled}
          onChange={(event) => onSlug(event.target.value.toLowerCase())}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onEnter();
            }
          }}
        />
        <span>.{domain}</span>
      </div>
    </label>
  );
}

/**
 * Settings for reaching this PC from outside through the shared server.
 * 绑定: an approved address is bound to this PC by its subdomain, which gives it the connection token.
 * 申请: a subdomain goes to DNSMgr for review; the 申请记录 below follow it until approved.
 * 绑定微信 shows a mini program code: whoever scans it opens this PC from the MirrorMix mini program.
 */
export function RemotePanel() {
  const [view, setView] = useState<RemoteView | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [access, setAccess] = useState("");
  const [showAccess, setShowAccess] = useState(false);
  /** The password row is open for typing: to set it, change it, or because switching on needs one first. */
  const [editingAccess, setEditingAccess] = useState(false);
  /** The switch was turned on with no password set: the row asks for one and switching on waits for it. */
  const [enableAfterAccess, setEnableAfterAccess] = useState(false);
  const [accessError, setAccessError] = useState("");
  const accessInput = useRef<HTMLInputElement>(null);
  // 绑定
  const [rebinding, setRebinding] = useState(false);
  const [bindSlug, setBindSlug] = useState<string | null>(null);
  const [bindToken, setBindToken] = useState("");
  const [showBindToken, setShowBindToken] = useState(false);
  const [binding, setBinding] = useState(false);
  const [bindError, setBindError] = useState("");
  // 申请
  const [applyOpen, setApplyOpen] = useState(false);
  const [applySlug, setApplySlug] = useState("");
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState("");
  const [applied, setApplied] = useState("");
  const [checking, setChecking] = useState(false);
  const [wechatOpen, setWechatOpen] = useState(false);
  /** Tokens shown in the application records (eye button), by subdomain. */
  const [shownTokens, setShownTokens] = useState<Record<string, string>>({});
  const [copiedSlug, setCopiedSlug] = useState("");

  const load = useCallback(async () => {
    const unreadable = tr("读不到外网访问的设置。确认 MirrorMix 还在运行。", "Cannot read the remote access settings. Check that MirrorMix is still running.");
    try {
      setView(await api.remote());
      // Read again after a restart: the warning from the missed read no longer holds.
      setError((current) => (current === unreadable ? "" : current));
    } catch {
      setError(unreadable);
    }
  }, []);

  const [retrying, setRetrying] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const retryAt = view?.status.retryAt;
  useEffect(() => {
    if (!retryAt) return;
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, [retryAt]);

  /** Connects again at once instead of waiting for the next automatic try. */
  const retryNow = async () => {
    setRetrying(true);
    setError("");
    try {
      setView(await api.retryRemote());
    } catch (failure) {
      setError(errorText(failure as Failure));
    } finally {
      setRetrying(false);
    }
  };

  // The connection state changes on its own, so it is read again every two seconds while this is open.
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [load]);

  const closeAccess = () => {
    setEditingAccess(false);
    setEnableAfterAccess(false);
    setAccess("");
    setShowAccess(false);
    setAccessError("");
  };

  const toggle = async (enabled: boolean) => {
    // Switching on puts this computer on the internet: ask for the access password first when none is set.
    if (enabled && view && !view.hasAccessPassword) {
      setEnableAfterAccess(true);
      setEditingAccess(true);
      setAccessError("");
      window.setTimeout(() => accessInput.current?.focus(), 0);
      return;
    }
    setSaving(true);
    setError("");
    try {
      setView(await api.saveRemote({ enabled }));
      if (!enabled) closeAccess();
    } catch (failure) {
      setError(errorText(failure as Failure));
    } finally {
      setSaving(false);
    }
  };

  const saveAccess = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!editingAccess) return;
    if (access.length < ACCESS_MIN) {
      setAccessError(errorText({ code: "bad_access_password" }));
      accessInput.current?.focus();
      return;
    }
    setSaving(true);
    setAccessError("");
    try {
      setView(await api.saveRemote({ accessPassword: access, ...(enableAfterAccess ? { enabled: true } : {}) }));
      closeAccess();
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    } catch (failure) {
      setAccessError(errorText(failure as Failure));
    } finally {
      setSaving(false);
    }
  };

  /** `token` empty: the record's own token (an application from this PC). */
  const bindWith = async (slug: string, token: string) => {
    const problem = slugProblem(slug);
    if (problem) {
      setBindError(problem);
      return;
    }
    setBinding(true);
    setBindError("");
    try {
      const key = token.trim() || (await api.remoteToken(slug)).token;
      if (!key) {
        setBindError(tr("请填写连接口令。", "Enter the connection token."));
        return;
      }
      setView(await api.bindRemote(slug.trim().toLowerCase(), key));
      setRebinding(false);
      setBindSlug(null);
      setBindToken("");
      setShowBindToken(false);
    } catch (failure) {
      setBindError(errorText(failure as Failure));
    } finally {
      setBinding(false);
    }
  };

  const apply = async () => {
    const problem = slugProblem(applySlug);
    if (problem) {
      setApplyError(problem);
      return;
    }
    setApplying(true);
    setApplyError("");
    try {
      setView(await api.applyRemote(applySlug.trim().toLowerCase()));
      setApplied(tr("已提交，等待审核。通过后连接口令会显示在下面的申请记录里，这台电脑也会自动绑定。", "Sent for review. Once approved, the connection token shows in the record below and this computer binds by itself."));
      setApplyOpen(false);
      setApplySlug("");
    } catch (failure) {
      setApplyError(errorText(failure as Failure));
    } finally {
      setApplying(false);
    }
  };

  const check = async () => {
    setChecking(true);
    setError("");
    try {
      setView(await api.refreshRemote());
    } catch (failure) {
      setError(errorText(failure as Failure));
    } finally {
      setChecking(false);
    }
  };

  const toggleToken = async (slug: string) => {
    if (shownTokens[slug] !== undefined) {
      setShownTokens(({ [slug]: _gone, ...rest }) => rest);
      return;
    }
    try {
      const { token } = await api.remoteToken(slug);
      setShownTokens((current) => ({ ...current, [slug]: token }));
    } catch {
      setError(tr("读不到保存的口令。", "Cannot read the saved token."));
    }
  };

  const copyToken = async (slug: string) => {
    try {
      const token = shownTokens[slug] ?? (await api.remoteToken(slug)).token;
      await navigator.clipboard.writeText(token);
      setCopiedSlug(slug);
      window.setTimeout(() => setCopiedSlug(""), 1500);
    } catch {
      setError(tr("没能复制，点「显示」后手动复制。", "Could not copy; show it and copy by hand."));
    }
  };

  if (!view) {
    return (
      <div className="remote-loading">
        {error ? <p className="banner is-warning">{error}</p> : <Spinner />}
      </div>
    );
  }

  const { state, message } = view.status;
  const domain = view.domain || REMOTE_DOMAIN;
  const bindingInfo = view.binding ?? { bound: false, slug: "", wechat: false, nickname: "" };
  const records = view.applications ?? [];
  const url = bindingInfo.bound && view.subdomain ? `https://${view.subdomain}.${domain}` : "";
  const showBindForm = !bindingInfo.bound || rebinding;
  // The form starts from the last binding (a token that stopped working is one click from binding again).
  const formSlug = bindSlug ?? bindingInfo.slug;

  const copyUrl = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* the address is on screen to copy by hand */
    }
  };

  return (
    <form className="remote" onSubmit={(event) => void saveAccess(event)}>
      <div className={`remote-status is-${state}`} role="status" aria-live="polite">
        <div className="remote-status-line">
          {state === "starting" ? <Spinner /> : <span className="dot" aria-hidden="true" />}
          <strong>{STATE_TEXT()[state]}</strong>
          <button
            type="button"
            role="switch"
            aria-checked={view.enabled}
            aria-label={tr("开启外网访问", "Turn on remote access")}
            className="switch"
            disabled={saving || enableAfterAccess}
            onClick={() => void toggle(!view.enabled)}
          >
            <span />
          </button>
        </div>
        {view.enabled && url && (
          <div className="remote-url">
            {state === "connected" ? (
              <a href={url} target="_blank" rel="noreferrer">
                {url}
              </a>
            ) : (
              <span>{url}</span>
            )}
            <button type="button" className="link-button" onClick={() => void copyUrl()}>
              {copied ? tr("已复制", "Copied") : tr("复制地址", "Copy address")}
            </button>
          </div>
        )}
        {view.enabled && message && <p className="remote-message">{message}</p>}
        {/* Not connected: it tries again by itself after a growing wait, and can be told to try now. */}
        {view.enabled && state === "error" && view.hasToken && bindingInfo.bound && (
          <div className="remote-retry">
            <span>
              {view.status.retryAt && view.status.retryAt > now
                ? tr(`${Math.max(1, Math.ceil((view.status.retryAt - now) / 1000))} 秒后自动重试`, `Retrying in ${Math.max(1, Math.ceil((view.status.retryAt - now) / 1000))} s`)
                : tr("可以手动重试", "You can retry now")}
            </span>
            <button type="button" className="quiet-button" disabled={retrying || saving} onClick={() => void retryNow()}>
              {retrying ? <Spinner /> : null}
              {retrying ? tr("正在重试", "Retrying") : tr("立即重试", "Retry now")}
            </button>
          </div>
        )}
        {!view.enabled && !enableAfterAccess && (
          <p className="remote-message">
            {tr(
              `打开后用域名标识和连接口令绑定这台电脑，就能从外网打开 子域名.${domain}。还没有地址的，在下面申请。MirrorMix 会在后台运行 frpc，退出时一起停止。`,
              `Once on, bind this computer with its subdomain and connection token, and open it at subdomain.${domain} from outside. No address yet? Apply below. MirrorMix runs frpc in the background and stops it when it exits.`,
            )}
          </p>
        )}

        {/* 访问密码：从外网打开时登录用。开启外网访问必须先有它 */}
        <div className={`remote-access${editingAccess ? " is-editing" : ""}${!view.hasAccessPassword && view.enabled ? " is-missing" : ""}`}>
          {editingAccess ? (
            <>
              <label className="remote-access-field">
                <span>{enableAfterAccess ? tr("先设置访问密码", "Set an access password first") : view.hasAccessPassword ? tr("新的访问密码", "New access password") : tr("访问密码", "Access password")}</span>
                <div className="remote-secret">
                  <input
                    ref={accessInput}
                    type={showAccess ? "text" : "password"}
                    value={access}
                    placeholder={tr(`至少 ${ACCESS_MIN} 位`, `At least ${ACCESS_MIN} characters`)}
                    autoComplete="new-password"
                    spellCheck={false}
                    aria-invalid={Boolean(accessError)}
                    onChange={(event) => {
                      setAccessError("");
                      setAccess(event.target.value);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Escape" && !enableAfterAccess) closeAccess();
                    }}
                  />
                  <button
                    type="button"
                    className="remote-eye"
                    aria-label={showAccess ? tr("隐藏密码", "Hide password") : tr("显示密码", "Show password")}
                    aria-pressed={showAccess}
                    title={showAccess ? tr("隐藏密码", "Hide password") : tr("显示密码", "Show password")}
                    disabled={!access}
                    onClick={() => setShowAccess((shown) => !shown)}
                  >
                    {showAccess ? <EyeOffIcon /> : <EyeIcon />}
                  </button>
                </div>
              </label>
              <div className="remote-access-actions">
                <button type="submit" className="quiet-button is-primary" disabled={saving || !access}>
                  {saving && <Spinner />}
                  {enableAfterAccess ? tr("设置密码并开启", "Set password and turn on") : tr("保存密码", "Save password")}
                </button>
                <button type="button" className="link-button" onClick={closeAccess}>
                  {tr("取消", "Cancel")}
                </button>
              </div>
              <p className={`remote-access-note${accessError ? " is-error" : ""}`} role={accessError ? "alert" : undefined}>
                {accessError ||
                  tr(
                    "从外网打开这台电脑时要输入它。外网地址谁都能访问，密码请设得长一些，不要和别处的密码相同。",
                    "Asked for whenever this computer is opened from outside. Anyone can reach the address, so make it long and not one you use elsewhere.",
                  )}
              </p>
            </>
          ) : (
            <>
              <span className="remote-access-label">{tr("访问密码", "Access password")}</span>
              {view.hasAccessPassword ? (
                <span className="remote-access-value">
                  <span className="remote-access-dots" aria-hidden="true">••••••</span>
                  {saved ? tr("已保存", "Saved") : tr("已设置", "Set")}
                </span>
              ) : (
                <span className="remote-access-value is-missing">
                  {view.enabled
                    ? tr("还没设置，从外网打开时无法登录", "Not set: nobody can sign in from outside")
                    : tr("开启前要先设置", "Needed before turning on")}
                </span>
              )}
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  setEditingAccess(true);
                  window.setTimeout(() => accessInput.current?.focus(), 0);
                }}
              >
                {view.hasAccessPassword ? tr("更换", "Change") : tr("设置", "Set")}
              </button>
            </>
          )}
        </div>
      </div>

      {error && <p className="banner is-warning">{error}</p>}

      {view.enabled && (
        <>
          {/* 绑定：域名标识 + 连接口令 */}
          <section className="remote-app" aria-labelledby="remote-bind-head">
            <div className="remote-app-head">
              <span className="remote-app-label" id="remote-bind-head">{tr("绑定", "Binding")}</span>
              <span className={`remote-badge is-${bindingInfo.bound ? "ready" : "none"}`}>{bindingInfo.bound ? tr("已绑定", "Bound") : tr("未绑定", "Not bound")}</span>
            </div>

            {showBindForm ? (
              <>
                <div className="remote-pair">
                  <SlugField
                    slug={formSlug}
                    domain={domain}
                    disabled={binding}
                    onSlug={(value) => {
                      setBindError("");
                      setBindSlug(value);
                    }}
                    onEnter={() => void bindWith(formSlug, bindToken)}
                  />
                  <label className="remote-slug">
                    <span>{tr("连接口令", "Connection token")}</span>
                    <div className="remote-secret">
                      <input
                        type={showBindToken ? "text" : "password"}
                        value={bindToken}
                        placeholder={tr("申请通过后得到的口令", "The token you got when approved")}
                        autoComplete="off"
                        spellCheck={false}
                        disabled={binding}
                        onChange={(event) => {
                          setBindError("");
                          setBindToken(event.target.value);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            void bindWith(formSlug, bindToken);
                          }
                        }}
                      />
                      <button
                        type="button"
                        className="remote-eye"
                        aria-label={showBindToken ? tr("隐藏口令", "Hide token") : tr("显示口令", "Show token")}
                        aria-pressed={showBindToken}
                        disabled={!bindToken}
                        onClick={() => setShowBindToken((shown) => !shown)}
                      >
                        {showBindToken ? <EyeOffIcon /> : <EyeIcon />}
                      </button>
                    </div>
                  </label>
                </div>
                {bindingInfo.error && !bindError && <p className="remote-message is-warning">{bindingInfo.error}</p>}
                {bindError && <p className="remote-message is-warning">{bindError}</p>}
                <div className="remote-row">
                  <button type="button" className="quiet-button is-primary" disabled={binding || !formSlug || !bindToken.trim()} onClick={() => void bindWith(formSlug, bindToken)}>
                    {binding && <Spinner />}
                    {tr("绑定", "Bind")}
                  </button>
                  {rebinding && (
                    <button type="button" className="link-button" onClick={() => { setRebinding(false); setBindError(""); }}>
                      {tr("取消", "Cancel")}
                    </button>
                  )}
                  <span className="remote-hint">{tr("填申请的域名标识和申请通过后得到的连接口令。这个地址正有电脑连着时绑不了。", "Enter the subdomain and the connection token you got when it was approved. Not possible while another computer is connected to it.")}</span>
                </div>
              </>
            ) : (
              <>
                <div className="remote-app-line">
                  <code>{bindingInfo.slug}.{domain}</code>
                  <button type="button" className="link-button" onClick={() => setRebinding(true)}>
                    {tr("换绑", "Bind another")}
                  </button>
                </div>
                {bindingInfo.error && <p className="remote-message is-warning">{bindingInfo.error}</p>}
                <div className="remote-wechat">
                  <button type="button" className="remote-wechat-button" onClick={() => setWechatOpen(true)} title={tr("绑定微信", "Bind WeChat")}>
                    <WeChatIcon size={18} />
                    <span>{tr("绑定微信", "Bind WeChat")}</span>
                  </button>
                  <span className="remote-wechat-state">
                    {bindingInfo.wechat
                      ? tr(`已绑定微信${bindingInfo.nickname ? `：${bindingInfo.nickname}` : ""}`, `Bound to WeChat${bindingInfo.nickname ? `: ${bindingInfo.nickname}` : ""}`)
                      : tr("还没绑定微信。绑定后，用微信打开 MirrorMix 小程序就直接进这台电脑。", "Not bound yet. Once bound, the MirrorMix mini program opens this computer.")}
                  </span>
                </div>
              </>
            )}
          </section>

          {/* 申请入口和申请记录 */}
          <section className="remote-apply-block" aria-labelledby="remote-apply-head">
            <div className="remote-app-head">
              <span className="remote-app-label" id="remote-apply-head">{tr("申请记录", "Applications")}</span>
              {records.some((record) => record.status === "pending") && (
                <button type="button" className="link-button" disabled={checking} onClick={() => void check()}>
                  {checking ? tr("正在刷新", "Refreshing") : tr("刷新状态", "Refresh")}
                </button>
              )}
              {!applyOpen && (
                <button type="button" className="link-button" onClick={() => { setApplyOpen(true); setApplied(""); }}>
                  {tr("申请地址", "Apply for an address")}
                </button>
              )}
            </div>

            {applyOpen && (
              <div className="remote-app">
                <SlugField
                  slug={applySlug}
                  domain={domain}
                  disabled={applying}
                  onSlug={(value) => {
                    setApplyError("");
                    setApplySlug(value);
                  }}
                  onEnter={() => void apply()}
                />
                {applyError && <p className="remote-message is-warning">{applyError}</p>}
                <div className="remote-row">
                  <button type="button" className="quiet-button is-primary" disabled={applying || !applySlug} onClick={() => void apply()}>
                    {applying && <Spinner />}
                    {tr("提交申请", "Apply")}
                  </button>
                  <button type="button" className="link-button" onClick={() => { setApplyOpen(false); setApplyError(""); }}>
                    {tr("取消", "Cancel")}
                  </button>
                  <span className="remote-hint">{tr("域名标识就是你的地址，申请过的别人不能再用。提交后由管理员审核。", "The subdomain is your address; once applied for, nobody else can take it. An administrator reviews it.")}</span>
                </div>
              </div>
            )}
            {applied && <p className="remote-message">{applied}</p>}

            {records.length ? (
              <ul className="remote-records">
                {records.map((record) => (
                  <li key={record.slug}>
                    <div className="remote-record-main">
                      <code>{record.slug}.{domain}</code>
                    </div>
                    <span className={`remote-badge is-${record.status}`}>{RECORD_TEXT()[record.status]}</span>
                    {record.status === "rejected" && record.message && <p className="remote-message is-warning">{tr(`原因：${record.message}`, `Reason: ${record.message}`)}</p>}
                    {record.status === "ready" && record.hasToken && (
                      <div className="remote-record-token">
                        <span>{tr("连接口令", "Connection token")}</span>
                        <code>{shownTokens[record.slug] ?? "••••••••••••"}</code>
                        <button type="button" className="link-button" onClick={() => void toggleToken(record.slug)}>
                          {shownTokens[record.slug] !== undefined ? tr("隐藏", "Hide") : tr("显示", "Show")}
                        </button>
                        <button type="button" className="link-button" onClick={() => void copyToken(record.slug)}>
                          {copiedSlug === record.slug ? tr("已复制", "Copied") : tr("复制", "Copy")}
                        </button>
                        <p className="remote-keep">
                          {tr(
                            "请妥善保管连接口令：换电脑、重装 MirrorMix 后要用域名标识和它重新绑定。不要发给别人，拿到它的人能把这个地址绑到自己电脑上。",
                            "Keep this token safe: you need it with the subdomain to bind again on another computer or after reinstalling. Do not share it; whoever has it can bind this address to their computer.",
                          )}
                        </p>
                      </div>
                    )}
                    {record.status === "ready" && !record.current && (
                      <div className="remote-record-token">
                        {record.bindError && <span className="remote-message is-warning">{record.bindError}</span>}
                        {record.hasToken && (
                          <button type="button" className="quiet-button" disabled={binding} onClick={() => void bindWith(record.slug, "")}>
                            {tr("绑定到这台电脑", "Bind to this computer")}
                          </button>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              !applyOpen && <p className="remote-message">{tr("还没有从这台电脑申请过地址。", "No applications from this computer yet.")}</p>
            )}
          </section>
        </>
      )}

      {wechatOpen && <BindDialog view={view} onView={setView} onClose={() => setWechatOpen(false)} />}
    </form>
  );
}

/**
 * 绑定微信: a mini program code that lasts 10 minutes. Scanning it with WeChat opens the mini program, which asks
 * for the avatar and nickname and binds this PC's address to that WeChat account. The dialog notices and closes.
 */
function BindDialog({ view, onView, onClose }: { view: RemoteView; onView: (view: RemoteView) => void; onClose: () => void }) {
  const [code, setCode] = useState<RemoteBindCode | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [expiresAt, setExpiresAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [done, setDone] = useState("");
  // What the binding looked like when the dialog opened: a change means someone just scanned and confirmed.
  const before = useRef(`${view.binding.wechat}:${view.binding.boundAt ?? ""}`);

  const fetchCode = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const next = await api.remoteBindCode();
      setCode(next);
      setExpiresAt(Date.now() + next.expiresIn * 1000);
    } catch (failure) {
      setError(errorText(failure as Failure));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchCode();
  }, [fetchCode]);

  // Ask DNSMgr every 3 s whether the code was scanned and confirmed.
  useEffect(() => {
    if (done) return;
    const timer = window.setInterval(async () => {
      setNow(Date.now());
      try {
        const next = await api.refreshRemote();
        onView(next);
        const after = `${next.binding.wechat}:${next.binding.boundAt ?? ""}`;
        if (next.binding.wechat && after !== before.current) setDone(next.binding.nickname || tr("微信", "WeChat"));
      } catch {
        /* keep showing the code; the next tick tries again */
      }
    }, 3000);
    return () => window.clearInterval(timer);
  }, [done, onView]);

  useEffect(() => {
    if (!done) return;
    const timer = window.setTimeout(onClose, 1600);
    return () => window.clearTimeout(timer);
  }, [done, onClose]);

  useEffect(() => {
    // Escape closes this dialog only, not the settings underneath: handle it first and stop it there.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const left = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  const expired = Boolean(code) && left === 0;

  return (
    <div className="modal-backdrop remote-bind-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="remote-bind" role="dialog" aria-modal="true" aria-labelledby="remote-bind-title">
        <header>
          <h3 id="remote-bind-title">{tr("用微信扫码绑定", "Scan with WeChat to bind")}</h3>
          <button type="button" className="remote-eye" aria-label={tr("关闭", "Close")} onClick={onClose}>
            <CloseIcon />
          </button>
        </header>
        <p>{tr("绑定后，用这个微信打开 MirrorMix 小程序就直接进入这台电脑。管理员也会看到你的微信头像和昵称。", "Once bound, opening the MirrorMix mini program with this WeChat goes straight to this computer. The administrator sees the avatar and nickname.")}</p>
        {(done || loading || code) && (
          <div className={`remote-bind-code${expired ? " is-expired" : ""}`}>
            {done ? (
              <div className="remote-bind-done">
                <WeChatIcon size={28} />
                <strong>{tr(`已绑定：${done}`, `Bound: ${done}`)}</strong>
              </div>
            ) : loading && !code ? (
              <Spinner />
            ) : code?.image ? (
              <img src={imageUrl(code.image)} alt={tr("绑定微信的小程序码", "Mini program code for binding WeChat")} width={220} height={220} />
            ) : code ? (
              <div className="remote-bind-fallback">
                <span>{code.imageError || tr("没有生成小程序码。", "No mini program code.")}</span>
                <small>{tr("开发时可以在微信开发者工具里用编译条件打开 pages/home/home，启动参数填：", "For development, open pages/home/home in WeChat DevTools with this launch query:")}</small>
                <code>scene={code.ticket}</code>
              </div>
            ) : null}
            {expired && !done && (
              <button type="button" className="quiet-button" onClick={() => void fetchCode()}>
                {tr("二维码已过期，点这里刷新", "Expired. Get a new code")}
              </button>
            )}
          </div>
        )}
        {error && <p className="banner is-warning">{error}</p>}
        {error && !code && (
          <div className="remote-bind-foot">
            <span />
            <button type="button" className="quiet-button" disabled={loading} onClick={() => void fetchCode()}>
              {loading && <Spinner />}
              {tr("再试一次", "Try again")}
            </button>
          </div>
        )}
        {!done && code && !expired && (
          <p className="remote-bind-foot">
            <span>{tr(`${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} 后过期`, `Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`)}</span>
            <button type="button" className="link-button" disabled={loading} onClick={() => void fetchCode()}>
              {tr("换一个", "New code")}
            </button>
          </p>
        )}
      </section>
    </div>
  );
}
