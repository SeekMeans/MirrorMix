# MirrorMix

本机的会话台。打开 Claude Code、Codex、Cursor 里已有的会话，在页面里接着写。不调用模型接口，只读写这台机器上这三个工具自己的记录。

页面地址：<http://127.0.0.1:4789>

需要 Node.js 22 或更新的版本。

## 通信兼容模式（每台电脑单独配置）

未配置时默认 `legacy`，保留原有 Codex CLI 恢复、新建，以及 Claude 输入通道、桌面跟随和 CLI 恢复的逻辑。拉取代码不会替换同事原来的通信方式。Cursor 的通信方式保持原样。

需要 Codex、Claude 都通过桌面端收发时，可在启动前设置 `$env:AIMISS_CONNECTION_MODE = "desktop"`，或在本机 `%USERPROFILE%\.mirrormix\connection-mode.json` 写入：

```json
{ "mode": "desktop" }
```

环境变量优先于本机文件。配置文件在仓库外，不会随 Git 提交；改成 `legacy` 并重启即可使用原来的方式。

### 桌面端同步（Windows，desktop 模式）

Codex 和 Claude 的网页发送通过 Windows UI Automation 操作桌面端的会话输入框和发送按钮，回复从同一会话的本地记录同步回来。需要对应桌面应用已打开并登录，不需要单独登录 CLI；找不到桌面会话时会明确报错，不会自动启动 CLI。

Claude 支持英文和中文界面，默认自动查找 `%APPDATA%\Claude\claude-code-sessions` 或 `%LOCALAPPDATA%\Claude-Data`；设置 `AIMISS_CLAUDE_DATA` 可指定记录目录。Codex 使用桌面端项目、会话名称和当前历史文件信息来关联本地会话。

发送时按完整会话标题匹配；如果侧栏没有列出目标，请先在桌面端点开它。桌面输入框已有草稿时会停止发送，避免覆盖。未关联桌面端的历史记录仅供查看。桌面模式会显示“桌面端新建”，请先在 Codex 或 Claude 桌面端创建新会话，等网页列表更新后继续聊；legacy 模式仍可在网页新建。

## 置顶会话

每个 AI 工具的标签页顶部有“置顶”分组，列出在 Claude、Codex、Cursor 里置顶的会话。置顶的会话在所属项目里照常保留，项目按工具自己的顺序排列，不再整体提前。

MirrorMix 只读取各工具的置顶，不提供自己的置顶；要置顶或取消，在原来的应用里操作。额度重置倒计时显示在“置顶”标题旁。“运行中”标签只显示正在回复和回复完还没看的会话，不显示置顶。

## 项目终端

命令行面板按工作区目录共享，而不是按会话 ID：同一目录下的 Claude、Codex、Cursor 会话共用同一组终端，每个项目最多 8 个标签。路径会转换为真实目录并按 Windows 路径规则规范化；同名但不同目录、不同 worktree 各自独立。AI 自己的“会话终端”仍属于原会话。

切换会话、新开会话、收起面板、刷新网页或短暂断网不会关闭项目终端。面板会同步其他页面新增或关闭的标签；首次同时打开多个会话，只创建一个初始终端。关闭终端会停止里面运行的程序，影响该项目的所有会话，因此界面会先确认；关闭最后一个标签不会在其他页面自动重建。

共享的是同一个进程：输入、`cd`、环境变量、`Ctrl+C` 和窗口尺寸都会相互影响，多人或多个窗口操作时应先协调。执行 Git 等命令前，请确认终端提示符中的当前目录。

终端列表和最近输出保存在 MirrorMix 服务内存里。**后台服务重启（包括开发模式修改服务端触发的重启）后，不会恢复终端、进程状态或未保存的输出。** 正常关闭会释放终端；自行脱离终端运行的后台程序可能继续占用端口。要实现后台重启后仍可重新连接原来的进程，需要单独的终端守护服务，保存 JSON 无法恢复一个已经结束的 shell。

面板会显示实际权限：普通权限、管理员权限或检测失败时的权限未知。终端继承启动 MirrorMix 服务的进程权限，不取决于登录网页时填写的账户名；应用不会自动提权。以管理员权限启动 MirrorMix 会使其网页终端也拥有管理员权限。

