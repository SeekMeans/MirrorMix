import { createReadStream, readdirSync, realpathSync, statSync } from "node:fs";
import type http from "node:http";
import path from "node:path";
import { TYPES } from "./preview";

/** One row of the file browser. */
export interface FolderEntry {
  name: string;
  dir: boolean;
  /** Bytes; 0 for folders. */
  size: number;
  /** Last change (ms). */
  mtime: number;
}

const MAX_ENTRIES = 3_000;

/**
 * The real path under `root` that `relative` names, or null when it is outside it: by "..", by a drive or an
 * absolute path, or by a link that points elsewhere.
 */
export function insideFolder(root: string, relative: string): string | null {
  if (relative.includes("\0")) return null;
  let base: string;
  try {
    base = realpathSync(root);
  } catch {
    return null;
  }
  const wanted = path.resolve(base, `.${path.posix.normalize(`/${relative.replace(/\\/g, "/")}`)}`);
  let real: string;
  try {
    real = realpathSync(wanted);
  } catch {
    return null;
  }
  const prefix = base.endsWith(path.sep) ? base : `${base}${path.sep}`;
  return real === base || real.startsWith(prefix) ? real : null;
}

/** `full` relative to `root`'s real path, with forward slashes ("" for the root itself). */
function relativeTo(root: string, full: string): string {
  return path.relative(realpathSync(root), full).split(path.sep).join("/");
}

/** A folder's contents, folders first, then by name. Null when it is not a folder inside `root`. */
export function listFolder(root: string, relative: string): { dir: string; entries: FolderEntry[]; truncated: boolean } | null {
  const folder = insideFolder(root, relative);
  if (!folder) return null;
  try {
    if (!statSync(folder).isDirectory()) return null;
  } catch {
    return null;
  }
  let names: import("node:fs").Dirent[];
  try {
    names = readdirSync(folder, { withFileTypes: true });
  } catch {
    return null;
  }
  const entries: FolderEntry[] = [];
  for (const entry of names) {
    if (entries.length >= MAX_ENTRIES) break;
    const full = path.join(folder, entry.name);
    try {
      // A link is shown as what it points to; one that leads out of the folder is left out.
      const stat = statSync(full);
      if (entry.isSymbolicLink() && !insideFolder(root, relativeTo(root, full))) continue;
      entries.push({ name: entry.name, dir: stat.isDirectory(), size: stat.isDirectory() ? 0 : stat.size, mtime: stat.mtimeMs });
    } catch {
      /* gone, or not readable: not listed */
    }
  }
  entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, "zh-CN", { numeric: true, sensitivity: "base" }) : a.dir ? -1 : 1));
  return { dir: relativeTo(root, folder), entries, truncated: names.length > entries.length && entries.length >= MAX_ENTRIES };
}

/**
 * Sends one file from the session folder to the page's preview. The page is on MirrorMix's own address, where the
 * login cookie lives, so nothing served here may run as a page: the sandbox gives HTML and SVG no scripts and an
 * origin of their own. (A page that should really run opens through the preview listener instead.)
 */
export function sendFolderFile(root: string, relative: string, download: boolean, response: http.ServerResponse): boolean {
  const file = insideFolder(root, relative);
  if (!file) return false;
  let size = 0;
  try {
    const stat = statSync(file);
    if (!stat.isFile()) return false;
    size = stat.size;
  } catch {
    return false;
  }
  const ext = path.extname(file).toLowerCase();
  const pdf = ext === ".pdf";
  const name = encodeURIComponent(path.basename(file));
  response.writeHead(200, {
    "content-type": TYPES[ext] ?? "application/octet-stream",
    "content-length": String(size),
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
    "content-disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${name}`,
    // The browser's PDF viewer does not open inside a sandbox; a PDF cannot reach the page's cookie anyway.
    ...(pdf ? {} : { "content-security-policy": "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'" }),
  });
  createReadStream(file).on("error", () => response.destroy()).pipe(response);
  return true;
}
