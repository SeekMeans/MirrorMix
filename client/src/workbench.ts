import type { Catalog, ToolId } from "./api";

/**
 * The workbench is quiet when no open AI tool has a session replying, nor one whose finished reply is still unread
 * (`finished` holds those as `tool:id`). Only then does it show today's figures; otherwise the live sessions come first.
 */
export function isWorkbenchQuiet(catalog: Catalog | null, tools: ToolId[], offlineTools: ToolId[], finished: Set<string>): boolean {
  if (!catalog) return false;
  for (const tool of tools) {
    if (offlineTools.includes(tool)) continue;
    for (const group of catalog[tool] ?? []) {
      for (const session of group.sessions) {
        if (session.working || finished.has(`${tool}:${session.id}`)) return false;
      }
    }
  }
  return true;
}
