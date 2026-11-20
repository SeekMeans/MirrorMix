# 工作区桥接设计

日期：2026-11-11

本机网页统一查看 Claude Code 与 Codex 的工作区和会话。网页不调用模型接口。消息写进本工具拉起的真实交互进程，回复从该工具自己的会话文件读回。

## 运行边界

- 服务只监听 `127.0.0.1`，默认端口 `4789`。
- 网页不另做登录。
- 官方会话文件只读。本工具不改写、不删除这些文件。
- 工作区只来自已经有会话记录的文件夹。不能从网页添加新文件夹。
- 可以在已有工作区里新建一条该工具的会话。
- 别处已经开着的同一条会话标为占用，网页不能打开，也不能发消息。
- 可以同时跑多条。每条一个进程。切换页面不结束其他进程。
- 顶层两个 Tab：Claude Code、Codex。Tab 内按工作区分组，组内是会话。
- 消息流显示用户正文、AI 正文、工具调用步骤，以及每一轮的用时和输出 tokens。命令输出和批准留在同一页底部的终端。
- 终端默认收起。发送不可用且进程仍在跑时，终端保持展开。
- 输入法上屏后的整句文字才会写入进程，并在末尾补一个回车。

## 架构

四个单元：

1. **目录。** 扫描会话文件，得到按工具和工作区分组的列表。
2. **进程。** 为每条打开的会话拉起一个伪终端，记录本工具拥有的 pid。
3. **记录。** 从会话文件抽出用户正文和 AI 正文，并判断这一轮在文件里是否已经结束。
4. **画面。** 用终端模拟器吃进进程输出。画面上出现编号选项时，禁止把消息写入进程。

浏览器通过 HTTP 取目录、记录和状态，通过 WebSocket 连接当前这条会话的终端字节。

## 会话文件

