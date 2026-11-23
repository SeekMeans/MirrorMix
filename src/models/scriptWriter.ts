import type { ChatMessage } from "./modelStore";

/** What a snippet is written for: a Linux shell, a Windows host (PowerShell), or Python run from a Linux shell. */
export type ScriptKind = "linux" | "windows" | "python";
export const SCRIPT_KINDS: ScriptKind[] = ["linux", "windows", "python"];

const TARGET: Record<ScriptKind, string> = {
  linux: "Linux 服务器上的 bash（可以假设有常见的 GNU 工具）。",
  windows: "Windows 主机上的 PowerShell 5.1（通过 OpenSSH 登录后执行）。",
  python:
    "Linux 服务器上的 Python 3。把 Python 代码包在 here-doc 里，让整段内容可以直接粘贴到 bash 执行：第一行 `python3 - <<'PY'`，最后一行 `PY`。",
};

/** The messages that ask a model to write a snippet for `kind` from what the person described. */
export function scriptPrompt(kind: ScriptKind, description: string, current = ""): ChatMessage[] {
  const system = [
    "# 角色",
    "你是一名运维工程师，为 SSH 终端写可以直接执行的命令片段。",
    "",
    "# 运行环境",
    TARGET[kind],
    "",
    "# 要求",
    "- 只写完成需求所需的命令，不要解释、不要 Markdown 代码块标记。",
    "- 出错时要停下来：bash 用 `set -e` 或 `&&` 连接，PowerShell 设置 `$ErrorActionPreference = 'Stop'`。",
    "- 需要用户自己填的值（路径、域名、密码）用醒目的占位符，如 <你的域名>，不要编造。",
    "- 不要执行删库、格式化磁盘、`rm -rf /` 这类不可逆的危险操作，除非用户明确要求。",
    "- 可以加简短的中文注释说明关键步骤。",
    "",
    "# 输出格式",
    'JSON：{"label": "不超过 20 个字的片段名称", "command": "完整的命令文本，换行用 \\n"}',
  ].join("\n");
  const user = current.trim()
    ? `在下面这段现有命令的基础上修改：\n${current.trim()}\n\n要求：\n${description.trim()}`
    : description.trim();
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/** Strips a Markdown fence a model may put around code anyway. */
function unfence(text: string): string {
  const fenced = text.trim().match(/^```[\w-]*\s*\n([\s\S]*?)\n?```\s*$/);
  return (fenced ? fenced[1] : text).replace(/\r\n/g, "\n").trim();
}

/**
 * The snippet in a model's reply: the JSON asked for, or, from a model that answered with plain text, that text as
 * the command.
 */
export function readScript(reply: string): { label: string; command: string } {
  const text = unfence(reply);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1)) as { label?: unknown; command?: unknown };
      if (typeof parsed.command === "string" && parsed.command.trim()) {
        return { label: typeof parsed.label === "string" ? parsed.label.trim().slice(0, 60) : "", command: unfence(parsed.command) };
      }
    } catch {
      /* not JSON after all: the text is the command */
    }
  }
  return { label: "", command: text };
}