Windows 项目终端默认使用系统自带的 ConPTY，并把服务端的 Windows 终端信息传给网页，以避免拖大、缩小窗口后光标错位、覆盖旧输出。AI 会话原有的 PTY 和通信方式不变。若需对比此前随 node-pty 附带的 ConPTY，在启动前设置 `$env:MIRRORMIX_COMMAND_CONPTY_DLL = "1"`；去掉此环境变量后重启，即恢复默认。此选项仅影响项目命令行，附带版本配合当前 xterm 5 在部分 Windows 环境下仍可能缩放错行。

## 全局快捷命令

命令行面板的“快捷命令”按分组展示，当前 Windows 用户的所有项目共用 `%USERPROFILE%\.mirrormix\commands.json`。首次打开会生成默认“git命令包”；也可用 `AIMISS_COMMANDS` 指定文件路径。命令仍在当前选中的终端目录执行，不会因为配置是全局的而切换目录。

JSON 是只包含“分组、名称、命令”的数组：

```json
[
  {
    "group": "git命令包",
    "name": "提交并推送",
    "command": "git add . && git commit -m \"{{message}}\" && git pull && git push"
  }
]
```

点击“提交并推送”后可以填写提交说明，留空使用 `new`。参数写法为 `git commit -m "{{message}}"`；执行时通过本项目的 Node 辅助脚本作为独立参数交给 Git，说明中的引号、`&`、`%` 等字符不会被当作 shell 命令。当前不调用模型自动生成说明。

界面支持添加、编辑、移除全局命令。手动编辑 JSON 后点“刷新”即可读取；同一分组内名称不能重复，多条命令用 `&&` 连接。提交失败、没有可提交改动或拉取发生冲突时，后续步骤会停止；远程分支和拉取策略沿用当前仓库的 Git 配置。

原来按项目存储在浏览器里的快捷命令仍可在“本项目旧快捷命令”分组中使用，也可以逐条“另存全局”。全局配置文件可以复制给同事使用，不会随当前仓库自动提交。项目启动和 BAT 任务不属于这套通用命令库。

## 启动

在项目目录里：

```powershell
npm install
npm start
```

`npm start` 会先构建页面，再启动服务。终端出现 `MirrorMix listening on http://127.0.0.1:4789` 后，用浏览器打开这个地址。

页面已经构建过、只改了服务端时，可以跳过构建：

```powershell
npm run dev
```

改了页面之后仍要先 `npm run build`，或直接再跑一次 `npm start`。

换端口：

```powershell
$env:AIMISS_PORT = "4790"
npm run dev
```

## 停止

在启动它的那个终端里按 Ctrl+C。服务会停止辅助进程并退出，桌面应用和其中的会话继续保留。

终端已经不在时，停掉还占着端口的进程：

```powershell
$conn = Get-NetTCPConnection -LocalPort 4789 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($conn) { Stop-Process -Id $conn.OwningProcess }
```

端口改过的话，把 `4789` 换成当时的端口。

## 从外网访问

MirrorMix 只监听本机地址 `127.0.0.1`，不要改成 `0.0.0.0`。它能往 Claude Code 里发指令，也能在工作目录里打开 `cmd.exe`，放到网上等于交出这台电脑的控制权。要在手机或别的电脑上用，就在本机前面放一个反向代理或隧道，由它转发到 `127.0.0.1:4789`。

无论用哪种方式，都要做到：

- 外面用 HTTPS 访问。登录用的是 Windows 账号密码，明文 HTTP 会被截获。
- 最好在登录页前面再加一道门：Tailscale 本身、代理的密码，或 Cloudflare Access。不加的话，Windows 账户必须用足够强的密码。
- 不要关掉登录。

### 多台电脑共用一台服务器：设置里一键开启

适合有自己的域名和一台云服务器的情况。服务器只配一次，以后每台电脑在 MirrorMix 的“设置 → 外网访问”里填好信息、打开开关，就得到自己的地址，例如 `https://office.mm.seekmeans.cn`。外网域名固定为 `mm.seekmeans.cn`，访问端口固定为 HTTPS 默认的 443，都不用填。

