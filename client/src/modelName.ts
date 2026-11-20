const WORDS: Record<string, string> = {
  gpt: "GPT",
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
  fable: "Fable",
  claude: "Claude",
  codex: "Codex",
  composer: "Composer",
  gemini: "Gemini",
  grok: "Grok",
  mini: "mini",
  default: "自动",
};

/**
 * A model id as people say it: `claude-opus-5-5` → `Opus 5.5`, `claude-sonnet-4-5-20250929` → `Sonnet 4.5`,
 * `gpt-6.1-sol` → `GPT 6.1 Sol`, `claude-opus-5-5[1m]` → `Opus 5.5 1M`.
 */
export function modelName(id: string): string {
  let rest = id.trim();
  if (!rest) return "";
  const wide = /\[1m\]$/i.test(rest);
  rest = rest.replace(/\[1m\]$/i, "").replace(/^claude-/i, "").replace(/-\d{8}$/, "");
  const parts: string[] = [];
  for (const token of rest.split("-").filter(Boolean)) {
    const previous = parts[parts.length - 1];
    // Version numbers are written with dashes in the id: 5-5 is 5.5.
    if (/^\d+$/.test(token) && previous !== undefined && /^\d+(\.\d+)*$/.test(previous)) {
      parts[parts.length - 1] = `${previous}.${token}`;
      continue;
    }
    const known = WORDS[token.toLowerCase()];
    parts.push(known ?? (/^[a-z]/.test(token) ? token[0].toUpperCase() + token.slice(1) : token));
  }
  return parts.join(" ") + (wide ? " 1M" : "");
}

/** Which of the `/model` aliases a full id belongs to, so the menu can tick it. */
export function modelFamily(id: string): string {
  const found = id.toLowerCase().match(/\b(opus|sonnet|haiku|fable)\b/);
  return found?.[1] ?? "";
}
