import type { SessionStatus, ToolId } from "./api";
import { currentLanguage, tr } from "./i18n";

export const toolName: Record<ToolId, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  deepseek: "DSH",
};

/** Process outcomes still worth a word. A live reply uses “运行中”; a finished unseen reply uses a dot. Read at render time. */
export const statusText: Record<SessionStatus, string> = {
  idle: "",
  get starting() {
    return tr("正在创建", "Creating");
  },
  running: "",
  occupied: "",
  exited: "",
  get failed() {
    return tr("启动失败", "Failed to start");
  },
  get create_failed() {
    return tr("创建失败", "Could not create");
  },
};

export function oneLine(text: string): string {
  return text.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
}

/** What each error code means to the person, in both languages: [中文, English]. */
const ERRORS: Record<string, [string, string]> = {
  unauthenticated: ["登录已失效，请重新登录。", "Your sign-in has expired. Please sign in again."],
  claude_cli_missing: [
    "这台电脑没装 Claude Code 命令行，不能在这里启动它。在电脑终端里运行 npm install -g @anthropic-ai/claude-code 后重启 MirrorMix。",
    "Claude Code's command line is not installed on this computer, so it cannot be started here. Run npm install -g @anthropic-ai/claude-code in a terminal on the computer, then restart MirrorMix.",
  ],
  codex_cli_missing: [
    "这台电脑没装 Codex 命令行，不能在这里启动它。在电脑终端里运行 npm install -g @openai/codex 后重启 MirrorMix。",
    "Codex's command line is not installed on this computer, so it cannot be started here. Run npm install -g @openai/codex in a terminal on the computer, then restart MirrorMix.",
  ],
  session_running: ["这条会话正在回复。等回复结束，或先点“终止”，再删除。", "This conversation is replying. Wait for it to finish, or click Stop first, then delete it."],
  not_made_here: ["只能删除在网页上新建的会话。AI 工具里建的会话，请在原来的应用里删除。", "Only conversations started on this page can be deleted here. Delete one started in an AI tool from that app."],
  delete_failed: ["没有删掉，文件可能正被别的程序占用。稍后再试。", "Not deleted; another program may be using the file. Try again later."],
  occupied: ["这条会话暂时接不进来，不能从这里发送。", "This conversation cannot be connected to right now, so you cannot send from here."],
  bad_origin: [
    "请求被拒绝：当前页面的地址没有被允许。经过反向代理访问时，在 MIRRORMIX_ALLOWED_ORIGINS 里加上它。",
    "Request refused: this page's address is not allowed. When going through a reverse proxy, add it to MIRRORMIX_ALLOWED_ORIGINS.",
  ],
  inbox_failed: ["消息没有写进 Claude 的输入框。", "The message was not written into Claude's input box."],
  desktop_unavailable: ["没有在 Claude 窗口里找到这条会话。先在那边点开它，再从这里发送。", "This conversation was not found in the Claude window. Open it there first, then send from here."],
  desktop_locked: ["电脑锁屏了，这条会话还没在 Claude 里跑起来。解锁后先点开它，再从这里发送。", "The computer is locked and this conversation is not running in Claude yet. Unlock it, open the conversation, then send from here."],
  trust_first: ["Claude 第一次在这个文件夹里运行，要先确认信任。点上方的“信任并继续”，再发送一次。", "Claude is running in this folder for the first time and needs your trust first. Click Trust and continue above, then send again."],
  cursor_login: [
    "电脑锁屏了，改用 Cursor 命令行回复，但它还没登录。在这台电脑的终端里运行一次 agent login，登录后锁屏也能发。",
    "The computer is locked, so Cursor's command line would reply, but it is not signed in. Run agent login once in a terminal on this computer; then you can send while it is locked.",
  ],
  cursor_cli_failed: ["电脑锁屏了，改用 Cursor 命令行回复，但它启动后马上失败了。MirrorMix 的终端输出里有原因。", "The computer is locked, so Cursor's command line took over, but it failed right after starting. MirrorMix's terminal output says why."],
  cursor_locked: ["电脑锁屏了，消息没法写进 Cursor 窗口，本机也没有找到 Cursor 的命令行 agent。", "The computer is locked, so the message cannot go into the Cursor window, and Cursor's command-line agent was not found here."],
  codex_locked: ["电脑锁屏了，这条消息没能交给 Codex 的后台。", "The computer is locked and the message could not be handed to Codex in the background."],
  codex_unavailable: ["没有在 Codex 桌面窗口里找到这条会话。先在 Codex 里点开它，再从这里发送。", "This conversation was not found in the Codex window. Open it in Codex first, then send from here."],
  codex_failed: ["消息没有从 Codex 桌面窗口发出，请查看桌面端的输入框和提示。", "The message was not sent from the Codex window. Check the input box and messages there."],
  codex_delivery_unconfirmed: [
    "未能确认 Codex 收到这条消息。草稿和附件已保留，请先在桌面端确认，避免重复发送。",
    "Could not confirm Codex received the message. Your draft and attachments are kept; check the desktop app first so it is not sent twice.",
  ],
  not_running: ["这条会话现在没有正在进行的回复。", "This conversation has no reply in progress."],
  stop_unsupported: ["这类会话不能从网页终止回复，请在它自己的界面里停止。", "This kind of conversation cannot be stopped from the page. Stop it in its own app."],
  desktop_missing: ["没找到这条会话的桌面端窗口，请确认客户端开着。", "The desktop window for this conversation was not found. Check that the app is open."],
  stop_failed: ["没能终止回复，请在桌面端里点停止。", "Could not stop the reply. Click Stop in the desktop app."],
  desktop_draft: ["桌面端输入框里已有草稿，请先发送或清空草稿，再从这里发送。", "The desktop app's input box has a draft. Send or clear it first, then send from here."],
  desktop_create_required: ["请先在对应桌面端创建会话，列表更新后即可在这里接着聊。", "Create the conversation in the desktop app first; once the list updates you can carry on here."],
  codex_history_only: [
    "这条历史记录尚未关联 Codex 桌面会话，目前只能查看。请先在 Codex 桌面端打开或创建会话，等列表更新后再发送。",
    "This history is not linked to a Codex desktop conversation yet, so it is view only. Open or create the conversation in Codex, then send once the list updates.",
  ],
  claude_history_only: [
    "这条历史记录尚未关联 Claude 桌面会话，目前只能查看。请先在 Claude 桌面端打开或创建会话，等列表更新后再发送。",
    "This history is not linked to a Claude desktop conversation yet, so it is view only. Open or create the conversation in Claude, then send once the list updates.",
  ],
  deepseek_app_session: [
    "这条会话是在 DSH 桌面端建的，DSH 没有开着，它的命令行又只能继续自己建的会话，所以这里暂时只能查看。打开 DSH 后就能从这里发送。",
    "This conversation was started in the DSH app, which is not open, and DSH's command line can only continue its own conversations, so it is view only for now. Open DSH to send from here.",
  ],
  deepseek_app_refused: ["DSH 没有接受这条消息。MirrorMix 的终端输出里有它给的原因。", "DSH did not accept the message. MirrorMix's terminal output has the reason it gave."],
  deepseek_key: ["DSH 的命令行没有拿到 API Key。先在 DSH 的模型设置里填好 Key，再从这里发送。", "DSH's command line has no API key. Set the key in DSH's model settings, then send from here."],
  deepseek_auth: ["DeepSeek 拒绝了这个 API Key。到 DSH 的模型设置里检查 Key 是否有效。", "DeepSeek refused the API key. Check that it is valid in DSH's model settings."],
  deepseek_failed: ["DSH 的命令行启动后马上失败了。MirrorMix 的终端输出里有原因。", "DSH's command line failed right after starting. MirrorMix's terminal output says why."],
  cursor_failed: ["消息没有写进 Cursor 的输入框。", "The message was not written into Cursor's input box."],
  queue_send: ["没有在 Cursor 的队列里立刻发出这条。", "Cursor did not send this from its queue right away."],
  cursor_unavailable: ["没有在 Cursor 窗口里找到这场对话。先在 Cursor 里点开它，再从这里发送。", "This chat was not found in the Cursor window. Open it in Cursor first, then send from here."],
  cursor_minimized: [
    "Cursor 窗口是最小化的，读不到里面的对话，命令行也没能接手回复。把 Cursor 窗口还原（不用放到最前面），再发送一次。",
    "The Cursor window is minimized, so its chat cannot be read, and the command line could not take over. Restore the window (it need not be in front), then send again.",
  ],
  tool_offline: ["这个工具的客户端没有在本机开启。打开它之后再试。", "This tool's app is not open on this computer. Open it and try again."],
  missing_workspace: ["工作区目录已经不在了，这条会话只能查看。", "The workspace folder is gone, so this conversation is view only."],
  no_question: ["它已经不在问这个问题了，可能已经在工具里答过。", "It is no longer asking this; it may have been answered in the tool."],
  prompt_changed: ["问题刚刚变了，没有替你回答。看一下新的问题再选。", "The question just changed, so nothing was answered. Read the new question, then choose."],
  no_option: ["窗口里没找到这个选项。到工具里直接回答一下。", "That option was not found in the window. Answer in the tool directly."],
  answer_locked: ["电脑锁屏了，点不到桌面应用里的按钮。解锁后再选，或者到工具里直接回答。", "The computer is locked, so the app's buttons cannot be clicked. Unlock it and choose again, or answer in the tool."],
  answer_window_missing: ["没有在桌面应用里找到这场对话，先在应用里点开它再选。", "This chat was not found in the desktop app. Open it there first, then choose."],
  answer_failed: ["没能在桌面应用里点下这个选项。到工具里直接回答一下。", "Could not click that option in the desktop app. Answer in the tool directly."],
  create_failed: ["没有等到新会话，进程已结束。", "The new conversation never appeared; the process has ended."],
  unknown_workspace: ["这个工作区不在列表里。", "This workspace is not in the list."],
  unknown_session: ["这条会话已经不在了。", "This conversation is gone."],
  failed: ["进程没有启动。", "The process did not start."],
};
ERRORS.option_missing = ERRORS.no_option;

