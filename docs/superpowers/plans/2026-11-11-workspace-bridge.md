# 工作区桥接实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 做一个只监听本机的网页，按工作区管理 Claude Code 和 Codex 的会话，并把消息透传到本工具拉起的真实交互进程。

**Architecture:** TypeScript 服务扫描官方会话文件、用伪终端拉起 CLI，并用终端模拟器判断能否发送。浏览器分成两个工具 Tab、按工作区分组的会话列表、消息流和底部终端。

**Tech Stack:** Node.js、TypeScript、Vitest、node-pty、ws、`@xterm/headless`、Vite、React、`@xterm/xterm`。

## Global Constraints

- 服务只监听 `127.0.0.1`，默认端口 `4789`。
- 不调用模型接口，不改写、不删除官方会话文件。
- 工作区只来自已有会话。可在已有工作区新建会话。
- 别处已打开的同一会话标为占用，不能从网页打开或发送。
- 可同时运行多条会话，每条一个进程。
- 消息流只有用户正文和 AI 正文。
- 发送必须同时满足：本工具的进程仍在、记录中的一轮已结束、画面没有编号选项。
- 不空闲时返回 409 `not_idle`，输入框文字保留，终端展开。
- 文字最长 100000 字符。
- 新建最多等 20 秒，每 500 毫秒找一次新会话文件。
- Claude 项目目录编码：绝对路径中 `:`、`\`、`/` 都换成 `-`。
- Codex 只把 `phase === "final_answer"` 的 `agent_message` 当作 AI 正文。
- 环境变量 `AIMISS_CLAUDE_ROOT`、`AIMISS_CODEX_ROOT`、`AIMISS_PORT` 覆盖默认位置和端口。

任务是顺序依赖的，在当前会话里按 executing-plans 连续实现，不在任务之间停下来问。

### Task 1: 记录解析、空闲判断、目录、占用、启动参数

**Files:**
- Create: `src/shared/types.ts`
- Create: `src/transcript/claude.ts`
- Create: `src/transcript/codex.ts`
- Create: `src/transcript/idle.ts`
- Create: `src/transcript/screen.ts`
- Create: `src/catalog/readCatalog.ts`
- Create: `src/process/occupancy.ts`
- Create: `src/process/launch.ts`
- Test: `tests/transcript.test.ts`
- Test: `tests/catalog.test.ts`
- Test: `tests/process.test.ts`

**Interfaces:**
- Produces: `parseClaudeJsonl(fileName, content, updatedAt) -> ParsedSession | null`
- Produces: `parseCodexJsonl(content, updatedAt) -> ParsedSession | null`
- Produces: `screenAllowsInput(lines: string[]) -> boolean`
- Produces: `readCatalog(roots) -> { claude: WorkspaceGroup[]; codex: WorkspaceGroup[] }`
- Produces: `isOccupied(sessionId, processes, ownedPids) -> boolean`
- Produces: `launchSpec(tool, cwd, bins, sessionId?) -> { file, args, cwd }`
- Produces: `encodeClaudeProject(cwd) -> string`
- Produces: `resolveBins(where, nodeExe) -> ToolBins`

- [ ] **Step 1: Write failing tests for the behaviors in the spec**
- [ ] **Step 2: Run `npx vitest run` and confirm failures are missing modules**
- [ ] **Step 3: Implement the pure modules**
- [ ] **Step 4: Re-run `npx vitest run` and confirm these tests pass**

### Task 2: 进程监管与 HTTP

**Files:**
- Create: `src/process/supervisor.ts`
- Create: `src/server/app.ts`
- Create: `src/server/main.ts`
- Test: `tests/server.test.ts`

**Interfaces:**
- Consumes: Task 1 exports
- Produces: `createSupervisor({ spawn, bins, roots, pollMs })`
- Produces: `supervisor.open/create/close/send/catalog/getSession/connectTerminal`
- Produces: `createApp(supervisor)` listening only when `main` binds `127.0.0.1`

- [ ] **Step 1: Write server tests with a fake spawn and temp session files**
- [ ] **Step 2: Run the new tests and confirm they fail**
- [ ] **Step 3: Implement supervisor and HTTP/WebSocket**
- [ ] **Step 4: Re-run `npx vitest run`**

### Task 3: 网页

**Files:**
- Create: `client/index.html`
- Create: `client/src/main.tsx`
- Create: `client/src/App.tsx`
- Create: `client/src/styles.css`
- Create: `vite.config.ts`

**Interfaces:**
- Consumes: the HTTP and WebSocket API in the spec

- [ ] **Step 1: Build the two-tab, workspace-grouped page**
- [ ] **Step 2: Messages, composer, and bottom terminal using xterm.js**
- [ ] **Step 3: `npm run build` succeeds**

### Task 4: 本机核对

- [ ] **Step 1: `npx vitest run` passes**
- [ ] **Step 2: Start the server and `GET http://127.0.0.1:4789/api/health`**
- [ ] **Step 3: `GET /api/catalog` returns real local workspaces**
- [ ] **Step 4: Do not send a message into a real Claude or Codex session**
