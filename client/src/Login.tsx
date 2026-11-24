import { useEffect, useState, type FormEvent } from "react";
import { App } from "./App";
import { AUTH_EXPIRED } from "./api";
import { readAuthStatus } from "./authStatus";
import { Mark, Spinner } from "./icons";

import { tr } from "./i18n";
type Phase = "checking" | "in" | "out";

function loginError(code: string | undefined, account: string): string {
  if (code === "bad_credentials") {
    return account ? tr(`用户名或密码不对。这台电脑的账户是 ${account}。`, `Wrong user name or password. This computer's account is ${account}.`) : tr("用户名或密码不对。", "Wrong user name or password.");
  }
  if (code === "rate_limited") return tr("试得太勤了，等一会儿再试。", "Too many tries. Wait a moment, then try again.");
  if (code === "bad_origin") return tr("这个地址没有被允许登录。经过反向代理访问时，在 MIRRORMIX_ALLOWED_ORIGINS 里加上它。", "Signing in is not allowed from this address. When going through a reverse proxy, add it to MIRRORMIX_ALLOWED_ORIGINS.");
  if (code === "locked") return tr("这个 Windows 账户已被锁定。先别继续试，等大约 10 分钟，或在系统里解锁后再登录。", "This Windows account is locked. Stop trying for now; wait about 10 minutes, or unlock it in Windows, then sign in.");
  return tr("登录没有完成。", "Sign-in did not complete.");
}

function Login({ account, expired, onSuccess }: { account: string; expired: boolean; onSuccess: () => void }) {
  const [username, setUsername] = useState(account);
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
        body: JSON.stringify({ username, password }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setNotice(loginError(body.error, account));
        return;
      }
      onSuccess();
    } catch {
      setNotice(loginError(undefined, account));
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
        <p className="login-lead">{tr("使用这台电脑的 Windows 账户，不要填电脑名。域账户写成 域名\\用户名。", "Use this computer's Windows account, without the computer's name. Write a domain account as domain\\user.")}</p>
        <label>
          {tr("用户名", "User name")}
          <input
            name="username"
            autoComplete="username"
            autoFocus
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
        </label>
        <label>
          {tr("密码", "Password")}
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {notice && <p className="login-notice">{notice}</p>}
        <button className="send login-submit" type="submit" disabled={busy || !username.trim() || !password}>
          {busy ? tr("正在核对", "Checking") : tr("进入", "Sign in")}
        </button>
      </form>
    </main>
  );
}

/** The desk stays behind the login until Windows accepts the account. An older server without this route still opens. */
export function AuthGate() {
  const [phase, setPhase] = useState<Phase>("checking");
  const [account, setAccount] = useState("");
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
        if (status.username) setAccount(status.username);
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

  if (phase === "out") return <Login account={account} expired={expired} onSuccess={() => {
    setExpired(false);
    setPhase("in");
  }} />;
  return <App onLogout={() => void leave()} />;
}
