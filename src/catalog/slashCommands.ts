import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { ToolId } from "../shared/types";

/** One entry of the "/" menu. Picking it puts `/name ` in the message box; the tool runs it when that is sent. */
export interface SlashCommand {
  name: string;
  description: string;
  /** Where it comes from, shown beside it: the tool itself, the user's own folder, or the session's project. */
  source: "builtin" | "user" | "project" | "skill";
}

// The tools' own commands that make sense sent as a message. Ones that open a picker or a dialog in the terminal
// (/resume, /permissions, /config…) are left out: there is no terminal on the page to answer them.
const BUILTIN: Record<ToolId, Array<[string, string]>> = {
  claude: [
    ["clear", "清空对话，从头开始"],
    ["compact", "压缩对话，保留要点，腾出上下文"],
    ["context", "查看上下文用了多少"],
    ["cost", "查看本次会话的花费"],
    ["usage", "查看订阅的用量和限额"],
    ["model", "查看或切换模型，例如 /model opus"],
    ["init", "为项目生成 CLAUDE.md"],
    ["review", "审查代码改动"],
    ["security-review", "对当前改动做安全审查"],
    ["memory", "编辑记忆文件"],
    ["status", "查看版本、模型和账号状态"],
    ["help", "查看帮助"],
  ],
  codex: [
    ["new", "在这个会话里开始新对话"],
    ["compact", "压缩对话，腾出上下文"],
    ["init", "为项目生成 AGENTS.md"],
    ["review", "审查当前改动"],
    ["diff", "查看 git 改动"],
    ["status", "查看当前会话的配置和用量"],
    ["model", "查看或切换模型"],
    ["mcp", "列出已配置的 MCP 工具"],
  ],
  cursor: [],
  deepseek: [],
};

