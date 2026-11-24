import { createHash } from "node:crypto";
import type { ToolPrompt } from "../shared/types";

/**
 * Claude Code and Codex ask in their terminal the same way: a question, what it is about, and a numbered menu with
 * the highlighted row marked by ❯ or ›, at the bottom of the screen.
 *
 *    Bash command
 *      npm test
 *    Do you want to proceed?
 *    ❯ 1. Yes
 *      2. Yes, and don't ask again for npm test commands in E:\work
 *      3. No, and tell Claude what to do differently (esc)
 *
 * The menu is read off the screen and answered with arrow keys and Enter, as a person would.
 */

const BOX = /[│┃║╭╮╰╯─━═┌┐└┘├┤┬┴┼╌╎▌▐]/g;
const OPTION = /^(?:([❯›>▶])\s*)?(\d{1,2})[.)]\s+(.+?)\s*$/;
/** The key hints under a menu: "Enter to select · ↑/↓ to navigate · Esc to cancel", "Press enter to confirm". */
const FOOTER = /^(?:enter to|press enter|esc to|tab\/arrow|↑|↓|\(?esc\)?|ctrl\+|shift\+tab|按 ?enter|回车)/i;
const SELECTED = /^\s*[❯›>▶]/;
const NO = /^(?:no\b|deny|reject|decline|cancel|don't|do not|skip|拒绝|否|不|取消)/i;
const YES = /^(?:yes\b|allow|approve|accept|proceed|run\b|continue|trust|是|允许|批准|同意|继续|运行)/i;
/** Claude Code's own "type your answer" row under an AskUserQuestion: it opens a text box, not an answer. */
const TYPE_SOMETHING = /^(?:type something|chat about this|other)\.?$/i;

interface Row {
  text: string;
  /** Where the line starts, after box borders: description lines sit further in than their option. */
  indent: number;
}

function clean(line: string): Row {
  const text = line.replace(BOX, " ").replace(/\s+$/, "");
  const indent = text.length - text.trimStart().length;
  return { text: text.trim(), indent };
}

interface Found {
  rows: Row[];
  /** Index in `rows` of each option, in menu order. */
  options: Array<{ at: number; number: string; label: string; description: string[]; selected: boolean }>;
  /** Index in `rows` of the first option. */
  start: number;
}

/** The menu at the bottom of the screen, if there is one: nothing but key hints and blank lines may follow it. */
function findMenu(lines: string[]): Found | null {
  const rows = lines.map(clean);
  let end = rows.length - 1;
  while (end >= 0 && (!rows[end].text || FOOTER.test(rows[end].text))) end--;
  if (end < 0) return null;
  // The last option, possibly followed by its own description lines.
  let last = end;
  for (let back = 0; last >= 0 && back < 4 && !OPTION.test(rows[last].text); back++) last--;
  if (last < 0 || !OPTION.test(rows[last].text)) return null;
  // Up from there while the lines are options or the descriptions under them.
  let start = last;
  for (let i = last - 1; i >= 0; i--) {
    const row = rows[i];
    if (OPTION.test(row.text)) {
      start = i;
      continue;
    }
    // A description line: indented past the option label above the run, and not blank.
    if (row.text && i > 0 && start - i <= 3) {
      const above = rows.slice(0, i).reverse().find((item) => OPTION.test(item.text));
      if (above && row.indent > above.indent && !/\?$|？$/.test(row.text)) continue;
    }
    break;
  }
  const options: Found["options"] = [];
  for (let i = start; i <= end; i++) {
    const match = OPTION.exec(rows[i].text);
    if (match) {
      options.push({ at: i, number: match[2], label: match[3].trim(), description: [], selected: Boolean(match[1]) || SELECTED.test(lines[i].replace(BOX, " ")) });
    } else if (rows[i].text && options.length) {
      options[options.length - 1].description.push(rows[i].text);
    }
  }
  // Numbered in order from 1: a numbered list in a reply is not a menu unless one row is highlighted.
  if (options.length < 2 || !options.some((option) => option.selected)) return null;
  if (options.some((option, index) => Number(option.number) !== index + 1)) return null;
  return { rows, options, start };
}

function kindOf(title: string, detail: string, labels: string[]): ToolPrompt["kind"] {
  const all = `${title}\n${detail}`;
  if (/trust (?:this|the files in this) folder|do you trust|是否信任/i.test(all)) return "trust";
  if (/plan|计划/i.test(title) && /approve|proceed|keep planning|继续|批准/i.test(`${title} ${labels.join(" ")}`)) return "plan";
  if (labels.some((label) => YES.test(label)) && labels.some((label) => NO.test(label))) return "permission";
  return "question";
}

/** Strips a trailing key hint from a label: "Yes, proceed (y)" → "Yes, proceed", "No (esc)" → "No". */
function plainLabel(label: string): string {
  return label.replace(/\s*\((?:[a-z]|esc|enter|shift\+tab|tab)\)\s*$/i, "").trim();
}

/** The question the terminal is asking, or null when its bottom is not a menu. */
export function readScreenPrompt(lines: string[]): ToolPrompt | null {
  const menu = findMenu(lines);
  if (!menu) return null;
  // Above the menu, back to the start of its card: a blank run of two lines, a box's top border, or 14 lines.
  const above: string[] = [];
  let blanks = 0;
  for (let i = menu.start - 1; i >= 0 && above.length < 14; i--) {
    const raw = lines[i];
    if (/[╭┌]/.test(raw)) break;
    const text = menu.rows[i].text;
    if (!text) {
      if (++blanks >= 2 && above.length) break;
      continue;
    }
    // The input line of the conversation above the card ends it too.
    if (/^[❯›>]\s*$/.test(text)) break;
    blanks = 0;
    above.unshift(text);
  }
  // The question is the last line ending in "?"; failing that, the line just above the menu.
  let titleAt = -1;
  for (let i = above.length - 1; i >= 0; i--) {
    if (/[?？]\s*$/.test(above[i])) {
      titleAt = i;
      break;
    }
  }
  if (titleAt < 0) titleAt = above.length - 1;
  const title = titleAt >= 0 ? above[titleAt] : "需要你选择";
  // What it is about: Codex puts it between the question and the menu ("$ npm run build"), Claude Code above the
  // question ("Bash command / npm test"). Lines above Codex's question are the reply before it, not part of the card.
  const before = titleAt > 0 ? above.slice(0, titleAt) : [];
  const after = titleAt >= 0 ? above.slice(titleAt + 1) : [];
  const header = before.length && /^[☐☒✔□■◻◼]\s*/.test(before[before.length - 1]) ? before.pop()!.replace(/^[☐☒✔□■◻◼]\s*/, "") : undefined;
  const detail = (after.length ? after : before).join("\n").trim();
  const options = menu.options
    .filter((option) => !TYPE_SOMETHING.test(option.label))
    .map((option) => {
      const label = plainLabel(option.label);
      return {
        id: option.number,
        label,
        ...(option.description.length ? { description: option.description.join(" ") } : {}),
        ...(NO.test(label) ? { tone: "no" as const } : YES.test(label) ? { tone: "yes" as const } : {}),
      };
    });
  if (options.length < 1) return null;
  const kind = kindOf(title, detail, options.map((option) => option.label));
  const id = createHash("sha1")
    .update([title, detail, ...options.map((option) => `${option.id}:${option.label}`)].join("\n"))
    .digest("hex")
    .slice(0, 12);
  return { id, kind, title, ...(detail ? { detail } : {}), ...(header ? { header } : {}), options, via: "terminal" };
}

/**
 * The keys that pick `optionId` in the menu on screen: arrows from the highlighted row, then Enter. Null when the menu
 * is gone or changed since `promptId` was read.
 */
export function screenAnswerKeys(lines: string[], promptId: string, optionId: string): string | null {
  const prompt = readScreenPrompt(lines);
  if (!prompt || prompt.id !== promptId) return null;
  const menu = findMenu(lines)!;
  const wanted = menu.options.findIndex((option) => option.number === optionId);
  if (wanted < 0) return null;
  const from = Math.max(0, menu.options.findIndex((option) => option.selected));
  const step = wanted >= from ? "\u001b[B" : "\u001b[A";
  return step.repeat(Math.abs(wanted - from)) + "\r";
}
