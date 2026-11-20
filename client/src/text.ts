import type { SessionStatus, ToolId } from "./api";

export const toolName: Record<ToolId, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  deepseek: "DSH",
};

/** Process outcomes still worth a word. A live reply uses “运行中”; a finished unseen reply uses a dot. */
export const statusText: Record<SessionStatus, string> = {
  idle: "",
  starting: "正在创建",
  running: "",
  occupied: "",
  exited: "",
  failed: "启动失败",
  create_failed: "创建失败",
};

export function oneLine(text: string): string {
  return text.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
}

export function errorText(code: string | undefined): string {
  if (code === "unauthenticated") return "登录已失效，请重新登录。";
  if (code === "claude_cli_missing") return "这台电脑没装 Claude Code 命令行，不能在这里启动它。在电脑终端里运行 npm install -g @anthropic-ai/claude-code 后重启 MirrorMix。";
  if (code === "codex_cli_missing") return "这台电脑没装 Codex 命令行，不能在这里启动它。在电脑终端里运行 npm install -g @openai/codex 后重启 MirrorMix。";
  if (code === "session_running") return "这条会话正在回复。等回复结束，或先点“终止”，再删除。";
  if (code === "not_made_here") return "只能删除在网页上新建的会话。AI 工具里建的会话，请在原来的应用里删除。";
  if (code === "delete_failed") return "没有删掉，文件可能正被别的程序占用。稍后再试。";
  if (code === "occupied") return "这条会话暂时接不进来，不能从这里发送。";
  if (code === "bad_origin") return "请求被拒绝：当前页面的地址没有被允许。经过反向代理访问时，在 MIRRORMIX_ALLOWED_ORIGINS 里加上它。";
  if (code === "inbox_failed") return "消息没有写进 Claude 的输入框。";
  if (code === "desktop_unavailable") return "没有在 Claude 窗口里找到这条会话。先在那边点开它，再从这里发送。";
  if (code === "desktop_locked") return "电脑锁屏了，这条会话还没在 Claude 里跑起来。解锁后先点开它，再从这里发送。";
  if (code === "trust_first") return "Claude 第一次在这个文件夹里运行，要先确认信任。点上方的“信任并继续”，再发送一次。";
  if (code === "cursor_login") return "电脑锁屏了，改用 Cursor 命令行回复，但它还没登录。在这台电脑的终端里运行一次 agent login，登录后锁屏也能发。";
  if (code === "cursor_cli_failed") return "电脑锁屏了，改用 Cursor 命令行回复，但它启动后马上失败了。MirrorMix 的终端输出里有原因。";
  if (code === "cursor_locked") return "电脑锁屏了，消息没法写进 Cursor 窗口，本机也没有找到 Cursor 的命令行 agent。";
  if (code === "codex_locked") return "电脑锁屏了，这条消息没能交给 Codex 的后台。";
  if (code === "codex_unavailable") return "没有在 Codex 桌面窗口里找到这条会话。先在 Codex 里点开它，再从这里发送。";
  if (code === "codex_failed") return "消息没有从 Codex 桌面窗口发出，请查看桌面端的输入框和提示。";
  if (code === "not_running") return "这条会话现在没有正在进行的回复。";
  if (code === "stop_unsupported") return "这类会话不能从网页终止回复，请在它自己的界面里停止。";
  if (code === "desktop_locked") return "电脑屏幕已锁定，没法点桌面端的停止按钮。解锁后再试。";
  if (code === "desktop_missing") return "没找到这条会话的桌面端窗口，请确认客户端开着。";
  if (code === "stop_failed") return "没能终止回复，请在桌面端里点停止。";
  if (code === "desktop_draft") return "桌面端输入框里已有草稿，请先发送或清空草稿，再从这里发送。";
  if (code === "desktop_create_required") return "请先在对应桌面端创建会话，列表更新后即可在这里接着聊。";
  if (code === "codex_history_only") return "这条历史记录尚未关联 Codex 桌面会话，目前只能查看。请先在 Codex 桌面端打开或创建会话，等列表更新后再发送。";
  if (code === "claude_history_only") return "这条历史记录尚未关联 Claude 桌面会话，目前只能查看。请先在 Claude 桌面端打开或创建会话，等列表更新后再发送。";
  if (code === "deepseek_app_session") return "这条会话是在 DSH 桌面端建的，DSH 没有开着，它的命令行又只能继续自己建的会话，所以这里暂时只能查看。打开 DSH 后就能从这里发送。";
  if (code === "deepseek_app_refused") return "DSH 没有接受这条消息。MirrorMix 的终端输出里有它给的原因。";
  if (code === "deepseek_key") return "DSH 的命令行没有拿到 API Key。先在 DSH 的模型设置里填好 Key，再从这里发送。";
  if (code === "deepseek_auth") return "DeepSeek 拒绝了这个 API Key。到 DSH 的模型设置里检查 Key 是否有效。";
  if (code === "deepseek_failed") return "DSH 的命令行启动后马上失败了。MirrorMix 的终端输出里有原因。";
  if (code === "cursor_failed") return "消息没有写进 Cursor 的输入框。";
  if (code === "queue_send") return "没有在 Cursor 的队列里立刻发出这条。";
  if (code === "cursor_unavailable") return "没有在 Cursor 窗口里找到这场对话。先在 Cursor 里点开它，再从这里发送。";
  if (code === "cursor_minimized")
    return "Cursor 窗口是最小化的，读不到里面的对话，命令行也没能接手回复。把 Cursor 窗口还原（不用放到最前面），再发送一次。";
  if (code === "tool_offline") return "这个工具的客户端没有在本机开启。打开它之后再试。";
  if (code === "missing_workspace") return "工作区目录已经不在了，这条会话只能查看。";
  if (code === "no_question") return "终端已经不在问这个问题了。";
  if (code === "create_failed") return "没有等到新会话，进程已结束。";
  if (code === "unknown_workspace") return "这个工作区不在列表里。";
  if (code === "unknown_session") return "这条会话已经不在了。";
  if (code === "failed") return "进程没有启动。";
  return "请求没有完成，检查服务是否还在运行。";
}

export function jobStatus(status: string): string {
  if (status.toUpperCase() === "ACTIVE") return "启用";
  if (status.toUpperCase() === "PAUSED") return "暂停";
  return status;
}

/** Splits a workspace path into the folder name and where it lives. */
export function splitPath(full: string): { name: string; parent: string } {
  const trimmed = full.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  if (cut < 0) return { name: trimmed || full, parent: "" };
  const parent = trimmed.slice(0, cut) || trimmed.slice(0, cut + 1);
  return { name: trimmed.slice(cut + 1) || trimmed, parent: parent.length > 34 ? `…${parent.slice(-33)}` : parent };
}

/** Time left until a limit resets: "2小时14分", "38分", "不到1分"; a weekly window shows days too. */
export function timeUntil(at: number, now = Date.now()): string {
  const minutes = Math.ceil((at - now) / 60_000);
  if (minutes <= 1) return "不到1分";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days) return hours ? `${days}天${hours}小时` : `${days}天`;
  if (hours) return rest ? `${hours}小时${rest}分` : `${hours}小时`;
  return `${rest}分`;
}

export function relativeTime(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const minutes = Math.floor((now - then) / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "昨天";
  if (days < 7) return `${days} 天前`;
  const date = new Date(then);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return sameYear ? `${date.getMonth() + 1}月${date.getDate()}日` : `${date.getFullYear()}年${date.getMonth() + 1}月`;
}
