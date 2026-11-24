import { useCallback, useEffect, useRef, useState } from "react";
import { api, type SessionStatus, type SessionWindow, type ToolId, type ToolPrompt, type TranscriptMessage } from "./api";
import { watchSession, type FeedLink } from "./sessionFeed";

/** Messages fetched per request, both for the first screen and for each step back in history. */
export const PAGE = 60;
/** Once the reader is back at the newest message, history beyond this is dropped from memory. */
const KEEP_AT_BOTTOM = 120;
const TRIM_ABOVE = 180;

export interface SessionMeta {
  id: string;
  tool: ToolId;
  title: string;
  workspacePath: string;
  status: SessionStatus;
  sendEnabled: boolean;
  attached: "process" | "claude" | "desktop";
  /** The desktop app could not take a message, so MirrorMix resumed the session in its own Claude Code. */
  takenOver?: boolean;
  /** The terminal is asking whether to trust the session folder. */
  question?: "trust";
  /** What the tool is waiting on the person for: a permission, a plan, a question. */
  prompt?: ToolPrompt;
  exitNote?: string;
  inputPrompt?: string;
  readOnlyReason?: string;
  model?: string;
  effort?: string;
  modelSwitch?: boolean;
  deletable?: boolean;
}

export interface SessionState {
  key: string;
  /** loading: nothing to show yet. missing: the server does not know this session. */
  phase: "loading" | "ready" | "missing";
  meta: SessionMeta | null;
  /** The part of the transcript held in memory: messages[0] is message number `offset` of `total`. */
  messages: TranscriptMessage[];
  offset: number;
  total: number;
  link: FeedLink;
  /** The process behind the session is being started or joined. */
  opening: boolean;
  openError: string | null;
  older: "idle" | "loading" | "failed";
}

const keyOf = (tool: ToolId, id: string) => `${tool}:${id}`;

function blank(key: string): SessionState {
  return {
    key,
    phase: "loading",
    meta: null,
    messages: [],
    offset: 0,
    total: 0,
    link: "connecting",
    opening: false,
    openError: null,
    older: "idle",
  };
}

function metaOf(frame: SessionWindow): SessionMeta {
  return {
    id: frame.id,
    tool: frame.tool,
    title: frame.title,
    workspacePath: frame.workspacePath,
    status: frame.status,
    sendEnabled: frame.sendEnabled,
    attached: frame.attached,
    takenOver: frame.takenOver,
    question: frame.question,
    prompt: frame.prompt,
    exitNote: frame.exitNote,
    inputPrompt: frame.inputPrompt,
    readOnlyReason: frame.readOnlyReason,
    model: frame.model,
    effort: frame.effort,
    modelSwitch: frame.modelSwitch,
    deletable: frame.deletable,
  };
}

/** Lays a page or a live patch over what is already held, keeping older messages that were loaded by hand. */
function applyFrame(state: SessionState, frame: SessionWindow, atBottom: boolean): SessionState {
  if (frame.status === "failed" && !frame.workspacePath && frame.total === 0 && state.phase !== "ready") {
    return { ...state, phase: "missing" };
  }
  const keep = frame.offset - state.offset;
  let messages: TranscriptMessage[];
  let offset: number;
  if (state.phase !== "ready" || keep < 0 || keep > state.messages.length) {
    messages = frame.messages;
    offset = frame.offset;
  } else if (keep === state.messages.length && frame.messages.length === 0) {
    messages = state.messages;
    offset = state.offset;
  } else {
    messages = state.messages.slice(0, keep).concat(frame.messages);
    offset = state.offset;
  }
  if (atBottom && messages.length > TRIM_ABOVE) {
    offset += messages.length - KEEP_AT_BOTTOM;
    messages = messages.slice(-KEEP_AT_BOTTOM);
  }
  return { ...state, phase: "ready", meta: metaOf(frame), messages, offset, total: frame.total };
}

