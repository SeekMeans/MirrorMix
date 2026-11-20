import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isClaudePipe, type ClaudeInbox } from "./claudeInbox";

/** Wildcard for the desktop app's claude.exe. -like, not -match: `\c` is a regex control character. */
export const DESKTOP_CLAUDE_LIKE = "*Claude-Data\\claude*";

export function isDesktopClaudeCommand(commandLine: string): boolean {
  const needle = DESKTOP_CLAUDE_LIKE.slice(1, -1);
  return commandLine.toLowerCase().includes(needle.toLowerCase());
}

/** Vars the desktop app injects so its Claude Code process is already logged in. */
export const CLAUDE_HOST_KEYS = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_SCOPES",
  "CLAUDE_CODE_ACCOUNT_UUID",
  "CLAUDE_CODE_ORGANIZATION_UUID",
  "CLAUDE_CODE_USER_EMAIL",
  "CLAUDE_CODE_SUBSCRIPTION_TYPE",
  "CLAUDE_CODE_RATE_LIMIT_TIER",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_KEY",
] as const;

export function claudeChildEnv(
  base: NodeJS.ProcessEnv,
  settings: Record<string, string>,
  host: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (typeof value === "string") env[key] = value;
  }
  for (const [key, value] of Object.entries(settings)) {
    if (!env[key] && value) env[key] = value;
  }
  for (const key of CLAUDE_HOST_KEYS) {
    if (!env[key] && host[key]) env[key] = host[key];
  }
  return env;
}

export function readClaudeSettingsEnv(home = os.homedir()): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(path.join(home, ".claude", "settings.json"), "utf8")) as {
      env?: Record<string, unknown>;
    };
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed.env ?? {})) {
      if (typeof value === "string" && value) env[key] = value;
    }
    return env;
  } catch {
    return {};
  }
}

