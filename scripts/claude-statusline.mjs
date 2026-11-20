#!/usr/bin/env node
// Claude Code status line for MirrorMix.
//
// Claude Code runs this script whenever it redraws its status line and passes it a JSON description of the session
// on stdin. For subscribers that includes rate_limits.five_hour / seven_day (used_percentage 0-100, resets_at in
// Unix seconds). The script keeps the latest of those in ~/.mirrormix/claude-usage.json for MirrorMix to read, and
// prints a short status line of its own.
//
// Set it up in ~/.claude/settings.json:
//   "statusLine": { "type": "command", "command": "node \"E:/Me/AIMiss/scripts/claude-statusline.mjs\"" }
//
// It only runs in Claude Code's terminal interface (`claude`, and the sessions MirrorMix starts), not inside the
// Claude desktop app.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function windowOf(value) {
  if (!value || typeof value !== "object") return null;
  const used = Number(value.used_percentage);
  const resets = Number(value.resets_at);
  if (!Number.isFinite(used)) return null;
  return { usedPercent: used, resetsAt: Number.isFinite(resets) ? resets * 1000 : null };
}

let input = {};
try {
  input = JSON.parse(readStdin() || "{}");
} catch {
  input = {};
}

const limits = input && typeof input === "object" ? input.rate_limits : null;
const fiveHour = windowOf(limits?.five_hour);
const sevenDay = windowOf(limits?.seven_day);

if (fiveHour || sevenDay) {
  const dir = path.join(os.homedir(), ".mirrormix");
  const file = path.join(dir, "claude-usage.json");
  try {
    mkdirSync(dir, { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ at: Date.now(), fiveHour, sevenDay }));
    renameSync(temp, file);
  } catch {
    /* the status line still prints */
  }
}

const parts = [];
const model = input?.model?.display_name;
if (typeof model === "string" && model) parts.push(model);
const folder = input?.workspace?.current_dir ?? input?.cwd;
if (typeof folder === "string" && folder) parts.push(path.basename(folder));
const clock = (ms) => {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};
if (fiveHour) parts.push(`5h ${Math.round(fiveHour.usedPercent)}%${fiveHour.resetsAt ? ` (${clock(fiveHour.resetsAt)} 重置)` : ""}`);
if (sevenDay) parts.push(`7d ${Math.round(sevenDay.usedPercent)}%`);
process.stdout.write(parts.join(" · "));
