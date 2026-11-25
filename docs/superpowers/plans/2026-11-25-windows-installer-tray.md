# Windows Installer + Tray Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Windows Setup exe that checks for Node.js 22+, installs MirrorMix without bundling Node, and provides a tray control panel to start/stop the server and open the browser.

**Architecture:** Inno Setup builds `MirrorMix-Setup-*.exe` from a staging tree prepared by `deploy/build.ps1`. Staging holds the app (`dist/`, `src/`, production `node_modules` plus `tsx`), optional `frpc.exe`, and `MirrorMixPanel.exe`. The panel starts `node node_modules/tsx/dist/cli.mjs src/server/main.ts` with cwd = install root, polls `http://127.0.0.1:<port>/`, then opens the default browser. The entire `deploy/` directory is gitignored; only `.gitignore` / README notes are tracked.

**Tech Stack:** PowerShell, Inno Setup 7, C# WinForms (.NET 11 `net11.0-windows`), Node 22+, existing MirrorMix server.

## Global Constraints

- Do not bundle Node.js in the installer; require system Node major version ≥ 22.
- Installer Node gate: prompt with Open download page (`https://nodejs.org/`), Retry, Cancel.
- Tray panel required; closing the window hides to tray and does not stop the server by default.
- Start must open the browser once when the server becomes ready.
- Stop only the process tree started by the panel (port default `4789`).
- Listen remains `127.0.0.1` only; never bind `0.0.0.0`.
- Default install dir: `{localappdata}\MirrorMix`.
- Do not delete `%USERPROFILE%\.mirrormix\` on uninstall.
- `deploy/` is gitignored (scripts + outputs live only on the maintainer machine).
- Do not commit unless the user asks; skip git commit steps while implementing unless explicitly requested.
- Replies to the user in Simplified Chinese when chatting; code/UI strings for the panel may be Chinese.

---

## File map

| Path | Responsibility |
|---|---|
| `.gitignore` | Ignore `deploy/` |
| `README.md` / `README.zh-CN.md` | One short note that the Windows installer is built locally via `deploy/` |
| `deploy/build.ps1` | Build client, stage app, install deps + tsx, build panel, run ISCC |
| `deploy/MirrorMix.iss` | Inno script: Node check, files, shortcuts, uninstall stop |
| `deploy/panel/MirrorMixPanel.csproj` | WinForms tray project |
| `deploy/panel/Program.cs` | Entry, single-instance optional |
| `deploy/panel/MainForm.cs` | UI + tray + start/stop/open |
| `deploy/panel/NodeVersion.cs` | Parse `node -v`, major ≥ 22 |
| `deploy/panel/ServerProcess.cs` | Start/stop MirrorMix process tree, readiness poll |
| `deploy/panel/PanelSettings.cs` | Read/write `%USERPROFILE%\.mirrormix\panel.json` |
| `deploy/staging/` | Generated; not hand-edited |
| `deploy/out/` | Generated Setup exe |

---

### Task 1: Ignore `deploy/` and document local installer

**Files:**
- Modify: `.gitignore`
- Modify: `README.md`
- Modify: `README.zh-CN.md`

**Interfaces:**
- Produces: git stops tracking `deploy/`; README points maintainers at local `deploy/build.ps1`

- [ ] **Step 1: Append deploy ignore**

Add to `.gitignore`:

```
deploy/
```

If `deploy/` was tracked, run once:

```powershell
git -C E:\Me\AIMiss rm -r --cached deploy
```

Expected: `deploy/` shows as deleted from the index (working tree files remain).

- [ ] **Step 2: README note (English)**

In `README.md`, after Quick start (or under a short “Windows installer” heading), add:

```markdown
## Windows installer

Maintainers can build a Setup exe on Windows with the local (gitignored) `deploy/build.ps1` script. The installer does not bundle Node.js; it requires Node.js 22+ on the target machine and installs a tray panel to start/stop MirrorMix.
```

- [ ] **Step 3: README note (Chinese)**

In `README.zh-CN.md`, matching section:

```markdown
## Windows 安装包