const HOST_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class HostAuth {
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")]
  public static extern bool CloseHandle(IntPtr handle);
  [DllImport("ntdll.dll")]
  public static extern int NtQueryInformationProcess(IntPtr process, int infoClass, ref PROCESS_BASIC_INFORMATION info, int size, out int returnLength);
  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_BASIC_INFORMATION {
    public IntPtr Reserved1;
    public IntPtr PebBaseAddress;
    public IntPtr Reserved2_0;
    public IntPtr Reserved2_1;
    public IntPtr UniqueProcessId;
    public IntPtr InheritedFromUniqueProcessId;
  }
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, int size, out IntPtr read);
}
"@
function Read-U64([IntPtr]$proc, [int64]$addr) {
  $b = New-Object byte[] 8
  $r = [IntPtr]::Zero
  [void][HostAuth]::ReadProcessMemory($proc, [IntPtr]::new($addr), $b, 8, [ref]$r)
  return [BitConverter]::ToUInt64($b, 0)
}
function Read-Env([int]$processId) {
  $h = [HostAuth]::OpenProcess(0x0410, $false, $processId)
  if ($h -eq [IntPtr]::Zero) { return @{} }
  try {
    $pbi = New-Object HostAuth+PROCESS_BASIC_INFORMATION
    $ret = 0
    [void][HostAuth]::NtQueryInformationProcess($h, 0, [ref]$pbi, [Runtime.InteropServices.Marshal]::SizeOf($pbi), [ref]$ret)
    $pp = Read-U64 $h ([int64]$pbi.PebBaseAddress + 0x20)
    $envPtr = Read-U64 $h ([int64]$pp + 0x80)
    $envSize = Read-U64 $h ([int64]$pp + 0x3F0)
    if ($envSize -le 0 -or $envSize -gt 1048576) { return @{} }
    $buf = New-Object byte[] ([int]$envSize)
    $r = [IntPtr]::Zero
    $ok = [HostAuth]::ReadProcessMemory($h, [IntPtr]::new([int64]$envPtr), $buf, [int]$envSize, [ref]$r)
    if (-not $ok) { return @{} }
    $text = [Text.Encoding]::Unicode.GetString($buf)
    $map = @{}
    foreach ($part in ($text -split [char]0)) {
      $eq = $part.IndexOf('=')
      if ($eq -le 0) { continue }
      $map[$part.Substring(0, $eq)] = $part.Substring($eq + 1)
    }
    return $map
  } finally {
    [void][HostAuth]::CloseHandle($h)
  }
}
$allow = @('CLAUDE_CODE_OAUTH_TOKEN','CLAUDE_CODE_OAUTH_SCOPES','CLAUDE_CODE_ACCOUNT_UUID','CLAUDE_CODE_ORGANIZATION_UUID','CLAUDE_CODE_USER_EMAIL','CLAUDE_CODE_SUBSCRIPTION_TYPE','CLAUDE_CODE_RATE_LIMIT_TIER','ANTHROPIC_BASE_URL','ANTHROPIC_API_KEY')
$found = @{}
$pattern = '${DESKTOP_CLAUDE_LIKE}'
$procs = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'claude.exe' -and $_.CommandLine -like $pattern }
foreach ($proc in $procs) {
  try {
    $map = Read-Env $proc.ProcessId
    if (-not $map['CLAUDE_CODE_OAUTH_TOKEN']) { continue }
    foreach ($key in $allow) { if ($map[$key]) { $found[$key] = $map[$key] } }
    break
  } catch {}
}
if ($found.Count -eq 0) { '{}' } else { $found | ConvertTo-Json -Compress }
`;

let cache: { at: number; env: Record<string, string> } = { at: 0, env: {} };

export function claudeHostAuth(now = Date.now()): Record<string, string> {
  const freshFor = cache.env.CLAUDE_CODE_OAUTH_TOKEN ? 60_000 : 2_000;
  if (now - cache.at < freshFor) return cache.env;
  cache = { at: now, env: readRunningClaudeAuth() };
  return cache.env;
}

/**
 * The sign-in for a Claude Code about to start. A Claude Code started without one stays signed out and stops on the
 * login screen, so an empty answer (the lookup can fail while the PC is busy, e.g. right after a restart) is asked
 * again a few times, past the cache, before giving up.
 */
export function claudeHostAuthForLaunch(
  attempts = 3,
  read: () => Record<string, string> = readRunningClaudeAuth,
  cached: () => Record<string, string> = () => claudeHostAuth(),
): Record<string, string> {
  const known = cached();
  if (known.CLAUDE_CODE_OAUTH_TOKEN) return known;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const env = read();
    if (env.CLAUDE_CODE_OAUTH_TOKEN) {
      cache = { at: Date.now(), env };
      return env;
    }
  }
  return known;
}

/** Whether a sign-in can be found right now, read past the cache. */
export function claudeHostSignedIn(): boolean {
  return Boolean(claudeHostAuthForLaunch(1).CLAUDE_CODE_OAUTH_TOKEN);
}

const INBOX_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class InboxEnv {
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")]
  public static extern bool CloseHandle(IntPtr handle);
  [DllImport("ntdll.dll")]
  public static extern int NtQueryInformationProcess(IntPtr process, int infoClass, ref PROCESS_BASIC_INFORMATION info, int size, out int returnLength);
  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_BASIC_INFORMATION {
    public IntPtr Reserved1;
    public IntPtr PebBaseAddress;
    public IntPtr Reserved2_0;
    public IntPtr Reserved2_1;
    public IntPtr UniqueProcessId;
    public IntPtr InheritedFromUniqueProcessId;
  }
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, int size, out IntPtr read);
}
"@
function Read-U64([IntPtr]$proc, [int64]$addr) {
  $b = New-Object byte[] 8
  $r = [IntPtr]::Zero
  [void][InboxEnv]::ReadProcessMemory($proc, [IntPtr]::new($addr), $b, 8, [ref]$r)
  return [BitConverter]::ToUInt64($b, 0)
}
function Read-Env([int]$processId) {
  $h = [InboxEnv]::OpenProcess(0x0410, $false, $processId)
  if ($h -eq [IntPtr]::Zero) { return @{} }
  try {
    $pbi = New-Object InboxEnv+PROCESS_BASIC_INFORMATION
    $ret = 0
    [void][InboxEnv]::NtQueryInformationProcess($h, 0, [ref]$pbi, [Runtime.InteropServices.Marshal]::SizeOf($pbi), [ref]$ret)
    $pp = Read-U64 $h ([int64]$pbi.PebBaseAddress + 0x20)
    $envPtr = Read-U64 $h ([int64]$pp + 0x80)
    $envSize = Read-U64 $h ([int64]$pp + 0x3F0)
    if ($envSize -le 0 -or $envSize -gt 1048576) { return @{} }
    $buf = New-Object byte[] ([int]$envSize)
    $r = [IntPtr]::Zero
    if (-not [InboxEnv]::ReadProcessMemory($h, [IntPtr]::new([int64]$envPtr), $buf, [int]$envSize, [ref]$r)) { return @{} }
    $map = @{}
    foreach ($part in ([Text.Encoding]::Unicode.GetString($buf) -split [char]0)) {
      $eq = $part.IndexOf('=')
      if ($eq -le 0) { continue }
      $map[$part.Substring(0, $eq)] = $part.Substring($eq + 1)
    }
    return $map
  } finally {
    [void][InboxEnv]::CloseHandle($h)
  }
}
$id = $env:AIMISS_SESSION_ID
$skip = @()
if ($env:AIMISS_SKIP_PIDS) { $skip = $env:AIMISS_SKIP_PIDS.Split(',') | ForEach-Object { [int]$_ } }
$hostRow = $env:AIMISS_HOST_SESSION_ID
$claudes = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'claude.exe' -and $skip -notcontains $_.ProcessId })
# The desktop app forks a transcript when it resumes it, and starts new ones without any id on the
# command line, so its own row id in the process environment is the dependable match.
if ($hostRow) {
  foreach ($proc in ($claudes | Where-Object { $_.CommandLine -like '*stream-json*' })) {
    try {
      $map = Read-Env $proc.ProcessId
      if ($map['CLAUDE_CODE_HOST_SESSION_ID'] -ne $hostRow) { continue }
      $pipe = $map['CLAUDE_CODE_MESSAGING_SOCKET']
      $token = $map['CLAUDE_CODE_MESSAGING_TOKEN']
      if ($pipe -and $token) {
        @{ pipe = $pipe; token = $token } | ConvertTo-Json -Compress
        exit 0
      }
    } catch {}
  }
}
foreach ($proc in ($claudes | Where-Object { $_.CommandLine -like "*$id*" })) {
  try {
    $map = Read-Env $proc.ProcessId
    $pipe = $map['CLAUDE_CODE_MESSAGING_SOCKET']
    $token = $map['CLAUDE_CODE_MESSAGING_TOKEN']
    if ($pipe -and $token) {
      @{ pipe = $pipe; token = $token } | ConvertTo-Json -Compress
      exit 0
    }
  } catch {}
}
'{}'
`;

