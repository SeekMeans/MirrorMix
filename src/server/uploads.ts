import { randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync, rmSync } from "node:fs";
import type http from "node:http";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

/**
 * Files and pictures added to a message from the page. Each is saved on this computer as it is added, and the message
 * that goes out names it by its full path, so every AI tool reads it with its own tools (Claude Code, Codex, Cursor and
 * DSH all read files and images by path, through the desktop window or the command line alike).
 */

export const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

/** A name safe on Windows: no folders, no reserved characters, not empty, not too long. */
export function safeFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  let name = base.replace(/[<>:"|?*\u0000-\u001f]/g, "_").replace(/^[. ]+|[. ]+$/g, "").trim();
  if (!name || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name)) name = `file${name ? `-${name}` : ""}`;
  const extension = path.extname(name).slice(0, 16);
  const stem = name.slice(0, name.length - path.extname(name).length).slice(0, 80) || "file";
  return `${stem}${extension}`;
}

export function isImageName(name: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase());
}

export interface SavedUpload {
  path: string;
  name: string;
  size: number;
  image: boolean;
}

export class UploadError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

/** Saves the request body under `<root>/<yyyy-mm-dd>/<random>-<name>`. A body over the limit is refused and removed. */
export async function saveUpload(root: string, rawName: string, body: http.IncomingMessage, now = new Date()): Promise<SavedUpload> {
  const declared = Number(body.headers["content-length"] ?? NaN);
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) throw new UploadError(413, "too_large");
  const name = safeFileName(rawName);
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const folder = path.join(root, day);
  mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${randomBytes(4).toString("hex")}-${name}`);
  let size = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) callback(new UploadError(413, "too_large"));
      else callback(null, chunk);
    },
  });
  try {
    await pipeline(body, counter, createWriteStream(file, { flags: "wx" }));
  } catch (error) {
    rmSync(file, { force: true });
    if (error instanceof UploadError) throw error;
    throw new UploadError(400, "upload_failed");
  }
  if (size === 0) {
    rmSync(file, { force: true });
    throw new UploadError(400, "empty_file");
  }
  return { path: file, name, size, image: isImageName(name) };
}