维护者可在 Windows 上用本地（已被 gitignore）的 `deploy/build.ps1` 打出 Setup 安装包。安装包不内嵌 Node.js，目标机器需 Node.js 22+，并提供托盘面板启停 MirrorMix。
```

- [ ] **Step 4: Verify ignore**

```powershell
git -C E:\Me\AIMiss check-ignore -v deploy/build.ps1
```

Expected: a line citing `.gitignore` and `deploy/`.

---

### Task 2: Panel settings + Node version helper (C#)

**Files:**
- Create: `deploy/panel/MirrorMixPanel.csproj`
- Create: `deploy/panel/PanelSettings.cs`
- Create: `deploy/panel/NodeVersion.cs`

**Interfaces:**
- Produces:
  - `PanelSettings.Load()` / `Save()` → `Port` (int, default 4789), file `%USERPROFILE%\.mirrormix\panel.json`
  - `NodeVersion.TryGetMajor(out int major, out string raw)` → bool
  - `NodeVersion.IsSupported(int major)` → `major >= 22`
  - `NodeVersion.OpenDownloadPage()` → opens `https://nodejs.org/`

- [ ] **Step 1: Create csproj**

`deploy/panel/MirrorMixPanel.csproj`:

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>WinExe</OutputType>
    <TargetFramework>net11.0-windows</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <UseWindowsForms>true</UseWindowsForms>
    <AssemblyName>MirrorMixPanel</AssemblyName>
    <RootNamespace>MirrorMixPanel</RootNamespace>
    <ApplicationManifest>app.manifest</ApplicationManifest>
  </PropertyGroup>
</Project>
```

- [ ] **Step 2: app.manifest (asInvoker)**

Create `deploy/panel/app.manifest` with a standard asInvoker Windows Forms manifest (no requireAdministrator).

- [ ] **Step 3: PanelSettings.cs**

```csharp
using System.Text.Json;

namespace MirrorMixPanel;

public sealed class PanelSettings
{
    public int Port { get; set; } = 4789;

    static string PathFile =>
        System.IO.Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            ".mirrormix", "panel.json");

    public static PanelSettings Load()
    {
        try
        {
            var path = PathFile;
            if (!File.Exists(path)) return new PanelSettings();
            var loaded = JsonSerializer.Deserialize<PanelSettings>(File.ReadAllText(path));
            if (loaded is null) return new PanelSettings();
            if (loaded.Port < 1 || loaded.Port > 65535) loaded.Port = 4789;
            return loaded;
        }
        catch
        {
            return new PanelSettings();
        }
    }

    public void Save()
    {
        var dir = System.IO.Path.GetDirectoryName(PathFile)!;
        Directory.CreateDirectory(dir);
        File.WriteAllText(PathFile, JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
    }
}
```

- [ ] **Step 4: NodeVersion.cs**

Implement by starting `node` with args `-v`, `UseShellExecute = false`, redirect stdout, no window. Parse first line with regex `v?(?<maj>\d+)`. `TryGetMajor` returns false if process missing or exit non-zero or parse fail. `OpenDownloadPage` uses `Process.Start(new ProcessStartInfo { FileName = "https://nodejs.org/", UseShellExecute = true })`.

- [ ] **Step 5: Smoke-compile helpers**

```powershell
dotnet build E:\Me\AIMiss\deploy\panel\MirrorMixPanel.csproj -c Release
```

Expected: build succeeds once `Program.cs` / `MainForm` stubs exist; if not yet, add empty `Program.cs` with `Application.Run(new Form())` temporarily, or finish Task 3 first then build.

---

### Task 3: Server process controller + main form / tray

**Files:**
- Create: `deploy/panel/ServerProcess.cs`
- Create: `deploy/panel/MainForm.cs`
- Create: `deploy/panel/Program.cs`

**Interfaces:**
- Consumes: `PanelSettings`, `NodeVersion`
- Produces:
  - `ServerProcess.Start(installRoot, port)` / `Stop()` / `bool IsRunning`
  - Ready when `GET http://127.0.0.1:{port}/` returns any HTTP response within timeout (15s)
  - Working directory = `installRoot`
  - Command: `node` + `node_modules\tsx\dist\cli.mjs` + `src\server\main.ts`
  - Env: set `AIMISS_PORT` to port string; inherit the rest
  - `Stop()` kills the root process and its children (use `taskkill /PID <pid> /T /F` on Windows)

