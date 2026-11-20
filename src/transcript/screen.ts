const NUMBERED_CHOICE = /^\s*(?:[›❯>]\s*)?\d+\.\s+\S/;

export function screenAllowsInput(lines: string[]): boolean {
  if (lines.some((line) => /This conversation is open in another app|Not logged in.*(?:\/login|Please run)/i.test(line))) return false;
  // Numbered lists in an earlier answer do not block the composer below them.
  let prompt = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*[›❯>]/.test(lines[i]) && !NUMBERED_CHOICE.test(lines[i])) { prompt = i; break; }
  }
  return !lines.slice(prompt + 1).some((line) => NUMBERED_CHOICE.test(line));
}

/** Claude Code started without a sign-in: its login menu, or a reply refused for want of one. */
const LOGIN = /Select login method|Anthropic Console account|Claude account with subscription|Please run \/login|Invalid API key|Not logged in/i;

export function asksForLogin(lines: string[]): boolean {
  return lines.some((line) => LOGIN.test(line));
}

/** Claude Code and Codex both stop on this before anything else, the first time their CLI runs in a folder. */
const TRUST_QUESTION = /trust this folder|trust the files in this folder|do you trust|是否信任/i;
const TRUST_YES = /yes,? (?:i trust|proceed)|trust and continue/i;
const TRUST_NO = /no,? exit|^\s*(?:[❯›>]\s*)?(?:\d+\.\s*)?(?:back|exit|quit)\b/i;
const SELECTED = /^\s*[❯›>]/;

export function asksForTrust(lines: string[]): boolean {
  return lines.some((line) => TRUST_QUESTION.test(line)) && lines.some((line) => TRUST_YES.test(line));
}

/**
 * The keys that pick an answer in the trust menu: arrows from the highlighted row to the wanted one, then Enter.
 * Null when the menu is not on screen or the answer is not one of its rows.
 */
export function trustKeys(lines: string[], answer: "trust" | "cancel"): string | null {
  if (!asksForTrust(lines)) return null;
  const options = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => TRUST_YES.test(line) || TRUST_NO.test(line) || SELECTED.test(line));
  const selected = options.findIndex(({ line }) => SELECTED.test(line));
  const wanted = options.findIndex(({ line }) => (answer === "trust" ? TRUST_YES : TRUST_NO).test(line));
  if (wanted < 0) return null;
  const from = selected < 0 ? 0 : selected;
  const step = wanted >= from ? "\u001b[B" : "\u001b[A";
  return step.repeat(Math.abs(wanted - from)) + "\r";
}