export interface SessionHandle {
  target: { tool: ToolId; id: string } | null;
  state: SessionState | null;
  /** The message list keeps this up to date; history is only trimmed while it is true. */
  atBottom: React.MutableRefObject<boolean>;
  select(tool: ToolId, id: string, options?: { open?: boolean; seed?: SessionWindow }): void;
  clear(): void;
  close(): Promise<void>;
  loadOlder(): void;
  trim(): void;
}

export function useSession(): SessionHandle {
  const [target, setTarget] = useState<{ tool: ToolId; id: string } | null>(null);
  const [state, setState] = useState<SessionState | null>(null);
  const latest = useRef("");
  const stateRef = useRef<SessionState | null>(null);
  const atBottom = useRef(true);
  stateRef.current = state;

  /** Applies a change only if it belongs to the session on screen; late answers for an earlier one are dropped. */
  const update = useCallback((key: string, change: (state: SessionState) => SessionState) => {
    setState((previous) => {
      if (latest.current !== key) return previous;
      return change(previous && previous.key === key ? previous : blank(key));
    });
  }, []);

  const select = useCallback<SessionHandle["select"]>(
    (tool, id, options) => {
      const key = keyOf(tool, id);
      const same = latest.current === key;
      latest.current = key;
      if (!same) atBottom.current = true;
      setTarget((current) => (current && current.tool === tool && current.id === id ? current : { tool, id }));
      setState((previous) => {
        let next = same && previous?.key === key ? previous : blank(key);
        next = { ...next, opening: Boolean(options?.open), openError: null };
        if (options?.seed) next = applyFrame(next, options.seed, true);
        return next;
      });
      if (!options?.open) return;
      api.open(tool, id).then(
        (view) => update(key, (current) => ({ ...applyFrame(current, view, atBottom.current), opening: false })),
        (error: { code?: string }) =>
          update(key, (current) => ({ ...current, opening: false, openError: error.code ?? "failed" })),
      );
    },
    [update],
  );

  const clear = useCallback(() => {
    latest.current = "";
    setTarget(null);
    setState(null);
  }, []);

  useEffect(() => {
    if (!target) return;
    const key = keyOf(target.tool, target.id);
    return watchSession(target.tool, target.id,
      (frame) => update(key, (current) => applyFrame(current, frame, atBottom.current)),
      (link) => update(key, (current) => ({ ...current, link })),
    );
  }, [target, update]);

  const close = useCallback(async () => {
    const current = stateRef.current;
    if (!current?.meta) return;
    const view = await api.close(current.meta.tool, current.meta.id);
    update(current.key, (next) => applyFrame(next, view, atBottom.current));
  }, [update]);

  const loadOlder = useCallback(() => {
    const current = stateRef.current;
    if (!current?.meta || current.phase !== "ready" || current.offset === 0 || current.older === "loading") return;
    const { key, offset: before } = current;
    update(key, (next) => ({ ...next, older: "loading" }));
    api.page(current.meta.tool, current.meta.id, before, PAGE).then(
      (page) =>
        update(key, (next) =>
          next.offset !== before
            ? { ...next, older: "idle" }
            : { ...next, older: "idle", offset: page.offset, messages: page.messages.concat(next.messages) },
        ),
      () => update(key, (next) => ({ ...next, older: "failed" })),
    );
  }, [update]);

  const trim = useCallback(() => {
    const current = stateRef.current;
    if (!current || current.messages.length <= TRIM_ABOVE) return;
    update(current.key, (next) =>
      next.messages.length <= TRIM_ABOVE
        ? next
        : {
            ...next,
            offset: next.offset + next.messages.length - KEEP_AT_BOTTOM,
            messages: next.messages.slice(-KEEP_AT_BOTTOM),
          },
    );
  }, [update]);

  const live = state && target && state.key === keyOf(target.tool, target.id) ? state : null;
  return { target, state: live, atBottom, select, clear, close, loadOlder, trim };
}