- [ ] **Step 1: ServerProcess.cs**

Key behaviors:

- Resolve `node` via `NODE` env or `"node"` on PATH
- Arguments: `"node_modules\\tsx\\dist\\cli.mjs"`, `"src\\server\\main.ts"`
- `CreateNoWindow = true`, redirect stdout/stderr to a rotating log under `%USERPROFILE%\.mirrormix\panel-server.log` (append, best-effort)
- Store started PID; `IsRunning` checks process hasn't exited
- `WaitUntilReady(port, timeout)` polls every 200ms with `HttpClient` ignore cert (http only)

- [ ] **Step 2: MainForm.cs**

Chinese UI labels:

- 状态 / 端口 / 启动 / 停止 / 打开网页
- NotifyIcon text: `MirrorMix`
- Context menu: 显示主窗口、启动、停止、打开网页、退出
- Form `FormClosing`: if user close (`CloseReason.UserClosing`), cancel and `Hide()` + show tray balloon once optional
- 退出: if server running, `MessageBox`「是否同时停止 MirrorMix 服务？」Yes/No/Cancel; Yes → Stop then exit; No → exit leave server; Cancel → stay
- 启动: if `!NodeVersion.TryGetMajor` or `!IsSupported`, MessageBox with 打开下载页 / 取消; on success Start + WaitUntilReady + `OpenBrowser`
- Port `NumericUpDown` 1–65535; on change save settings
- `installRoot`: `AppContext.BaseDirectory` trimmed (panel exe sits in install root next to `package.json`)

- [ ] **Step 3: Program.cs**

```csharp
namespace MirrorMixPanel;

static class Program
{
    [STAThread]
    static void Main()
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm());
    }
}
```

- [ ] **Step 4: Publish panel exe**

```powershell
dotnet publish E:\Me\AIMiss\deploy\panel\MirrorMixPanel.csproj -c Release -r win-x64 --self-contained false -o E:\Me\AIMiss\deploy\panel\publish
```

Expected: `deploy/panel/publish/MirrorMixPanel.exe` exists. Prefer framework-dependent; if the maintainer machine lacks shared runtime on target PCs, switch to `--self-contained true` / `-p:PublishSingleFile=true` in Task 5’s build script.

- [ ] **Step 5: Manual panel smoke (optional before installer)**

With MirrorMix already installable from source, copy published exe into a folder that has `package.json`, `src`, `dist`, `node_modules`(+tsx), run the exe, click 启动, confirm browser opens and stop works.

---

### Task 4: Inno Setup script with Node gate

**Files:**
- Create: `deploy/MirrorMix.iss`

**Interfaces:**
- Consumes: staged files under `deploy\staging\*` and `deploy\panel\publish\MirrorMixPanel.exe` (build.ps1 copies panel into staging before ISCC)
- Produces: installer that refuses to proceed without Node ≥ 22

- [ ] **Step 1: Write MirrorMix.iss**

Essential directives:

```iss
#define MyAppName "MirrorMix"
#define MyAppVersion "0.1.0"
#define MyAppPublisher "tnndworlds"
#define MyAppExeName "MirrorMixPanel.exe"

[Setup]
AppId={{A6F3C2B1-8D4E-4F1A-9C70-MIRRORMIX001}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\MirrorMix
DefaultGroupName=MirrorMix
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=out
OutputBaseFilename=MirrorMix-Setup-{#MyAppVersion}
Compression=lzma
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\{#MyAppExeName}

[Languages]
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; Flags: unchecked

[Files]
Source: "staging\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "启动 MirrorMix 控制面板"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "taskkill"; Parameters: "/IM MirrorMixPanel.exe /F"; RunOnceId: "StopPanel"; Flags: runhidden; \
  StatusMsg: "Stopping panel..."
```

