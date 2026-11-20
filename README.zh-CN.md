# MirrorMix

[English](README.md)

本机的会话台。打开 Claude Code、Codex、Cursor 里已有的会话，在浏览器里接着写。MirrorMix **不调用模型接口**，只读写这三个工具在本机上的记录，并在需要时操作桌面端窗口。

默认地址：<http://127.0.0.1:4789>

需要 **Node.js 22+**（使用 `node:sqlite`）。

## 功能

- 浏览并继续本机上的 Claude Code、Codex、Cursor 会话
- 尽量通过桌面窗口发送；锁屏或窗口无法输入时走 CLI / 队列等后备路径
- 按工作区共享的项目终端、全局快捷命令、插件（命令任务、定时任务、SSH）
- 可选：经你自己的隧道或反向代理做外网访问（应用本身仍只监听本机）

## 快速开始

```powershell
npm install
npm start
```

`npm start` 会先构建页面，再启动服务。终端出现 `MirrorMix listening on http://127.0.0.1:4789` 后，用浏览器打开该地址。

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
