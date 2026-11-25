import { useEffect, useState, type FormEvent } from "react";
import { App } from "./App";
import { AUTH_EXPIRED } from "./api";
import { readAuthStatus } from "./authStatus";
import { Mark, Spinner } from "./icons";

import { tr } from "./i18n";
type Phase = "checking" | "in" | "out";

function loginError(code: string | undefined): string {
  if (code === "bad_credentials") return tr("访问密码不对。", "Wrong access password.");
  if (code === "no_access_password") return tr("这台电脑还没有设置访问密码。在电脑上打开 设置 → 外网访问，设置后再来。", "This computer has no access password yet. Set one on the computer under Settings → Remote access, then come back.");
  if (code === "rate_limited") return tr("试得太勤了，等一会儿再试。", "Too many tries. Wait a moment, then try again.");
  if (code === "bad_origin") return tr("这个地址没有被允许登录。经过反向代理访问时，在 MIRRORMIX_ALLOWED_ORIGINS 里加上它。", "Signing in is not allowed from this address. When going through a reverse proxy, add it to MIRRORMIX_ALLOWED_ORIGINS.");
  return tr("登录没有完成。", "Sign-in did not complete.");
}

function Login({ passwordSet, expired, onSuccess }: { passwordSet: boolean; expired: boolean; onSuccess: () => void }) {
  const [password, setPassword] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setNotice(loginError(body.error));
        return;
      }
      onSuccess();
    } catch {
      setNotice(loginError(undefined));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login-page">
      <form className="login-card" onSubmit={(event) => void submit(event)}>
        <div className="brand">
          <Mark />
          <span>MirrorMix</span>
        </div>
        <h1>{tr("登录", "Sign in")}</h1>
        {expired && <p className="login-notice" role="alert">{tr("登录已失效，请重新登录。", "Your sign-in has expired. Please sign in again.")}</p>}
        {passwordSet ? (
          <p className="login-lead">{tr("输入在电脑上 设置 → 外网访问 里设置的访问密码。", "Enter the access password set on the computer under Settings → Remote access.")}</p>
        ) : (
          <p className="login-notice">{loginError("no_access_password")}</p>
        )}
        <label>
          {tr("访问密码", "Access password")}
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {notice && <p className="login-notice">{notice}</p>}
        <button className="send login-submit" type="submit" disabled={busy || !password}>
          {busy ? tr("正在核对", "Checking") : tr("进入", "Sign in")}
        </button>
      </form>
    </main>
  );
}

/** From outside, the desk stays behind the access password. On this PC it opens at once. An older server without this route still opens. */
export function AuthGate() {
  const [phase, setPhase] = useState<Phase>("checking");
  const [passwordSet, setPasswordSet] = useState(true);
  const [signedIn, setSignedIn] = useState(false);
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    const onExpired = () => {
      setExpired(true);
      setPhase("out");
    };
    window.addEventListener(AUTH_EXPIRED, onExpired);
    return () => window.removeEventListener(AUTH_EXPIRED, onExpired);
  }, []);

  useEffect(() => {
    let gone = false;
    fetch("/api/session", { cache: "no-store" })
      .then(async (response) => {
        const status = await readAuthStatus(response);
        if (gone) return;
        setPasswordSet(status.passwordSet);
        setSignedIn(status.signedIn);
        setPhase(status.authenticated ? "in" : "out");
      })
      .catch(() => {
        if (!gone) setPhase("out");
      });
    return () => {
      gone = true;
    };
  }, []);

  if (phase === "checking") {
    return (
      <main className="login-page">
        <Spinner />
      </main>
    );
  }
  const leave = async () => {
    const response = await fetch("/api/logout", { method: "POST" }).catch(() => null);
    if (response?.ok) {
      setExpired(false);
      setPhase("out");
    }
  };

  if (phase === "out") return <Login passwordSet={passwordSet} expired={expired} onSuccess={() => {
    setExpired(false);
    setSignedIn(true);
    setPhase("in");
  }} />;
  return <App onLogout={signedIn ? () => void leave() : undefined} />;
}
