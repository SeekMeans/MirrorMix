import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * What the preview menu shows for one project folder: the HTML files and local ports the person picked.
 * Every session in the same folder shares it. Kept in one JSON file, keyed by the folder (see workspaceTerminalKey).
 */
export interface PreviewPicks {
  /** HTML files, relative to the project folder, with forward slashes. */
  files: string[];
  /** Ports, with the program name seen when it was picked, shown while the port is not running. */
  ports: Array<{ port: number; name?: string }>;
  updatedAt: string;
}

export class PreviewPickError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

const MAX_FILES = 200;
const MAX_PORTS = 50;
const MAX_PROJECTS = 2_000;

/** A file path the menu may list: relative, inside the folder, an .html/.htm or Markdown file. Null otherwise. */
export function cleanPickedFile(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 1_000 || /[\x00-\x1f]/.test(value)) return null;
  const parts = value.replace(/\\/g, "/").split("/").filter((part) => part && part !== ".");
  if (!parts.length || parts.some((part) => part === "..") || /^[a-z]:$/i.test(parts[0]) || value.startsWith("/") || value.startsWith("\\")) return null;
  const file = parts.join("/");
  return /\.(?:html?|md|markdown)$/i.test(file) ? file : null;
}

/** Checks what the page sent. `portAllowed` is the preview listener's own rule for which ports may be shown. */
export function validatePicks(value: unknown, portAllowed: (port: number) => boolean): Omit<PreviewPicks, "updatedAt"> {
  if (!value || typeof value !== "object") throw new PreviewPickError("picks_invalid");
  const body = value as { files?: unknown; ports?: unknown };
  if (!Array.isArray(body.files) || !Array.isArray(body.ports) || body.files.length > MAX_FILES || body.ports.length > MAX_PORTS) {
    throw new PreviewPickError("picks_invalid");
  }
  const files: string[] = [];
  const seenFiles = new Set<string>();
  for (const item of body.files) {
    const file = cleanPickedFile(item);
    if (!file) throw new PreviewPickError("picks_invalid");
    const key = file.toLowerCase();
    if (!seenFiles.has(key)) {
      seenFiles.add(key);
      files.push(file);
    }
  }
  const ports: PreviewPicks["ports"] = [];
  const seenPorts = new Set<number>();
  for (const item of body.ports) {
    const row = typeof item === "number" ? { port: item } : item && typeof item === "object" ? (item as { port?: unknown; name?: unknown }) : null;
    const port = typeof row?.port === "number" ? row.port : NaN;
    if (!portAllowed(port)) throw new PreviewPickError("picks_bad_port");
    if (seenPorts.has(port)) continue;
    seenPorts.add(port);
    const name = typeof row?.name === "string" ? row.name.trim().slice(0, 80).replace(/[\x00-\x1f]/g, "") : "";
    ports.push(name ? { port, name } : { port });
  }
  ports.sort((a, b) => a.port - b.port);
  return { files, ports };
}

interface PickFile {
  version: 1;
  projects: Record<string, PreviewPicks & { root?: string }>;
}

export interface PreviewPickStore {
  /** Null when nothing was picked for this folder yet: the menu then asks first. */
  get(key: string): PreviewPicks | null;
  set(key: string, root: string, value: unknown): PreviewPicks;
}

export function createPreviewPickStore(file: string, portAllowed: (port: number) => boolean): PreviewPickStore {
  const load = (): PickFile => {
    try {
      if (statSync(file).size > 8 * 1024 * 1024) return { version: 1, projects: {} };
      const data = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")) as Partial<PickFile>;
      if (data && typeof data.projects === "object" && data.projects && !Array.isArray(data.projects)) return { version: 1, projects: data.projects };
    } catch {
      /* missing or unreadable: start empty */
    }
    return { version: 1, projects: {} };
  };
  return {
    get(key) {
      const saved = load().projects[key];
      if (!saved) return null;
      try {
        const clean = validatePicks(saved, () => true);
        return { ...clean, updatedAt: typeof saved.updatedAt === "string" ? saved.updatedAt : "" };
      } catch {
        return null;
      }
    },
    set(key, root, value) {
      const picks: PreviewPicks = { ...validatePicks(value, portAllowed), updatedAt: new Date().toISOString() };
      const data = load();
      delete data.projects[key];
      data.projects[key] = { ...picks, root };
      const keys = Object.keys(data.projects);
      // Oldest first in insertion order; a folder long gone falls off before the file grows without end.
      for (const old of keys.slice(0, Math.max(0, keys.length - MAX_PROJECTS))) delete data.projects[old];
      mkdirSync(path.dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`);
      renameSync(temp, file);
      return picks;
    },
  };
}