const inboxCache = new Map<string, { at: number; inbox: ClaudeInbox | null }>();

/** `hostSession` is the desktop row (`local_…`) the transcript belongs to, when there is one. */
export function claudeInboxForSession(
  sessionId: string,
  skipPids: number[] = [],
  now = Date.now(),
  hostSession = "",
): ClaudeInbox | null {
  if (!/^[0-9a-f-]{16,}$/i.test(sessionId)) return null;
  if (hostSession && !/^local_[0-9a-f-]{16,}$/i.test(hostSession)) hostSession = "";
  const key = `${sessionId}|${hostSession}|${skipPids.join(",")}`;
  const hit = inboxCache.get(key);
  if (hit && now - hit.at < 10_000) return hit.inbox;
  const inbox = readClaudeInbox(sessionId, skipPids, hostSession);
  inboxCache.set(key, { at: now, inbox });
  return inbox;
}

function readClaudeInbox(sessionId: string, skipPids: number[], hostSession: string): ClaudeInbox | null {
  if (process.platform !== "win32") return null;
  try {
    const output = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-Command", INBOX_SCRIPT],
      {
        encoding: "utf8",
        maxBuffer: 1_000_000,
        windowsHide: true,
        env: {
          ...process.env,
          AIMISS_SESSION_ID: sessionId,
          AIMISS_HOST_SESSION_ID: hostSession,
          AIMISS_SKIP_PIDS: skipPids.filter((pid) => Number.isInteger(pid) && pid > 0).join(","),
        },
      },
    );
    const parsed = JSON.parse(output.trim() || "{}") as { pipe?: unknown; token?: unknown };
    if (typeof parsed.pipe !== "string" || typeof parsed.token !== "string") return null;
    if (!isClaudePipe(parsed.pipe) || !parsed.token) return null;
    return { pipe: parsed.pipe, token: parsed.token };
  } catch {
    return null;
  }
}

function readRunningClaudeAuth(): Record<string, string> {
  if (process.platform !== "win32") return {};
  try {
    const output = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-Command", HOST_SCRIPT],
      { encoding: "utf8", maxBuffer: 1_000_000, windowsHide: true },
    );
    const parsed = JSON.parse(output.trim() || "{}") as Record<string, unknown>;
    const env: Record<string, string> = {};
    for (const key of CLAUDE_HOST_KEYS) {
      const value = parsed[key];
      if (typeof value === "string" && value) env[key] = value;
    }
    return env;
  } catch {
    return {};
  }
}
