import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { COMMIT_MESSAGE_TOKEN, DEFAULT_SHORTCUTS, type Shortcut, type ShortcutLibrary } from "../shared/shortcuts";

export class CommandError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

const MESSAGE_COMMAND = `git commit -m "${COMMIT_MESSAGE_TOKEN}"`;

function validate(value: unknown): Shortcut[] {
  if (!Array.isArray(value) || value.length > 200) throw new CommandError(400, "commands_invalid");
  const seen = new Set<string>();
  return value.map(item => {
    if (!item || typeof item !== "object") throw new CommandError(400, "commands_invalid");
    const row = item as Record<string, unknown>;
    if (typeof row.group !== "string" || typeof row.name !== "string" || typeof row.command !== "string") throw new CommandError(400, "commands_invalid");
    const command = { group: row.group.trim(), name: row.name.trim(), command: row.command.trim() };
    if (!command.group || !command.name || !command.command || command.group.length > 80 || command.name.length > 80 || command.command.length > 10_000 || /[\x00-\x1f]/.test(command.group + command.name + command.command)) throw new CommandError(400, "commands_invalid");
    const key = JSON.stringify([command.group, command.name]);
    if (seen.has(key)) throw new CommandError(400, "commands_duplicate");
    seen.add(key);
    if (command.command.replaceAll(MESSAGE_COMMAND, "").includes("{{")) throw new CommandError(400, "commands_template");
    return command;
  });
}

/** The message used when none is given: local time and this computer's name, e.g. "2026-11-24 15:30:05 DESKTOP-A1". */
export function defaultCommitMessage(now = new Date(), host = os.hostname()): string {
  const two = (value: number) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}:${two(now.getMinutes())}:${two(now.getSeconds())}`;
  const name = host.replace(/[\x00-\x1f]/g, "").trim();
  return name ? `${stamp} ${name}` : stamp;
}

/** Only prepares terminal input. Nothing is executed by the HTTP request. */
export function prepareShortcut(command: string, message: unknown, nodeExe = process.execPath, now = new Date()): string {
  if (!command.includes(COMMIT_MESSAGE_TOKEN)) return command;
  if (message !== undefined && typeof message !== "string") throw new CommandError(400, "commands_message");
  const text = (typeof message === "string" ? message.trim() : "") || defaultCommitMessage(now);
  if (text.length > 1000 || /[\x00-\x1f]/.test(text)) throw new CommandError(400, "commands_message");
  const helper = fileURLToPath(new URL("../process/commitMessage.cjs", import.meta.url));
  if (/["%!\r\n]/.test(nodeExe + helper)) throw new CommandError(500, "commands_node_path");
  // The message travels as base64, then as a native Git argv value. CMD never parses user text.
  const call = `"${nodeExe}" "${helper}" "${Buffer.from(text, "utf8").toString("base64")}"`;
  return command.replaceAll(MESSAGE_COMMAND, call);
}

export interface CommandStore {
  read(): ShortcutLibrary;
  write(value: unknown, revision: unknown): ShortcutLibrary;
  prepare(group: unknown, name: unknown, message: unknown, revision: unknown): string;
}

export function createCommandStore(file: string): CommandStore {
  const read = (): ShortcutLibrary => {
    let text: string;
    try {
      if (statSync(file).size > 2 * 1024 * 1024) throw new CommandError(400, "commands_invalid");
      text = readFileSync(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(path.dirname(file), { recursive: true });
      try { writeFileSync(file, `${JSON.stringify(DEFAULT_SHORTCUTS, null, 2)}\n`, { flag: "wx" }); }
      catch (writeError) { if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError; }
      return read();
    }
    let commands: Shortcut[];
    try { commands = validate(JSON.parse(text.replace(/^\uFEFF/, ""))); }
    catch (error) { if (error instanceof CommandError) throw error; throw new CommandError(400, "commands_invalid"); }
    return { commands, file, revision: createHash("sha256").update(text).digest("hex") };
  };
  const current = (revision: unknown) => {
    const library = read();
    if (revision !== library.revision) throw new CommandError(409, "commands_changed");
    return library;
  };
  return {
    read,
    write(value, revision) {
      const commands = validate(value);
      current(revision);
      writeFileSync(file, `${JSON.stringify(commands, null, 2)}\n`);
      return read();
    },
    prepare(group, name, message, revision) {
      const entry = current(revision).commands.find(row => row.group === group && row.name === name);
      if (!entry) throw new CommandError(404, "commands_missing");
      return prepareShortcut(entry.command, message);
    },
  };
}
