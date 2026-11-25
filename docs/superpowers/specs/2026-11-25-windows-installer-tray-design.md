# MirrorMix Windows 安装包与托盘面板

日期：2026-11-25  
状态：待用户确认  

## 目标

为开源分发提供 Windows 安装体验：

- 生成 `MirrorMix-Setup-*.exe`，**不捆绑 Node.js**
- 安装时检测本机 Node，要求 **主版本 ≥ 22**；不满足则提示、打开官网、可重试
- 安装后提供带**系统托盘**的控制面板：启停 MirrorMix，点启动后自动打开浏览器
- 打包脚本与产物放在 `deploy/`，且整个 `deploy/` 目录加入 `.gitignore`（不提交）

非目标：macOS/Linux 安装包；把 Claude/Codex/Cursor 打进安装包；单文件自包含 exe（因 `node-pty` 等原生依赖）。

## 方案

采用 **Inno Setup 安装包 + C# WinForms 托盘程序（MirrorMixPanel.exe）**。

开发机流水线（`deploy/build.ps1`）：

1. 在仓库根目录安装依赖并 `npm run build`
2. 将运行所需文件复制到 staging（排除 `.git`、`tests`、`docs`、开发配置等）
3. 在 staging 执行 `npm install --omit=dev`
4. 编译托盘程序得到 `MirrorMixPanel.exe`
5. 调用 Inno Setup 编译脚本，输出安装包到 `deploy/out/`

## 仓库与忽略规则

- `.gitignore` 增加 `deploy/`
- 现有 `deploy/frps.toml`、`nginx.conf` 等一并不再跟踪
- 开源 README 用一两句说明：Windows 安装包由维护者在本地用 `deploy` 脚本生成，不在仓库内

## 安装包行为

### Node 检测

- 调用 `node -v`，解析主版本号
- 找不到 Node，或主版本 &lt; 22：
  - 说明需要 Node.js 22+
  - **打开下载页** → `https://nodejs.org/`
  - **重试** → 再次检测（若刚装完 Node，可能需重新运行安装程序以便刷新 PATH）
  - **取消** → 退出安装
- 检测通过后才继续复制文件与创建快捷方式

### 安装布局（建议）

默认目录：`%LOCALAPPDATA%\MirrorMix\`（不强制管理员）

大致内容：

- 应用文件（生产依赖、`dist/`、服务入口等）
- `MirrorMixPanel.exe`
- 可选：本地已有的 `frpc.exe`（有则带上，无则跳过）

开始菜单（及可选桌面）快捷方式指向面板，而不是直接起 Node。

### 卸载

- 若 MirrorMix 由面板拉起仍在运行：先尝试停止再删文件
- 删除安装目录与快捷方式
- 不删除 `%USERPROFILE%\.mirrormix\` 用户配置（登录会话、SSH、快捷命令等）

## 生产启动方式

安装后的服务必须能用系统 `node` 稳定启动，不依赖开发机的 `tsx watch`。

实现时二选一（优先更简单、可维护的一种，在实现计划里敲定）：

1. **构建期把服务端编成可 `node` 直接执行的 JS**（例如 esbuild/tsc 产出），面板执行  
   `node <install>\server\main.js`（或等价入口），并设置 `AIMISS_PORT` 等环境变量  
2. **随包带上 `tsx`（仍属 npm 依赖，不是系统 Node）**，面板执行  
   `node node_modules/tsx/...` 或 `npx tsx` 等价命令跑 `src/server/main.ts`

约束：工作目录为安装根目录；只监听 `127.0.0.1`；默认端口 `4789`。

## 托盘面板（MirrorMixPanel）

### UI / 托盘

- 小窗口：状态文案、端口、启动 / 停止 / 打开网页
- 关闭窗口 → 隐藏到托盘，**不**退出、**不**默认停服务
- 托盘菜单：显示窗口、启动、停止、打开网页、退出
- 退出时若服务在跑：确认是否一并停止

### 启停

- **启动前**再测一次 Node ≥ 22；失败则提示并提供打开官网（与安装逻辑一致）
- 启动：创建进程树运行 MirrorMix；轮询 `http://127.0.0.1:<port>/`（或 TCP 连通）至就绪或超时
- 就绪后用默认浏览器打开该地址（同一轮启动只自动打开一次；之后用「打开网页」）
- **停止**：只终止本面板启动的进程树，避免误杀其它占用同名命令、其它端口上的开发实例
- 端口可在面板修改，写入 `%USERPROFILE%\.mirrormix\panel.json`（或同目录配置），启动时注入 `AIMISS_PORT`

### 状态

- 已停止 / 启动中 / 运行中 / 启动失败（展示简短原因）
- 「运行中」以本机端口可访问为准，兼看子进程是否仍在

## 打包机依赖

- Node.js 22+、npm
- Inno Setup 6（`ISCC.exe` 在 PATH 或由脚本配置路径）
- .NET SDK（足以 `dotnet publish` 出 win-x64 托盘 exe；优先单文件、框架依赖或自包含在实现时按体积权衡）

`deploy/build.ps1` 在缺工具时打印明确安装说明并失败退出。

## staging 包含与排除（初稿）

包含：`package.json`、`package-lock.json`（若有）、`client` 构建结果 `dist/`、服务运行所需 `src/` 或编译输出、`vite` 相关若运行时需要则带上、可选 `frpc.exe`、`mirrormix.config.json` 示例（无密钥）

排除：`.git`、`node_modules`（在 staging 重装）、`tests`、`docs`、`.superpowers`、开发专用脚本、用户本机密钥与 `%USERPROFILE%\.mirrormix`

最终清单在实现计划中按「最小可运行」收紧。

## 风险与注意

- 用户安装 Node 后未重启安装向导时 PATH 可能仍旧 → 文案说明「重试或重新打开安装程序」
- `node-pty` 必须与用户机器上的 Node 主版本匹配；应用 `node_modules` 应在 **Node 22** 环境下产出
- 面板不得把服务绑到 `0.0.0.0`
- `deploy/` 忽略后，协作者拿不到打包脚本；可接受（按产品要求本地维护）

## 验收标准

1. `.gitignore` 含 `deploy/`，git 不再跟踪该目录  
2. 在满足前提的开发机上跑 `deploy/build.ps1` 能产出 Setup exe  
3. 无 Node 或 Node &lt; 22 时安装被拦住，可打开官网并重试  
4. Node 合格时可完成安装，快捷方式打开托盘面板  
5. 点启动后服务起来并自动打开浏览器；停止后端口释放  
6. 关面板窗口后托盘仍在，服务按设计保持；托盘退出可停服务  

## 实现顺序（确认设计后）

1. `.gitignore` + 托盘项目骨架 + 启停/开浏览器  
2. Inno 脚本（含 Node 检测 UI）  
3. `build.ps1` 串联 staging 与出包  
4. 本机试装一遍对照验收标准  
