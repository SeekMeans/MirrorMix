import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ProcessInfo } from "../process/occupancy";
import type { ToolId } from "../shared/types";

export const ALL_TOOLS: ToolId[] = ["claude", "codex", "cursor", "deepseek"];

/**
 * The desktop app of each tool, as it appears on a process command line.
 * The command-line programs this server starts itself do not count: a tool is "open" when its own app is.
 */
const APP_PATTERNS: Record<ToolId, RegExp[]> = {
  claude: [/[\\/]WindowsApps[\\/]Claude_[^"]*[\\/]Claude\.exe/i, /[\\/]AnthropicClaude[\\/][^"]*Claude\.exe/i, /Claude\.app[\\/]Contents[\\/]MacOS/i],
  codex: [/[\\/]OpenAI\.Codex_[^"]*[\\/](ChatGPT|Codex)\.exe/i, /[\\/]Programs[\\/]Codex[\\/][^"]*Codex\.exe/i, /Codex\.app[\\/]Contents[\\/]MacOS/i],
  cursor: [/[\\/]cursor[\\/]Cursor\.exe/i, /Cursor\.app[\\/]Contents[\\/]MacOS/i],
  // The app's main process only, whatever it was started with (`--updated` after an update): its helpers carry
  // `--type=…`, and its command line (MirrorMix's own replies too) runs with `--expose-internals`.
  deepseek: [/[\\/]DeepSeek Harness\.exe"?(?![\s\S]*--(?:type=|expose-internals))/i, /DeepSeek Harness\.app[\\/]Contents[\\/]MacOS/i],
};

export interface ToolStatus {
  /** The tool's desktop app is open on this machine. */
  running: boolean;
}

export function detectTools(processes: ProcessInfo[]): Record<ToolId, ToolStatus> {
  const status = { claude: { running: false }, codex: { running: false }, cursor: { running: false }, deepseek: { running: false } };
  for (const { commandLine, name, windowTitle } of processes) {
    // MSIX app-container processes can hide their command line even from the same Windows user.
    if (name?.toLowerCase() === "claude.exe" && windowTitle === "Claude") status.claude.running = true;
    if (!commandLine) continue;
    for (const tool of ALL_TOOLS) {
      if (!status[tool].running && APP_PATTERNS[tool].some((pattern) => pattern.test(commandLine))) status[tool].running = true;
    }
  }
  return status;
}

export interface ToolSettings {
  /** Tools the person chose to show, in display order. */
  tools: ToolId[];
  /** Sessions pinned in MirrorMix itself (`tool:id`). Kept apart from the tools' own pins, which are never touched. */
  pinned: string[];
}

function cleanPinned(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const keys = value.filter((key): key is string => typeof key === "string" && /^(claude|codex|cursor|deepseek):.+/.test(key));
  return [...new Set(keys)].slice(0, 200);
}

function clean(value: unknown): ToolId[] | null {
  if (!Array.isArray(value)) return null;
  return ALL_TOOLS.filter((tool) => value.includes(tool));
}

export interface SettingsStore {
  read(): ToolSettings;
  write(value: unknown): ToolSettings;
  status(): Record<ToolId, ToolStatus>;
  /** A tool can be used when it is chosen in settings and its app is open. */
  usable(tool: ToolId): boolean;
  /** The plugins added from the plugin market, in the order they were added. */
  plugins(): string[];
  setPlugins(value: unknown): string[];
}

/** What the plugin market offers. Anything else in a saved list is dropped. */
export const PLUGIN_IDS = ["commands", "schedules", "ssh"] as const;

/** These two are added until the person chooses otherwise: they were part of settings before the market existed. */
const DEFAULT_PLUGINS: string[] = ["commands", "schedules"];

function cleanPlugins(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const known = new Set<string>(PLUGIN_IDS);
  return [...new Set(value.filter((id): id is string => typeof id === "string" && known.has(id)))];
}

export function createSettingsStore(file: string, listProcesses: () => ProcessInfo[]): SettingsStore {
  const read = (): ToolSettings => {
    try {
      const data = JSON.parse(readFileSync(file, "utf8")) as { tools?: unknown; pinned?: unknown };
      return { tools: clean(data.tools) ?? [...ALL_TOOLS], pinned: cleanPinned(data.pinned) ?? [] };
    } catch {
      /* no file yet, or one that cannot be read: everything is shown */
    }
    return { tools: [...ALL_TOOLS], pinned: [] };
  };
  const status = () => detectTools(listProcesses());
  const pluginFile = path.join(path.dirname(file), "plugins.json");
  const plugins = (): string[] => {
    try {
      return cleanPlugins((JSON.parse(readFileSync(pluginFile, "utf8")) as { installed?: unknown }).installed) ?? [...DEFAULT_PLUGINS];
    } catch {
      return [...DEFAULT_PLUGINS];
    }
  };
  return {
    plugins,
    setPlugins(value) {
      const installed = cleanPlugins((value as { installed?: unknown } | null)?.installed);
      if (!installed) throw new Error("bad_request");
      if (!existsSync(path.dirname(pluginFile))) mkdirSync(path.dirname(pluginFile), { recursive: true });
      writeFileSync(pluginFile, `${JSON.stringify({ installed }, null, 2)}\n`);
      return installed;
    },
    read,
    write(value) {
      const input = (value ?? {}) as { tools?: unknown; pinned?: unknown };
      const tools = input.tools === undefined ? null : clean(input.tools);
      const pinned = input.pinned === undefined ? null : cleanPinned(input.pinned);
      // Either part may be saved alone; a part that is present but malformed is refused.
      if ((input.tools !== undefined && !tools) || (input.pinned !== undefined && !pinned) || (!tools && !pinned)) {
        throw new Error("bad_request");
      }
      const current = read();
      const next = { tools: tools ?? current.tools, pinned: pinned ?? current.pinned };
      if (!existsSync(path.dirname(file))) mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(next, null, 2)}
`);
      return next;
    },
    status,
    usable: (tool) => read().tools.includes(tool) && status()[tool].running,
  };
}
