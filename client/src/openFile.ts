/** A file named in a reply was clicked: the page opens the file browser at it. */
export const OPEN_FILE = "mirrormix:open-file";

export interface OpenFileRequest {
  /** Changes on every click, so the same file can be shown again. */
  seq: number;
  /** As written in the reply: relative to the session folder, or absolute. */
  path: string;
}

/**
 * The file a link in a reply points to, or null for a web address, a mail link or an anchor.
 * Line numbers ("app.ts:42", "#L42") and URL escapes are taken off.
 */
export function fileOfLink(href: string | undefined): string | null {
  if (!href) return null;
  const value = href.trim();
  if (!value || value.startsWith("#") || /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(value) || /^(?:mailto|tel|data|javascript):/i.test(value)) return null;
  let path = value.replace(/^file:\/{2,3}/i, "").replace(/#L?\d+.*$/i, "");
  try {
    path = decodeURIComponent(path);
  } catch {
    /* keep it as written */
  }
  path = path.replace(/:\d+(?::\d+)?$/, "");
  return path || null;
}

/** Inline code that names a file in a folder, such as `src/server/app.ts` or `client\src\App.tsx:12`. */
export function looksLikeFile(text: string): boolean {
  const value = text.trim();
  if (value.length > 300 || /\s/.test(value)) return false;
  return /[\\/]/.test(value) && /\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?$/.test(value) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

/**
 * The path inside the session folder, with forward slashes, or null when it lies outside it.
 * `cwd` is the session folder as the server reports it.
 */
export function insideFolder(path: string, cwd: string): string | null {
  let value = path.replace(/:\d+(?::\d+)?$/, "").replace(/\\/g, "/").trim();
  const root = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  const absolute = /^[a-z]:\//i.test(value) || value.startsWith("/");
  if (absolute) {
    if (!root || !(value.toLowerCase() === root.toLowerCase() || value.toLowerCase().startsWith(`${root.toLowerCase()}/`))) return null;
    value = value.slice(root.length);
  }
  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
}

let seq = 0;

export function requestOpenFile(path: string) {
  window.dispatchEvent(new CustomEvent<OpenFileRequest>(OPEN_FILE, { detail: { seq: ++seq, path } }));
}