export function errorText(code: string | undefined): string {
  const [zh, en] = (code && ERRORS[code]) || ["请求没有完成，检查服务是否还在运行。", "The request did not complete. Check that MirrorMix is still running."];
  return tr(zh, en);
}

export function jobStatus(status: string): string {
  if (status.toUpperCase() === "ACTIVE") return tr("启用", "Active");
  if (status.toUpperCase() === "PAUSED") return tr("暂停", "Paused");
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

/** Time left until a limit resets: "2小时14分", "38分", "不到1分" (or "2h 14m"); a weekly window shows days too. */
export function timeUntil(at: number, now = Date.now()): string {
  const minutes = Math.ceil((at - now) / 60_000);
  const en = currentLanguage() === "en";
  if (minutes <= 1) return en ? "<1m" : "不到1分";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (en) {
    if (days) return hours ? `${days}d ${hours}h` : `${days}d`;
    if (hours) return rest ? `${hours}h ${rest}m` : `${hours}h`;
    return `${rest}m`;
  }
  if (days) return hours ? `${days}天${hours}小时` : `${days}天`;
  if (hours) return rest ? `${hours}小时${rest}分` : `${hours}小时`;
  return `${rest}分`;
}

export function relativeTime(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const en = currentLanguage() === "en";
  const minutes = Math.floor((now - then) / 60000);
  if (minutes < 1) return en ? "just now" : "刚刚";
  if (minutes < 60) return en ? `${minutes} min ago` : `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return en ? `${hours} h ago` : `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days === 1) return en ? "yesterday" : "昨天";
  if (days < 7) return en ? `${days} days ago` : `${days} 天前`;
  const date = new Date(then);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  if (en) return date.toLocaleDateString("en-US", sameYear ? { month: "short", day: "numeric" } : { month: "short", year: "numeric" });
  return sameYear ? `${date.getMonth() + 1}月${date.getDate()}日` : `${date.getFullYear()}年${date.getMonth() + 1}月`;
}
