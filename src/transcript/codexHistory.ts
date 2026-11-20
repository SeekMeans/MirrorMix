import { readFileSync, statSync } from "node:fs";
import path from "node:path";

interface Meta {
  ordinal?: number;
  payload?: { id?: string; history_base?: { thread_id?: string; end_ordinal_exclusive?: number } };
}

function metadata(content: string): Meta {
  try { return JSON.parse(content.split("\n", 1)[0]) as Meta; } catch { return {}; }
}

export function transcriptStamp(file: string): string {
  try {
    const stat = statSync(file);
    return `${file}\0${stat.mtimeMs}\0${stat.size}`;
  } catch { return `${file}\0missing`; }
}

/** A resumed desktop rollout may only contain the tail; history_base identifies its older prefix. */
export function readCodexHistory(file: string, candidates: string[]): string {
  const visiting = new Set<string>();
  const contents = new Map<string, string>();
  const load = (target: string) => {
    if (!contents.has(target)) contents.set(target, readFileSync(target, "utf8"));
    return contents.get(target)!;
  };
  const assemble = (target: string): string => {
    const content = load(target);
    const meta = metadata(content);
    const base = meta.payload?.history_base;
    if (!base?.thread_id || !Number.isSafeInteger(base.end_ordinal_exclusive) || base.end_ordinal_exclusive! <= 0) return content;
    const cutoff = base.end_ordinal_exclusive!;
    visiting.add(target);
    const parents = candidates.flatMap((candidate) => {
      if (visiting.has(candidate) || !path.basename(candidate).includes(base.thread_id!)) return [];
      try {
        const source = metadata(load(candidate));
        if (source.payload?.id !== base.thread_id || typeof source.ordinal !== "number" || source.ordinal >= cutoff) return [];
        return [{ file: candidate, start: source.ordinal }];
      } catch { return []; }
    }).sort((a, b) => b.start - a.start);
    const parent = parents[0];
    if (!parent) return content;
    const prefix = assemble(parent.file).split("\n").filter((line) => {
      try {
        const row = JSON.parse(line) as { ordinal?: number };
        return typeof row.ordinal === "number" && row.ordinal < cutoff;
      } catch { return false; }
    });
    return [...prefix, content].join("\n");
  };
  return assemble(file);
}
