import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api, type RemoteConfig, type RemoteView } from "./api";
import { EyeIcon, EyeOffIcon, Spinner } from "./icons";

const STATE_TEXT: Record<RemoteView["status"]["state"], string> = {
  off: "未开启",
  starting: "正在连接",
  connected: "已连接",
  error: "没有连上",
};

/** Every PC answers under this domain on port 443. The server says so too; this covers an older server. */
const REMOTE_DOMAIN = "mm.seekmeans.cn";

function errorText(code: string | undefined): string {
  if (code === "bad_subdomain") return "子域名只能用小写字母、数字和中间的短横线，最长 63 个字符。";
  if (code === "bad_token") return "连接口令太长了。";
  return "没有保存。确认 MirrorMix 还在运行，再试一次。";
}

type Draft = Pick<RemoteConfig, "subdomain"> & { token: string };

function draftOf(view: RemoteView): Draft {
  return { subdomain: view.subdomain, token: "" };
}

/**
 * Settings for reaching this PC from outside through the shared server.
 * The server itself comes from mirrormix.config.json; each PC only picks its subdomain and turns it on.
 */
export function RemotePanel() {
  const [view, setView] = useState<RemoteView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [revealing, setRevealing] = useState(false);
  /** The saved token as fetched for the eye button. Sending it back unchanged is not a change. */
  const [revealed, setRevealed] = useState<string | null>(null);
  const edited = useRef(false);

  const load = useCallback(async () => {
    try {
      const next = await api.remote();
      setView(next);
      // Keep what the person is typing; only fill the form while it is untouched.
      if (!edited.current) setDraft(draftOf(next));
    } catch {
      setError("读不到外网访问的设置。确认 MirrorMix 还在运行。");
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
      setError(errorText((failure as { code?: string }).code));
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

  const change = (key: keyof Draft, value: string) => {
    edited.current = true;
    setSaved(false);
    setDraft((current) => (current ? { ...current, [key]: value } : current));
  };

  const toggleToken = async () => {
    if (showToken) {
      setShowToken(false);
      return;
    }
    // Nothing typed yet: show the saved token, fetched only now.
    if (draft && !draft.token && view?.hasToken) {
      setRevealing(true);
      try {
        const { token } = await api.remoteToken();
        if (token) {
          edited.current = true;
          setRevealed(token);
          setDraft((current) => (current ? { ...current, token } : current));
        }
      } catch {
        setError("读不到保存的口令。");
      } finally {
        setRevealing(false);
      }
    }
    setShowToken(true);
  };

  const save = async (event?: FormEvent, enabled?: boolean) => {
    event?.preventDefault();
    if (!draft) return;
    setSaving(true);
    setError("");
    const newToken = draft.token.trim() && draft.token !== revealed ? draft.token : "";
    try {
      const next = await api.saveRemote({
        subdomain: draft.subdomain,
        ...(newToken ? { token: newToken } : {}),
        ...(enabled === undefined ? {} : { enabled }),
      });
      edited.current = false;
      setView(next);
      setDraft(draftOf(next));
      setRevealed(null);
      setShowToken(false);
      setSaved(enabled === undefined);
    } catch (failure) {
      setError(errorText((failure as { code?: string }).code));
    } finally {
      setSaving(false);
    }
  };

  if (!view || !draft) {
    return (
      <div className="remote-loading">
        {error ? <p className="banner is-warning">{error}</p> : <Spinner />}
      </div>
    );
  }

  const { state, message } = view.status;
  const domain = view.domain || REMOTE_DOMAIN;
  // The address follows the subdomain as it is typed; it takes effect once saved.
  const url = draft.subdomain ? `https://${draft.subdomain}.${domain}` : "";
  const pending = draft.subdomain !== view.subdomain;

  const copy = async () => {
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
    <form className="remote" onSubmit={(event) => void save(event)}>
      <div className={`remote-status is-${state}`} role="status" aria-live="polite">
        <div className="remote-status-line">
          {state === "starting" ? <Spinner /> : <span className="dot" aria-hidden="true" />}
          <strong>{STATE_TEXT[state]}</strong>
          <button
            type="button"
            role="switch"
            aria-checked={view.enabled}
            aria-label="开启外网访问"
            className="switch"
            disabled={saving}
            onClick={() => void save(undefined, !view.enabled)}
          >
            <span />
          </button>
        </div>
        {view.enabled && url && (
          <div className="remote-url">
            {state === "connected" && !pending ? (
              <a href={url} target="_blank" rel="noreferrer">
                {url}
              </a>
            ) : (
              <span>{url}</span>
            )}
            <button type="button" className="link-button" onClick={() => void copy()}>
              {copied ? "已复制" : "复制地址"}
            </button>
          </div>
        )}
        {view.enabled && pending && url && <p className="remote-message">子域名改过了，保存后这个地址才生效。</p>}
        {view.enabled && message && <p className="remote-message">{message}</p>}
        {/* Not connected: it tries again by itself after a growing wait, and can be told to try now. */}
        {view.enabled && state === "error" && (
          <div className="remote-retry">
            <span>
              {view.status.retryAt && view.status.retryAt > now
                ? `${Math.max(1, Math.ceil((view.status.retryAt - now) / 1000))} 秒后自动重试`
                : "可以手动重试"}
            </span>
            <button type="button" className="quiet-button" disabled={retrying || saving} onClick={() => void retryNow()}>
              {retrying ? <Spinner /> : null}
              {retrying ? "正在重试" : "立即重试"}
            </button>
          </div>
        )}
        {!view.enabled && (
          <p className="remote-message">
            打开后填写子域名和连接口令，两项都在 MirrorMix 小程序里开通地址后显示。MirrorMix 会在后台运行 frpc，通过服务器把这台电脑放到 子域名.{domain} 上，MirrorMix 退出时一起停止。
          </p>
        )}
      </div>

      {error && <p className="banner is-warning">{error}</p>}

      {view.enabled && (
        <>
          <div className="remote-fields">
            <label className="wide">
              <span>连接口令</span>
              <div className="remote-secret">
                <input
                  type={showToken ? "text" : "password"}
                  value={draft.token}
                  placeholder={view.hasToken ? "已保存。要更换时才填" : "MirrorMix 小程序里显示的连接口令"}
                  autoComplete="new-password"
                  spellCheck={false}
                  onChange={(event) => change("token", event.target.value)}
                />
                <button
                  type="button"
                  className="remote-eye"
                  aria-label={showToken ? "隐藏口令" : "显示口令"}
                  aria-pressed={showToken}
                  title={showToken ? "隐藏口令" : "显示口令"}
                  disabled={revealing || (!draft.token && !view.hasToken)}
                  onClick={() => void toggleToken()}
                >
                  {revealing ? <Spinner /> : showToken ? <EyeOffIcon /> : <EyeIcon />}
                </button>
              </div>
            </label>
            <label className="wide">
              <span>子域名</span>
              <div className="remote-suffix">
                <input
                  value={draft.subdomain}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => change("subdomain", event.target.value.toLowerCase())}
                />
                <span>.{domain}</span>
              </div>
            </label>
          </div>

          <div className="remote-actions">
            <p className="remote-preview">
              服务器 {view.server}:{view.serverPort}，由 MirrorMix 内置 frpc.exe 自动连接
            </p>
            <button type="submit" className="quiet-button" disabled={saving}>
              {saving && <Spinner />}
              {saving ? "正在保存" : saved ? "已保存" : "保存并重新连接"}
            </button>
          </div>
        </>
      )}
    </form>
  );
}