Claude Code 根目录默认是 `%USERPROFILE%\.claude\projects`。每个子目录是一个项目，里面每个 `.jsonl` 是一条会话。工作区取记录里的 `cwd`。没有任何 `cwd` 的文件不进入列表。项目目录名用于定位新建会话，编码规则是：绝对路径里的 `:` 换成 `-`，`\` 和 `/` 换成 `-`。`D:\AutoWork` 对应 `D--AutoWork`。

Claude 记录：

- 顶层 `type` 为 `user`，且 `message.role` 为 `user`：`content` 是字符串时，整段算作用户正文。`content` 是数组时，只取 `type` 为 `text` 的 `text`。只含 `tool_result` 的记录跳过。图片块跳过。
- 顶层 `type` 为 `assistant`：`content` 里 `type` 为 `text` 的文字是 AI 正文；每个 `tool_use` 记一个步骤，显示工具名和一行入参摘要（MCP 工具去掉服务前缀）。`thinking` 跳过。旁支记录（`isSidechain`）不出步骤。
- 标题用最后一条 `custom-title` 的 `customTitle`。没有时用第一条用户正文的前 42 个字符。再没有时用会话 id。
- 会话 id 用文件名去掉 `.jsonl`。
- 损坏的一行跳过，不影响同文件的其他行。

Codex 根目录默认是 `%USERPROFILE%\.codex\sessions`，递归读取 `.jsonl`。

- `session_meta.payload.id` 是会话 id，`session_meta.payload.cwd` 是工作区。同一文件有多条 meta 时用第一条。
- 用户正文来自 `event_msg`，且 `payload.type` 为 `user_message` 的 `payload.message`。
- AI 正文来自 `event_msg`，且 `payload.type` 为 `agent_message`、`payload.phase` 为 `final_answer` 的 `payload.message`。`commentary` 和 `response_item` 里的 `function_call`、`custom_tool_call`、`local_shell_call`、`web_search_call` 记为步骤，推理记录不进消息流。
- 标题用第一条用户正文的前 42 个字符，否则用会话 id。
- 空字符串跳过。损坏的一行跳过。

连续的同角色正文各自保留为一条，按文件顺序排列。

## 每轮用时与 tokens

- Claude：一轮从不带 `tool_result` 的人类用户正文开始（工具结果里夹带的插话不另起一轮），到下一轮开始前最后一条 `user` / `assistant` 记录的 `timestamp` 结束。tokens 是这一轮各条 `assistant` 记录 `message.usage.output_tokens` 之和；同一个 `message.id` 拆成多条记录、重复带 usage 时只算一次。
- Codex：一轮从 `task_started` 到 `task_complete` 或 `turn_aborted`，取两者的 `timestamp`。tokens 是这期间 `token_count` 里 `total_token_usage.output_tokens` 的增量；累计值变小（压缩后重计）时从新值接着算。
- 结束的一轮在消息流里记一条 `turn`，带 `startedAt`、`endedAt`、`tokens`。还在跑的一轮没有 `endedAt`，始终排在最后。网页刚发出、记录里还没出现的那一轮，用发送时刻起表。

## Claude Code 记录的呈现

消息流照 Claude Code 终端的样子画：

- 用户正文前面是 `>`，AI 正文前面是 `●`。
- 每个工具调用一行 `● 工具名(参数)`，名字和终端一致：Edit 写成 Update，Grep / Glob 写成 Search，MCP 工具写成 `服务 - 工具 (MCP)`；路径在会话目录里的显示相对路径。点一下这一行可以看完整参数。
- 结果画在 `⎿` 下面，取自 tool_result 和旁边的 `toolUseResult`：命令输出前 3 行，其余折成「… +N lines」；Read 写「Read N lines」；Edit / Write 写增删行数并画带行号的差异；Glob / Grep 写找到几个；子任务写工具次数、tokens 和用时；计划工具（TodoWrite、桌面端的 update_plan）画成清单，update_plan 的 advance / done / start 按上一次的清单推算。输出里的终端颜色码去掉。每个结果最多保留 40 行、差异最多 200 行。
- 圆点颜色表示状态：执行中灰色闪烁，成功绿色，失败或中断红色。结果还没回来的调用显示「Running…」；一轮结束时仍没有结果的标为 Interrupted。
- 有内容的思考块显示为折起的「✻ Thinking…」。
- 进行中的一轮显示终端那样的转动符号和动词，加「(计时 · ↓ tokens)」；结束后显示「✻ Worked for 用时 · ↓ tokens」。
- 待办 / 计划画成带边框的卡片，标题旁是完成数。Bash / PowerShell / Ran 默认只显示命令那一行，点一下展开输出。

## Codex 记录的呈现

照 Codex 终端的样子画，标记换成 Codex 的：用户正文前是 `›`，AI 正文（含 commentary）前是 `•`，结果在 `└` 下面，清单用 ✔ / □。

- `exec` 脚本里调用的 `tools.xxx(...)` 按第一个调用命名：shell_command 是 `• Ran 命令`（多条用 && 连起来），update_plan 是 `• Updated Plan` 加清单，MCP 工具是 `• Called 服务.工具(标题或参数)`。含 apply_patch 的脚本和 `wait` 不单独成行。
- 输出取 `function_call_output` / `custom_tool_call_output`，按其中最后一个「Exit code: N」判断成败，正文取最后一个「Output:」之后的部分；非 0 时摘要写 Exit code。
- `patch_apply_end` 每个文件一行：`• Edited / Added / Deleted 路径 (+a -r)`，下面画 unified_diff 解析出的差异。
- `agent_reasoning` 去掉 `**` 后作为斜体行直接显示；`web_search_end` 记为 `• Searched 查询`。
- 进行中显示「• Working (计时 · ↓ tokens)」；结束后是一条横线「─ Worked for 用时 · ↓ tokens ───」。任务中止时还没有输出的调用标为 Interrupted，正常结束的视为完成。

## 空闲与发送

发送同时满足下面三条才执行：

1. 这条会话的进程是本工具拉起的，并且还活着。
2. 记录显示上一轮已经结束。
3. 终端画面没有编号选项。

Codex 的一轮从 `task_started` 开始，到其后的 `task_complete` 或 `turn_aborted` 结束。最新的开始没有对应的结束时，这一轮未结束。还没有任何 `task_started` 时，视为已结束。

Claude 的一轮从一条含有用户正文的 `user` 记录开始。其后已经出现含文本块的 `assistant` 记录，且文件中最后一条 `user` 或 `assistant` 记录不是“只有工具块”时，这一轮结束。只有工具块指：`assistant` 的内容里有 `tool_use` 且没有 `text`，或 `user` 的内容里每个块都是 `tool_result`。最后一条仍是人类用户正文或只有工具块时，未结束。还没有人类用户正文时，视为已结束。

画面规则：可见行里只要有一行匹配 `^\s*(?:[❯>]\s*)?\d+\.\s+\S`，就视为编号选项，禁止发送。助手正文里的编号列表如果还留在可见区域，同样禁止发送。判断不准时按禁止发送处理。

禁止发送时，服务返回 HTTP 409，错误码 `not_idle`。浏览器保留输入框里的文字，并展开终端。

文字最长 100000 个字符。空白文字返回 400。

## 进程

继续已有会话：

- Claude：`<claude.exe> --resume <id>`，工作目录是该会话的 cwd。
- Codex：`<node> <codex.js> resume <id>`，工作目录同样是该会话的 cwd。

新建：

- Claude：`<claude.exe>`，无 resume 参数。
- Codex：`<node> <codex.js>`，无 resume 参数。

可执行文件从 `where.exe claude` 和 `where.exe codex` 解析。若落点是 `.ps1` 或 `.cmd`，Claude 使用同级 `node_modules\@anthropic-ai\claude-code\bin\claude.exe`，Codex 使用同级 `node_modules\@openai\codex\bin\codex.js` 并用当前 Node 运行。找不到可执行文件时，这条会话标为启动失败，不改会话文件。

新建后每 500 毫秒找一次新文件，最多 20 秒。Claude 在对应项目目录里找启动之后出现的 `.jsonl`。Codex 在 sessions 下找启动之后出现、且 meta 的 cwd 与目标工作区一致的文件。命令行里能看到会话 id 时只绑定那一个；否则绑定最新的一个。超时则结束进程，状态为创建失败。

占用：进程命令行包含该会话 id，且 pid 不是本工具拉起的进程，也不是它的子进程。占用期间打开请求返回 409，错误码 `occupied`。

工作区目录不存在时，该组仍显示，打开和新建都停用。

关闭只结束本工具拉起的进程。会话文件保留，之后可以再打开。

切换会话只改变网页当前显示的记录和终端。其他进程继续运行。

## HTTP 与终端流

- `GET /api/catalog`：`{ claude: WorkspaceGroup[], codex: WorkspaceGroup[] }`。组按最近一条会话的更新时间倒序，组内会话同样倒序。
- `GET /api/sessions/:tool/:id`：`{ id, tool, title, workspacePath, status, sendEnabled, messages }`。`status` 取 `idle`、`starting`、`running`、`occupied`、`exited`、`failed`、`create_failed` 之一。目录正在创建时用 `starting`。
- `POST /api/sessions/open`，正文 `{ tool, id }`。成功返回 `{ id, status: "running" }`。
- `POST /api/sessions/create`，正文 `{ tool, workspacePath }`。请求保持到绑定完成或超时。成功返回 `{ id, status: "running" }`。未知工作区返回 404，错误码 `unknown_workspace`。超时返回 504，错误码 `create_failed`。
- `POST /api/sessions/close`，正文 `{ tool, id }`。成功返回 `{ id, status: "exited" }`。
- `POST /api/sessions/send`，正文 `{ tool, id, text }`。成功返回 `{ ok: true }`。
- `GET /api/health`：`{ ok: true }`。

错误正文一律是 `{ error: "<code>" }`。

WebSocket 路径 `/api/terminal?tool=&id=`。服务把该进程的输出按文本帧推给浏览器。浏览器把按键作为文本帧发回，把 `{ "type": "resize", "cols", "rows" }` 发来调整尺寸。默认 100 列、28 行。

目录和记录按文件路径、大小和 mtime 缓存。文件没变时不重新解析。

环境变量 `AIMISS_CLAUDE_ROOT`、`AIMISS_CODEX_ROOT`、`AIMISS_PORT` 可替换默认位置和端口，供测试使用。

## 页面

左侧是当前 Tab 的工作区。工作区路径是组标题，下面是会话。当前会话用信号色标出。占用、启动失败、创建失败、目录不在、运行中这些状态写在会话行上。每个工作区有「新建会话」。

中间是当前会话的标题、消息和输入框。用户消息靠右，AI 正文靠左。没有打开会话时，中间说明先从左侧打开一条。输入框在 `sendEnabled` 为假时停用。发送按钮的文字是「发送」。

底部是终端。收起时是一行「终端」。展开时占住下半区，接上这条会话的真实画面。按键只发给当前会话。

两个 Tab 的运行进程互不影响。刷新页面后，服务仍持有进程；页面重新拉目录并可以再连上终端。

视觉：浅冷灰蓝底，深色终端槽是页面上唯一的重色块。会话标题用 Palatino Linotype，其余用 Segoe UI。信号色是 `#0b6e6a`。文字左对齐。状态用短词，不用全大写标签。

## 错误

| 情况 | 结果 |
| --- | --- |
| 可执行文件不存在或进程立即退出 | 状态为启动失败，输入停用 |
| 占用 | 409 `occupied`，列表显示占用 |
| 进程中途退出 | 已收回的消息保留，状态为已退出，可以再打开 |
| 不空闲时发送 | 409 `not_idle`，输入框文字保留，终端展开 |
| 新建超时 | 结束进程，状态为创建失败 |
| 会话文件某行损坏 | 跳过该行 |
| 工作区目录不存在 | 组仍在，打开和新建停用 |
| 发送超过 100000 字符或空白 | 400 |

## 验证

自动测试覆盖：Claude 与 Codex 的正文提取、工具记录被排除、损坏行被跳过、两种空闲判断、编号选项禁止发送、目录分组和排序、占用判断排除自己的 pid、启动参数、新建绑定、发送在不空闲时被拒绝且不写入进程。

本机再检查：服务只绑在 `127.0.0.1:4789`，`/api/catalog` 能读到本机已有工作区。不在自动测试里向真实会话发送消息。