```
手机 ──HTTPS──> office.mm.seekmeans.cn ─┐
                home.mm.seekmeans.cn  ──┤
                                      ▼
               云服务器：nginx（HTTPS 证书）─> frps（按子域名分给各台电脑）
                                                  ▲            ▲
                                       frp 隧道（TLS + 口令）
                                                  │            │
                                       电脑 A：MirrorMix   电脑 B：MirrorMix
```

服务器端用到的文件都在 [deploy](deploy) 目录里，里面已经写好了 `mm.seekmeans.cn`。下面的命令以 Ubuntu 为例，用 root 执行；Alibaba Cloud Linux / CentOS 把 `apt` 换成 `dnf`。

nginx 不加网页密码，打开地址直接进 MirrorMix 的登录页，用这台电脑的 Windows 账户登录。所以：

- 每台电脑的 Windows 账户都要有足够强的密码，不要用空密码或简单密码。
- 登录有两层限速：nginx 按来源 IP 每分钟最多 10 次，MirrorMix 自己一分钟内错 8 次就暂停登录。
- 地址里的子域名不要用容易猜的名字，可以少被扫描。

#### 一、阿里云（只做一次）

1. **泛解析**：在 `seekmeans.cn` 的云解析 DNS 里加一条记录，主机记录 `*.mm`，类型 `A`，记录值是云服务器的公网 IP。以后加电脑不用再动 DNS。
2. **RAM 子账号**：RAM 访问控制里创建用户，访问方式勾“使用永久 AccessKey 访问”（旧版叫“OpenAPI 调用访问”），只授予 `AliyunDNSFullAccess` 权限。acme.sh 用它申请泛域名证书，不要用主账号的密钥。
3. **安全组**：入方向放行 `443`（nginx）和 `5000`（frps）。`80` 和 `8080` 都不用放行。

服务器在中国大陆时，域名的 ICP 备案要接入阿里云，否则 443 端口打不开。

#### 二、云服务器（只做一次）

1. **frps**：从 frp 的 GitHub 发布页下载 Linux 版，把 `frps` 放到 `/usr/local/bin/`。把 [deploy/frps.toml](deploy/frps.toml) 放到 `/etc/frp/frps.toml`，把 `webServer.password` 换成一串随机字符串（例如 `openssl rand -hex 32` 的输出），再 `chmod 600 /etc/frp/frps.toml`。每台电脑的连接口令由同一台服务器上的 DNSMgr 发放和核对（frps 通过 `httpPlugins` 问它），先按 MirrorMixIng 仓库里的 `docs/mirrormix-deploy.md` 把 DNSMgr 跑起来。把 [deploy/frps.service](deploy/frps.service) 放到 `/etc/systemd/system/`，然后：

   ```bash
   systemctl daemon-reload
   systemctl enable --now frps
   ss -lntp | grep frps
   ```

   应该看到 `0.0.0.0:5000` 和 `127.0.0.1:8080`。

2. **nginx**：

   ```bash
   apt install -y nginx
   ```

3. **acme.sh 签泛域名证书**：国内服务器从 Gitee 安装更快：

   ```bash
   git clone https://gitee.com/neilpang/acme.sh.git /opt/acme.sh-src
   cd /opt/acme.sh-src && ./acme.sh --install -m 你的邮箱
   source ~/.bashrc
   acme.sh --set-default-ca --server letsencrypt
   ```

   用 RAM 子账号的密钥签证书：

   ```bash
   export Ali_Key="子账号的AccessKeyId"
   export Ali_Secret="子账号的AccessKeySecret"
   acme.sh --issue --dns dns_ali -d '*.mm.seekmeans.cn'
   ```

   一两分钟后出现 `Cert success` 就签好了。密钥会被记到 `~/.acme.sh/account.conf`，以后续期自动使用，之后可以 `unset Ali_Key Ali_Secret`。

   把证书装到 nginx 用的位置，并设好续期后重载 nginx：

   ```bash
   mkdir -p /etc/nginx/ssl/mm.seekmeans.cn
   acme.sh --install-cert -d '*.mm.seekmeans.cn' \
     --key-file /etc/nginx/ssl/mm.seekmeans.cn/key.pem \
     --fullchain-file /etc/nginx/ssl/mm.seekmeans.cn/fullchain.pem \
     --reloadcmd "systemctl reload nginx"
   ```

   acme.sh 安装时已经加了每天检查的定时任务（`crontab -l` 能看到），证书到期前会自动续期。

