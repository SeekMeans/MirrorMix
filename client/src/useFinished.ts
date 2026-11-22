import { useEffect, useRef, useState } from "react";
import { ALL_TOOLS, type Catalog, type ToolId } from "./api";

const FINISHED_KEY = "mirrormix.finished";
const WORKING_KEY = "mirrormix.working";

function readFinished(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(FINISHED_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

function saveFinished(keys: Set<string>) {
  try {
    localStorage.setItem(FINISHED_KEY, JSON.stringify([...keys]));
  } catch {
    /* private mode: the list just lasts for this visit */
  }
}

/**
 * The sessions replying when this page last looked. A phone browser often drops a page left in the background, so a
 * reply that finishes meanwhile is still caught when the page loads again.
 */
function readWorking(): Set<string> | null {
  try {
    const saved = localStorage.getItem(WORKING_KEY);
    return saved ? new Set(JSON.parse(saved) as string[]) : null;
  } catch {
    return null;
  }
}

function saveWorking(keys: Set<string>) {
  try {
    localStorage.setItem(WORKING_KEY, JSON.stringify([...keys]));
  } catch {
    /* private mode */
  }
}

/** Opening a completed conversation is enough to acknowledge its reply. */
export function clearFinishedOnView(finished: Set<string>, viewing: string): Set<string> {
  if (!viewing || !finished.has(viewing)) return finished;
  const next = new Set(finished);
  next.delete(viewing);
  return next;
}

/** Codex can be read in its own desktop app; its unread flag changing to off acknowledges the same reply here. */
export function clearFinishedAfterNativeRead(
  finished: Set<string>,
  previouslyUnread: Set<string>,
  unread: Set<string>,
  known: Set<string>,
): Set<string> {
  let next: Set<string> | null = null;
  for (const key of finished) {
    if (!known.has(key) || !previouslyUnread.has(key) || unread.has(key)) continue;
    if (!next) next = new Set(finished);
    next.delete(key);
  }
  return next ?? finished;
}

/**
 * Sessions whose reply finished while this page watched, keyed `tool:id`. They stay in the running list
 * until the person opens them. `viewing` is the session on screen, or "" for none.
 */
export function useFinished(catalog: Catalog | null, viewing: string): Set<string> {
  const [finished, setFinished] = useState(readFinished);
  const working = useRef<Set<string> | null>(readWorking());
  const unread = useRef<Set<string> | null>(null);
  const viewingRef = useRef(viewing);
  viewingRef.current = viewing;

  useEffect(() => {
    if (!catalog) return;
    const now = new Set<string>();
    const known = new Set<string>();
    const unreadNow = new Set<string>();
    // A tool with no groups may just be closed; its sessions are not taken for gone.
    const listed = new Set(ALL_TOOLS.filter((tool) => catalog[tool].length > 0));
    for (const tool of ALL_TOOLS) {
      for (const group of catalog[tool]) {
        for (const session of group.sessions) {
          const key = `${tool}:${session.id}`;
          known.add(key);
          if (session.working) now.add(key);
          if (session.unseen) unreadNow.add(key);
        }
      }
    }
    const before = working.current;
    const unreadBefore = unread.current;
    working.current = now;
    saveWorking(now);
    unread.current = unreadNow;
    setFinished((current) => {
      const next = new Set(current);
      if (before) for (const key of before) if (!now.has(key) && known.has(key) && key !== viewingRef.current) next.add(key);
      for (const key of now) next.delete(key);
      for (const key of next) {
        const tool = key.slice(0, key.indexOf(":")) as ToolId;
        if (listed.has(tool) && !known.has(key)) next.delete(key);
      }
      const acknowledged = unreadBefore ? clearFinishedAfterNativeRead(next, unreadBefore, unreadNow, known) : next;
      if (acknowledged.size === current.size && [...acknowledged].every((key) => current.has(key))) return current;
      saveFinished(acknowledged);
      return acknowledged;
    });
  }, [catalog]);

  // A completed reply is seen as soon as its conversation is opened.
  useEffect(() => {
    setFinished((current) => {
      const next = clearFinishedOnView(current, viewing);
      if (next === current) return current;
      saveFinished(next);
      return next;
    });
  }, [viewing]);

  return finished;
}
