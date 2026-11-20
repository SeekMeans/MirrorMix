import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./winlogon.ps1", import.meta.url));

export class AccountLocked extends Error {
  constructor() {
    super("locked");
  }
}

/** Asks Windows whether this username and password can log on. The password stays on the process stdin and is not stored. */
export function verifyWindowsLogin(username: string, password: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
      { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] },
    );
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, 20_000);
    let out = "";
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      resolve(ok);
    };
    child.stdout.on("data", (chunk) => {
      if (out.length < 16) out += String(chunk);
    });
    child.on("error", () => finish(false));
    child.on("close", () => {
      clearTimeout(timer);
      if (out.trim() === "locked") {
        reject(new AccountLocked());
        return;
      }
      resolve(out.trim() === "ok");
    });
    child.stdin.write(JSON.stringify({ username, password }));
    child.stdin.end();
  });
}