- [ ] **Step 2: Pascal `[Code]` Node check**

Implement `InitializeSetup(): Boolean` that loops:

1. `Exec('cmd.exe', '/c node -v > "%TEMP%\mirrormix-node-ver.txt"', ...)` or use `Exec` on `node` with `-v` and capture via temp file
2. Read file; parse major with `StrToIntDef`
3. If fail: `MsgBox` with custom buttons — Inno can use `MsgBox` then `ShellExec` for download, then ask retry via `MsgBox(MB_RETRYCANCEL)`
4. Return `True` only when major ≥ 22

Pseudo-flow:

```
while True do
  if NodeMajor >= 22 then return True
  ResultCode := MsgBox('需要 Node.js 22 或更高版本。'+#13#10+'打开下载页后请安装，再点重试。', mbError, MB_ABORTRETRYIGNORE)
  // Map: Retry -> continue; Abort/Cancel -> False; Ignore -> ShellExec nodejs.org then continue
```

Prefer three clear actions: use two dialogs if needed (first: 打开下载页 / 重试 / 取消).

- [ ] **Step 3: Uninstall stop server**

Before file removal, `[Code] CurUninstallStepChanged` on `usUninstall`: try `taskkill /IM MirrorMixPanel.exe /F`; also kill listener on port from panel.json if easy — minimum is kill panel and document that user should Stop first. Better: panel writes `%USERPROFILE%\.mirrormix\panel.pid` with server PID; uninstall `taskkill /PID ... /T /F`. Add pid file write/delete in `ServerProcess` (Task 3 follow-up if not already).

- [ ] **Step 4: Dry-compile iss when staging exists**

After Task 5 produces staging, run:

```powershell
& "$env:ProgramFiles\Inno Setup 7\ISCC.exe" E:\Me\AIMiss\deploy\MirrorMix.iss
```

Expected: `deploy\out\MirrorMix-Setup-0.1.0.exe`.

---

### Task 5: `deploy/build.ps1` staging + full pipeline

**Files:**
- Create: `deploy/build.ps1`

**Interfaces:**
- Consumes: repo root MirrorMix sources
- Produces: `deploy/staging/**`, `deploy/out/MirrorMix-Setup-*.exe`

- [ ] **Step 1: Write build.ps1**

Behavior outline:

```powershell
$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Deploy = $PSScriptRoot
$Staging = Join-Path $Deploy "staging"
$OutPanel = Join-Path $Deploy "panel\publish"
$Iscc = Join-Path $env:ProgramFiles "Inno Setup 7\ISCC.exe"

function Require-Cmd($name) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    throw "Missing required tool: $name"
  }
}

Require-Cmd node
Require-Cmd npm
Require-Cmd dotnet
if (-not (Test-Path $Iscc)) { throw "Inno Setup 7 not found at $Iscc. Install from https://jrsoftware.org/isinfo.php" }

$ver = node -v
if ($ver -notmatch 'v?(?<m>\d+)') { throw "Cannot parse node version: $ver" }
if [int]$Matches.m -lt 22 { throw "Build machine needs Node.js 22+, found $ver" }

Push-Location $Root
try {
  npm ci
  if ($LASTEXITCODE -ne 0) { npm install; if ($LASTEXITCODE -ne 0) { throw "npm install failed" } }
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "vite build failed" }
} finally { Pop-Location }

if (Test-Path $Staging) { Remove-Item $Staging -Recurse -Force }
New-Item -ItemType Directory -Path $Staging | Out-Null

$copy = @(
  "package.json",
  "package-lock.json",
  "src",
  "dist",
  "client",   # only if runtime needs it — prefer NOT; dist is enough for pages
  "vite.config.ts" # not needed at runtime — skip
)
# Copy explicitly:
Copy-Item (Join-Path $Root "package.json") $Staging
Copy-Item (Join-Path $Root "package-lock.json") $Staging
Copy-Item (Join-Path $Root "src") (Join-Path $Staging "src") -Recurse
Copy-Item (Join-Path $Root "dist") (Join-Path $Staging "dist") -Recurse
if (Test-Path (Join-Path $Root "frpc.exe")) {
  Copy-Item (Join-Path $Root "frpc.exe") $Staging
}
if (Test-Path (Join-Path $Root "mirrormix.config.json")) {
  Copy-Item (Join-Path $Root "mirrormix.config.json") $Staging
}

# Strip dev-oriented scripts in a staging package.json start field for clarity (optional):
# keep package.json as-is; panel invokes tsx directly.

Push-Location $Staging
try {
  npm ci --omit=dev
  if ($LASTEXITCODE -ne 0) { npm install --omit=dev; if ($LASTEXITCODE -ne 0) { throw "staging npm install failed" } }
  npm install tsx@4.19.2 --omit=dev --no-fund --no-audit
  if ($LASTEXITCODE -ne 0) { throw "tsx install failed" }
} finally { Pop-Location }

dotnet publish (Join-Path $Deploy "panel\MirrorMixPanel.csproj") -c Release -r win-x64 --self-contained false -o $OutPanel
if ($LASTEXITCODE -ne 0) { throw "panel publish failed" }
Copy-Item (Join-Path $OutPanel "MirrorMixPanel.exe") $Staging -Force
# Also copy .dll deps if not single-file:
Get-ChildItem $OutPanel -File | Where-Object { $_.Extension -in ".dll",".json",".pdb" -or $_.Name -eq "MirrorMixPanel.exe" } | ForEach-Object {
  Copy-Item $_.FullName $Staging -Force
}

& $Iscc (Join-Path $Deploy "MirrorMix.iss")
if ($LASTEXITCODE -ne 0) { throw "ISCC failed" }

Write-Host "OK: see deploy\out\"
```

Fix PowerShell syntax carefully when implementing (`if ($Matches.m -lt 22)` not `if [int]`).

Do **not** copy `client/` source into staging if `dist/` already contains the built UI. Do copy anything `src` imports at runtime via relative path (all under `src/` is enough for tsx). Confirm `scripts/` referenced by statusline are optional and not required to boot.

- [ ] **Step 2: Run full build**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File E:\Me\AIMiss\deploy\build.ps1
```

Expected: ends with `OK: see deploy\out\` and Setup exe present.

- [ ] **Step 3: Install smoke on this machine**

1. Run Setup; if Node ok, finish install  
2. Open panel from Start Menu  
3. 启动 → browser to `http://127.0.0.1:4789` → login page or app  
4. 停止 → port free  
5. Close window → tray remains; 退出  

- [ ] **Step 4: Negative Node gate (optional)**

Temporarily rename `node` on PATH in a clean VM, or document manual test: installer shows retry/download UI.

---

### Task 6: Spec acceptance checklist

**Files:** none new (verification only)

- [ ] **Step 1: Walk the design acceptance list**

From `docs/superpowers/specs/2026-11-25-windows-installer-tray-design.md`:

1. `.gitignore` contains `deploy/`  
2. `build.ps1` produces Setup exe on a equipped machine  
3. Node missing / old → installer blocks with download + retry  
4. Good Node → install + shortcuts open panel  
5. Start → server up + browser; Stop → port released  
6. Close window → tray; Exit can stop server  

- [ ] **Step 2: Mark design doc status**

Set status line in the spec to `已确认并已实现` only after the checklist passes; otherwise leave `待用户确认` / `实现中`.

---

## Self-review

**Spec coverage:** Node gate, no bundled Node, tray, auto browser, stop own tree, localappdata install, keep `.mirrormix`, gitignore deploy, build.ps1 pipeline, README note — each mapped to tasks 1–6. Production start chose **tsx in staging** (spec option 2).

**Placeholders:** None intentionally left; Inno `AppId` GUID in the plan must be replaced with a real generated GUID when implementing (`[guid]::NewGuid()`).

**Consistency:** Panel command, port file path, staging layout, and ISS `Source: staging\*` align across tasks 3–5.