4. **nginx 配置**：把 [deploy/nginx.conf](deploy/nginx.conf) 放到 `/etc/nginx/conf.d/mirrormix.conf`，然后：

   ```bash
   nginx -t
   systemctl enable nginx
   systemctl reload nginx
   ```

   `nginx -t` 报 `duplicate default server` 时，说明已有别的站点占了 443 的默认站点，删掉 `mirrormix.conf` 末尾那段 `default_server`。

5. **验证**（在自己电脑上执行）：

   | 命令 | 应该看到 |
   |---|---|
   | `nslookup test.mm.seekmeans.cn` | 服务器的公网 IP |
   | `curl https://test.mm.seekmeans.cn` | 证书正常，返回 frps 的“页面不存在”提示，因为还没有电脑叫 `test` |
   | `curl -m 5 http://服务器IP:8080` | 超时或拒绝连接 |

#### 三、每台电脑

1. MirrorMix 已内置与服务器同版本的 `frpc.exe`，开启外网访问时会自动运行，不需要下载或配置路径。
2. 打开 MirrorMix，进入“设置 → 通用设置 → 外网访问”，打开开关，填写：

   | 项 | 填什么 |
   |---|---|
   | 连接口令 | MirrorMix 小程序里开通地址后显示的连接口令。右边的眼睛可以显示已保存的口令 |
   | 子域名 | 小程序里开通的那个标识。地址就是 `子域名.mm.seekmeans.cn`，填别的子域名会被服务器拒绝 |

   服务器地址、frps 端口和外网域名不在页面上填，写在项目根目录的 [mirrormix.config.json](mirrormix.config.json) 里，默认是 `seekmeans.cn`、`5000` 和 `mm.seekmeans.cn`：

   ```json
   {
     "remote": {
       "server": "seekmeans.cn",
       "serverPort": 5000,
       "domain": "mm.seekmeans.cn"
     }
   }
   ```

   改完要重启 MirrorMix。文件不在项目根目录时，用环境变量 `MIRRORMIX_CONFIG` 指定它的路径。

3. 点“保存并重新连接”。状态变成“已连接”后，用页面上显示的地址访问，用这台电脑的 Windows 账户登录。

几点说明：

- 连接口令用 Windows DPAPI 加密保存在 `%USERPROFILE%\.mirrormix\remote.json`，只有当前 Windows 账户能解开。frpc 启动时会临时生成一份带口令的配置文件，frpc 一读完就删除。
- frpc 由 MirrorMix 启动，断线自动重连。MirrorMix 退出时 frpc 一起停止，所以只有 MirrorMix 运行着才能从外网访问。
- 这台电脑的外网地址会自动被认作 MirrorMix 自己的页面，不需要设置 `MIRRORMIX_ALLOWED_ORIGINS`。
- 每个地址有自己的连接口令，只能注册自己的子域名和 `子域名-preview`。地址被收回或口令被重置后，正在用它的电脑会被断开。

#### 日常维护

| 要做的事 | 怎么做 |
|---|---|
| 看状态 | `systemctl status frps nginx` |
| 看日志 | `journalctl -u frps -f`、`tail -f /var/log/nginx/error.log` |
| 重启 frps | 把 [deploy/restart-frps.sh](deploy/restart-frps.sh) 传到服务器，`sudo bash restart-frps.sh`。它先检查配置，配置有错就不重启；重启后确认 5000 对外、8080 只在本机监听，并打印最近的日志 |
| 换连接口令 | 在 DNSMgr 的“访问申请”里点“重置口令”，用户在小程序里看到新口令后填到设置里 |
| 看证书 | `acme.sh --list` |
| 手动续期 | `acme.sh --renew -d '*.mm.seekmeans.cn' --force` |

