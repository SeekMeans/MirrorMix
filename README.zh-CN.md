![MirrorMix：Claude Code、Codex 和 Cursor 的本地会话工作台](docs/readme-banner.svg)

<p align="center">
  <strong>不用重开会话，在浏览器里接着聊。</strong><br />
  一个本地工作台，继续 Claude Code、Codex 和 Cursor 的已有会话。
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue" alt="MIT 许可证" /></a>
  <img src="https://img.shields.io/badge/Platform-Windows-2563eb" alt="Windows" />
  <img src="https://img.shields.io/badge/Node.js-22%2B-287a4b" alt="Node.js 22 或更新版本" />
</p>

<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong>
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="#功能">功能</a> ·
  <a href="#通信模式">通信模式</a> ·
  <a href="#安全">安全</a>
</p>

## 简介

打开电脑上已有的会话，直接发下一条消息。MirrorMix 使用本机已安装的工具和会话记录，**不直接调用模型 API**。

## 快速开始

在装有 **Node.js 22+** 的 Windows 上，打开 PowerShell：

```powershell
git clone https://github.com/tnndworlds/MirrorMix.git
cd MirrorMix
npm install
npm start
```

`npm start` 会先构建页面，再启动服务。用浏览器打开 <http://127.0.0.1:4789>，选一个已有会话就能接着聊。

## 功能

- 浏览并继续本机上的 Claude Code、Codex 和 Cursor 会话。
- 读取 Codex JSONL 和分页 SQLite 历史，显示 Codex 桌面侧栏的项目名称；自定义分区里的项目也会平铺显示。
- 可用时通过桌面窗口发送；根据工具和通信模式，也可走 CLI 或队列等后备路径。
- 按工作区共享项目终端，支持全局快捷命令以及命令任务、定时任务和 SSH 插件。
- 在项目终端识别或配置服务启动命令，单独或批量启动、停止、重启。
- 可选：经你自己的隧道或反向代理远程访问，应用本身仍只监听本机。

## 开发

开发模式（服务端热更新）：

```powershell
npm run dev
```

改了前端后，请在项目根目录执行 `npm run build`（Vite 输出到根目录 `dist/`，由服务端提供），或再跑一次 `npm start`。

换端口：

```powershell
$env:AIMISS_PORT = "4790"
npm run dev
```

在启动它的终端里按 Ctrl+C 停止。终端已经不在时：

```powershell
$conn = Get-NetTCPConnection -LocalPort 4789 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($conn) { Stop-Process -Id $conn.OwningProcess }
```

## 通信模式

未配置时默认 `legacy`：保留原有 Codex CLI 恢复/新建，以及 Claude 输入通道、桌面跟随和 CLI 接管。Cursor 的通信方式两种模式都不变。

需要 Codex、Claude 都经桌面端收发时，启动前设置：

```powershell
$env:AIMISS_CONNECTION_MODE = "desktop"
```

或在本机写入 `%USERPROFILE%\.mirrormix\connection-mode.json`：

```json
{ "mode": "desktop" }
```

环境变量优先于文件。配置文件在仓库外，不会随 Git 提交。

`desktop` 模式下，网页通过 Windows UI Automation 操作桌面端输入框并同步本地历史。对应桌面应用需已打开并登录；按完整会话标题匹配，侧栏没有时请先在桌面端点开。

## 安全

MirrorMix **只监听 `127.0.0.1`**，不要改成 `0.0.0.0`。它能往 Claude / Codex / Cursor 发指令，也能在工作目录打开命令行——直接挂到公网等于交出这台电脑。

从手机或其它电脑访问时，在本机前面放反向代理或隧道，转发到 `127.0.0.1:4789`，并做到：

- 外面用 **HTTPS**（登录用的是 Windows 账号）
- 最好再加一道门（Tailscale、代理密码、Cloudflare Access 等）
- 不要关掉登录；Windows 账户用足够强的密码

### Tailscale（推荐自用）

```powershell
tailscale serve --bg 4789
```

同一 Tailscale 账号下，手机打开 `https://电脑名.你的tailnet名.ts.net`。

### 自建隧道

用 frp / Caddy / nginx 等把流量转到 `127.0.0.1:4789`，在服务器上终止 TLS，不要把隧道原始端口直接暴露到公网。若公网地址与浏览器访问地址不一致，启动前设置：

```powershell
$env:MIRRORMIX_ALLOWED_ORIGINS = "https://mm.example.com"
npm start
```

## 配置一览

| 项 | 位置 |
|---|---|
| 端口 | `AIMISS_PORT`（默认 `4789`） |
| 通信模式 | `AIMISS_CONNECTION_MODE` 或 `~\.mirrormix\connection-mode.json` |
| 全局快捷命令 | `~\.mirrormix\commands.json`（或 `AIMISS_COMMANDS`） |
| 外网 / 隧道 | `~\.mirrormix\`，以及可选的 `mirrormix.config.json` / `MIRRORMIX_CONFIG` |

置顶会话、额度、操作细节见应用内「帮助」。

## 许可证

[MIT](LICENSE) © tnndworlds
