import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ToolId } from "../shared/types";

/**
 * Sessions removed from MirrorMix's list without touching their files: the ones an app keeps (the Claude or Codex
 * desktop app, Cursor), whose files are part of that app's own data.
 */
export interface HiddenSessions {
  has(tool: ToolId, id: string): boolean;
  add(tool: ToolId, id: string): void;
}

type Saved = Partial<Record<ToolId, string[]>>;

export function createHiddenSessions(file: string): HiddenSessions {
  let cache: Map<ToolId, Set<string>> | null = null;
  const load = () => {
    if (cache) return cache;
    let saved: Saved = {};
    try {
      saved = JSON.parse(readFileSync(file, "utf8")) as Saved;
    } catch {
      saved = {};
    }
    cache = new Map();
    for (const tool of ["claude", "codex", "cursor", "deepseek"] as const) {
      const ids = Array.isArray(saved[tool]) ? saved[tool].filter((id): id is string => typeof id === "string") : [];
      cache.set(tool, new Set(ids.map((id) => id.toLowerCase())));
    }
    return cache;
  };
  return {
    has(tool, id) {
      return load().get(tool)?.has(id.toLowerCase()) ?? false;
    },
    add(tool, id) {
      const sets = load();
      sets.get(tool)?.add(id.toLowerCase());
      const out: Saved = {};
      for (const [key, ids] of sets) out[key] = [...ids];
      mkdirSync(path.dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(out, null, 2));
      renameSync(temp, file);
    },
  };
}
