import { execFileSync } from "node:child_process";

/** The shell inherits this service's token. Account names alone do not tell us whether UAC elevated it. */
export function terminalElevation(): boolean | null {
  if (process.platform !== "win32") return process.getuid ? process.getuid() === 0 : null;
  try {
    const script = "$p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent()); $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)";
    const result = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 5_000 }).trim().toLowerCase();
    return result === "true" ? true : result === "false" ? false : null;
  } catch { return null; }
}