#### 连不上时

| 状态里的提示 | 处理 |
|---|---|
| 连不上服务器 | 检查 mirrormix.config.json 里的服务器地址和端口，安全组是否放行了这个端口，frps 是否在运行（`systemctl status frps`） |
| 服务器拒绝了连接口令 | 子域名或口令和小程序里显示的不一致，或者地址已被收回 |
| 子域名没有分配给你的连接口令 | 子域名要填小程序里开通的那个 |
| 子域名已经被另一台电脑占用 | 换一个子域名 |
| 服务器没有开启子域名转发 | 检查 frps.toml 里的 `subDomainHost` 和 `vhostHTTPPort` |
| MirrorMix 自带的 frpc.exe 不存在 | 重新安装 MirrorMix |
| 已连接，但浏览器打不开 | 检查 DNS 泛解析、安全组的 443、`nginx -t`、`/var/log/nginx/error.log` |
| 浏览器显示 502 | nginx 连不上 frps：`systemctl status frps`，确认在监听 `127.0.0.1:8080` |
| 页面能打开，但消息不实时更新 | nginx 配置里的 WebSocket 那几行（`Upgrade`、`Connection`）是否完整 |

### 只给自己用：Tailscale（推荐）

电脑和手机都装 Tailscale，登录同一个账号。公网上没有入口，也不用改 MirrorMix。在电脑上运行：

```powershell
tailscale serve --bg 4789
```

手机打开 `https://电脑名.你的tailnet名.ts.net`。

### 要一个公网地址：自己的云服务器 + frp + Caddy

```
手机 ──HTTPS──> 云服务器（Caddy：证书 + 密码） ──frp 隧道──> 本机 127.0.0.1:4789
```

本机的 `frpc.toml`：

```toml
serverAddr = "你的服务器公网IP"
serverPort = 7000
auth.token = "一串足够长的随机字符串"

[[proxies]]
name = "mirrormix"
type = "tcp"
localIP = "127.0.0.1"
localPort = 4789
remotePort = 14789
```

服务器的 `frps.toml` 里写上 `proxyBindAddr = "127.0.0.1"`，让 14789 只对服务器本机开放，不直接暴露到公网。

服务器的 `Caddyfile`，由 Caddy 签证书并加一层密码（哈希用 `caddy hash-password` 生成）：

```
mm.你的域名.com {
  basic_auth {
    你的用户名 <caddy hash-password 生成的哈希>
  }
  reverse_proxy 127.0.0.1:14789
}
```

国内服务器使用 80、443 端口要求域名已经 ICP 备案。没备案的话，用香港等境外服务器，或换一个非标准端口。

### 不想要服务器：Cloudflare Tunnel + Cloudflare Access

本机运行 `cloudflared` 把 `http://127.0.0.1:4789` 发布出去，不用开端口。再在 Cloudflare Access 里只允许你自己的邮箱登录。需要一个托管在 Cloudflare 的域名，国内访问速度不稳定。

不建议用 cpolar、花生壳、natapp 这类免费穿透：流量经过第三方，地址也容易被扫到。

### 代理需要的设置

MirrorMix 会做两件事，经过代理时请确认：

- **登录 cookie**：浏览器经 HTTPS 访问时，cookie 会标记为 `Secure`。MirrorMix 从代理的 `X-Forwarded-Proto: https` 或页面本身的 `https://` 地址判断这一点，代理不用额外设置。
- **请求来源**：登录、发送消息、改设置等操作，以及实时推送和命令行的连接，只接受来自 MirrorMix 自己页面的请求。判断依据是浏览器访问的地址，代理要原样转发 `Host`，或通过 `X-Forwarded-Host` 告知。

上面几种代理默认都满足，一般不用做什么。如果代理改写了地址，登录时会看到“这个地址没有被允许登录”。这时在启动前把公网地址写进 `MIRRORMIX_ALLOWED_ORIGINS`，多个用逗号分隔：

```powershell
$env:MIRRORMIX_ALLOWED_ORIGINS = "https://mm.你的域名.com"
npm start
```