/** The description in a command file's front matter, else its first line of text. */
function describe(file: string): string {
  let text = "";
  try {
    text = readFileSync(file, "utf8").replace(/^﻿/, "");
  } catch {
    return "";
  }
  const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const described = front?.[1].match(/^description:\s*["']?(.+?)["']?\s*$/m)?.[1];
  if (described) return described.trim().slice(0, 160);
  const body = front ? text.slice(front[0].length) : text;
  const first = body.split(/\r?\n/).map((line) => line.replace(/^#+\s*/, "").trim()).find(Boolean) ?? "";
  return first.slice(0, 160);
}

/** Markdown command files in a folder and its subfolders, named by file name. */
function commandFiles(dir: string, source: SlashCommand["source"], prefix = "", depth = 0): SlashCommand[] {
  if (!dir || !existsSync(dir) || depth > 3) return [];
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: SlashCommand[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...commandFiles(full, source, prefix, depth + 1));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      found.push({ name: prefix + entry.name.slice(0, -3), description: describe(full), source });
    }
  }
  return found;
}

/** Skills are folders holding SKILL.md; they are called by the folder's (or the front matter's) name. */
function skills(dir: string, source: SlashCommand["source"], prefix = ""): SlashCommand[] {
  if (!dir || !existsSync(dir)) return [];
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const found: SlashCommand[] = [];
  for (const folder of names) {
    const file = path.join(dir, folder, "SKILL.md");
    try {
      if (!statSync(file).isFile()) continue;
    } catch {
      continue;
    }
    const front = readFileSync(file, "utf8").match(/^﻿?---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
    const name = front.match(/^name:\s*["']?(.+?)["']?\s*$/m)?.[1]?.trim() || folder;
    found.push({ name: prefix + name, description: describe(file), source });
  }
  return found;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

/** The name a plugin's skills and commands go by: its manifest's, else the part of its key before "@". */
function pluginName(dir: string, key: string): string {
  const manifest = readJson(path.join(dir, ".claude-plugin", "plugin.json")) as { name?: unknown } | null;
  return typeof manifest?.name === "string" && manifest.name ? manifest.name : key.split("@")[0];
}

/**
 * Claude Code plugins that are installed and switched on (`enabledPlugins` in ~/.claude/settings.json), with their
 * skills and commands as Claude Code names them: /<plugin>:<name>, e.g. /frontend-design:frontend-design.
 */
function pluginEntries(home: string): SlashCommand[] {
  const installed = readJson(path.join(home, ".claude", "plugins", "installed_plugins.json")) as {
    plugins?: Record<string, Array<{ installPath?: unknown }> | { installPath?: unknown }>;
  } | null;
  const settings = readJson(path.join(home, ".claude", "settings.json")) as { enabledPlugins?: Record<string, unknown> } | null;
  const enabled = settings?.enabledPlugins ?? {};
  const found: SlashCommand[] = [];
  for (const [key, value] of Object.entries(installed?.plugins ?? {})) {
    if (enabled[key] !== true) continue;
    const installs = Array.isArray(value) ? value : [value];
    const dir = installs.map((item) => item?.installPath).find((item): item is string => typeof item === "string" && existsSync(item));
    if (!dir) continue;
    const name = pluginName(dir, key);
    found.push(...skills(path.join(dir, "skills"), "skill", `${name}:`));
    found.push(...commandFiles(path.join(dir, "commands"), "skill", `${name}:`));
  }
  return found;
}

/** Folders directly inside `dir`, newest first; empty when it cannot be read. */
function subfolders(dir: string): Array<{ path: string; at: number }> {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const full = path.join(dir, entry.name);
        let at = 0;
        try {
          at = statSync(full).mtimeMs;
        } catch {
          /* gone meanwhile */
        }
        return { path: full, at };
      });
  } catch {
    return [];
  }
}

let desktopBundle: { dataDir: string; at: number; dir: string | null } | null = null;

/**
 * The skills the Claude desktop app brings to its sessions (docx, pdf…): a plugin bundle it keeps per account under
 * `<data>/<account>/local-agent-mode-sessions/skills-plugin/<org>/<id>/`. Several copies can be there; the newest is
 * the one in use. Looked up again at most once a minute.
 */
function desktopSkillsBundle(dataDir: string): string | null {
  if (!dataDir) return null;
  if (desktopBundle && desktopBundle.dataDir === dataDir && Date.now() - desktopBundle.at < 60_000) return desktopBundle.dir;
  let newest: { path: string; at: number } | null = null;
  for (const account of subfolders(dataDir)) {
    for (const org of subfolders(path.join(account.path, "local-agent-mode-sessions", "skills-plugin"))) {
      for (const bundle of subfolders(org.path)) {
        if (!existsSync(path.join(bundle.path, "skills"))) continue;
        if (!newest || bundle.at > newest.at) newest = bundle;
      }
    }
  }
  desktopBundle = { dataDir, at: Date.now(), dir: newest?.path ?? null };
  return desktopBundle.dir;
}

export interface SlashOptions {
  /** The session runs in the Claude desktop app, so the app's own skills are there too. */
  desktop?: boolean;
  /** The Claude desktop app's data folder. */
  claudeDataDir?: string;
}

/** What the "/" menu offers for a session of `tool` working in `cwd`. Project entries win over same-named others. */
export function slashCommands(tool: ToolId, cwd: string, home: string, options: SlashOptions = {}): SlashCommand[] {
  const all: SlashCommand[] = [];
  if (tool === "claude") {
    all.push(...commandFiles(path.join(cwd, ".claude", "commands"), "project"));
    all.push(...skills(path.join(cwd, ".claude", "skills"), "project"));
    all.push(...commandFiles(path.join(home, ".claude", "commands"), "user"));
    all.push(...skills(path.join(home, ".claude", "skills"), "skill"));
    all.push(...pluginEntries(home));
    // Only a session in the desktop app has the app's own skills; Claude Code on its own does not know them.
    const bundle = options.desktop ? desktopSkillsBundle(options.claudeDataDir ?? "") : null;
    if (bundle) all.push(...skills(path.join(bundle, "skills"), "skill", `${pluginName(bundle, "anthropic-skills")}:`));
  } else if (tool === "codex") {
    // Codex calls its saved prompts as /prompts:<name>.
    all.push(...commandFiles(path.join(home, ".codex", "prompts"), "user", "prompts:"));
  } else {
    all.push(...commandFiles(path.join(cwd, ".cursor", "commands"), "project"));
    all.push(...commandFiles(path.join(home, ".cursor", "commands"), "user"));
  }
  all.push(...BUILTIN[tool].map(([name, description]) => ({ name, description, source: "builtin" as const })));
  const seen = new Set<string>();
  return all.filter((command) => {
    const key = command.name.toLowerCase();
    if (!command.name || /\s/.test(command.name) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
