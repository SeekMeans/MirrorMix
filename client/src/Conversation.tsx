import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { TranscriptMessage } from "./api";
import { CloseIcon, DownIcon, FileIcon, ImageIcon, PlusIcon, SendIcon, Spinner } from "./icons";
import { api, type SlashCommand } from "./api";

const SOURCE_LABEL: Record<SlashCommand["source"], string> = { builtin: "内置", user: "我的", project: "项目", skill: "技能" };

/** The "/" menu's entries for what has been typed after the slash: names starting with it first, then containing it. */
function matchCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const wanted = query.toLowerCase();
  const name = (command: SlashCommand) => command.name.toLowerCase();
  // A plugin's skill is "plugin:skill": typing the skill's own name finds it next, as Claude Code's menu does.
  const own = (command: SlashCommand) => name(command).slice(name(command).indexOf(":") + 1);
  const starts = commands.filter((command) => name(command).startsWith(wanted));
  const skillStarts = commands.filter((command) => !name(command).startsWith(wanted) && name(command).includes(":") && own(command).startsWith(wanted));
  const contains = commands.filter(
    (command) => !starts.includes(command) && !skillStarts.includes(command) && name(command).includes(wanted),
  );
  return [...starts, ...skillStarts, ...contains];
}
import { MarkdownMessage } from "./MarkdownMessage";
import { CursorThread } from "./CursorThread";
import { FlavorContext, RoundRow, StepRow, ThinkingRow, useMarks } from "./Transcript";
import { PAGE, type SessionHandle, type SessionState } from "./useSession";

const LONG_USER_TEXT = 1500;

const MessageRow = memo(function MessageRow({ message }: { message: TranscriptMessage }) {
  const [expanded, setExpanded] = useState(false);
  const marks = useMarks();
  if (message.role === "step") return <StepRow step={message} />;
  if (message.role === "thinking") return <ThinkingRow message={message} />;
  if (message.role === "turn") return <RoundRow round={message} />;
  if (message.role === "assistant") {
    return (
      <article className="message assistant">
        <span className="cc-bullet" aria-hidden="true">{marks.bullet}</span>
        <MarkdownMessage text={message.text} />
      </article>
    );
  }
  const long = message.text.length > LONG_USER_TEXT;
  const queued = message.id.startsWith("queued-");
  const pending = message.id === "pending-user" || queued;
  return (
    <article className={pending ? "message user pending" : "message user"}>
      <span className="cc-prompt" aria-hidden="true">{marks.prompt}</span>
      <div className="user-copy">
        {queued && <span className="queue-mark">排队</span>}
        {long && !expanded ? `${message.text.slice(0, LONG_USER_TEXT)}…` : message.text}
        {long && (
          <button type="button" className="link-button unfold" onClick={() => setExpanded((open) => !open)}>
            {expanded ? "收起" : `展开全文（${message.text.length} 字）`}
          </button>
        )}
      </div>
    </article>
  );
});

/** What a tool call counts as in the one-line summary of a run of calls. */
const KINDS: Array<{ match: RegExp; one: string; many: string }> = [
  { match: /^(Bash|PowerShell|Ran)$/, one: "ran a command", many: "ran {n} commands" },
  { match: /^Read$/, one: "read a file", many: "read {n} files" },
  { match: /^(Update|Edited)$/, one: "edited a file", many: "edited {n} files" },
  { match: /^Write$/, one: "created a file", many: "created {n} files" },
  { match: /^(Search|Searched)$/, one: "searched once", many: "searched {n} times" },
  { match: /^(Web Search|Fetch)$/, one: "looked up a page", many: "looked up {n} pages" },
  { match: /^(Update Todos|Updated Plan)$/, one: "updated the plan", many: "updated the plan {n} times" },
];
const OTHER = { one: "used a tool", many: "used {n} tools" };

/** "Ran 3 commands, read 2 files (1 failed)": the kinds in the order they first appear. */
export function summarizeSteps(steps: TranscriptMessage[]): string {
  const counts = new Map<{ one: string; many: string }, number>();
  let failed = 0;
  for (const step of steps) {
    if (step.role !== "step") continue;
    const kind = KINDS.find((entry) => entry.match.test(step.tool ?? "")) ?? OTHER;
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    if (step.result?.status === "error") failed += 1;
  }
  const parts = [...counts].map(([kind, count]) => (count === 1 ? kind.one : kind.many.replace("{n}", String(count))));
  const text = parts.join(", ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}${failed ? ` (${failed} failed)` : ""}`;
}

type Block = { kind: "message"; message: TranscriptMessage } | { kind: "steps"; id: string; items: TranscriptMessage[] };

/**
 * A run of tool calls, with any reasoning between them, becomes one foldable block.
 * The task list is not part of that: while a round is running, its latest list is a card under the reply,
 * always in view. Once the round is over the card goes away.
 */
function blocksOf(messages: TranscriptMessage[]): Block[] {
  const blocks: Block[] = [];
  let run: TranscriptMessage[] = [];
  let tasks: TranscriptMessage | null = null;
  const placeTasks = () => {
    if (tasks) blocks.push({ kind: "message", message: tasks });
    tasks = null;
  };
  const flush = () => {
    if (!run.length) return;
    // Reasoning after the last call belongs to the reply that follows, not to the folded run.
    let end = run.length;
    while (end > 0 && run[end - 1].role !== "step") end -= 1;
    if (end > 0) blocks.push({ kind: "steps", id: run[0].id, items: run.slice(0, end) });
    for (const message of run.slice(end)) blocks.push({ kind: "message", message });
    run = [];
  };
  for (const message of messages) {
    if (message.role === "step" && message.result?.todos) {
      // Only the newest state of the list matters; an update that empties it takes the card away.
      tasks = message.result.todos.length ? message : null;
    } else if (message.role === "step" || (message.role === "thinking" && run.length > 0)) run.push(message);
    else {
      flush();
      // The card sits at the foot of a round that is still running, above the line that shows its clock.
      // A round that has ended, or one the person has already answered, no longer shows it.
      if (message.role === "turn" && !message.endedAt) placeTasks();
      else if (message.role === "turn" || message.role === "user") tasks = null;
      blocks.push({ kind: "message", message });
    }
  }
  flush();
  return blocks;
}

const StepGroup = memo(
  function StepGroup({ items }: { items: TranscriptMessage[] }) {
    const [open, setOpen] = useState(false);
    const running = items.filter((item) => item.role === "step" && item.result?.status === "running");
    const failed = items.some((item) => item.result?.status === "error");
    return (
      <div className="cc-step step-group">
        <button
          type="button"
          className={`cc-call step-group-head${running.length ? " is-running" : failed ? " is-error" : ""}`}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="cc-dot" aria-hidden="true">●</span>
          <span className="cc-call-text">{summarizeSteps(items)}</span>
          <span className={open ? "step-group-caret open" : "step-group-caret"} aria-hidden="true">›</span>
        </button>
        {open ? (
          <div className="step-group-body">
            {items.map((item) => (
              <MessageRow key={item.id} message={item} />
            ))}
          </div>
        ) : (
          // While folded, the call that is still running stays in view so progress is visible.
          running.length > 0 && (
            <div className="step-group-body">
              {running.map((item) => (
                <MessageRow key={item.id} message={item} />
              ))}
            </div>
          )
        )}
      </div>
    );
  },
  (before, after) => before.items.length === after.items.length && before.items.every((item, index) => item === after.items[index]),
);

function Skeleton() {
  return (
    <div className="skeleton" role="status">
      <span className="visually-hidden">正在读取会话</span>
      <span className="bone right" style={{ width: "38%" }} />
      <span className="bone" style={{ width: "92%" }} />
      <span className="bone" style={{ width: "84%" }} />
      <span className="bone" style={{ width: "57%" }} />
      <span className="bone right" style={{ width: "26%" }} />
      <span className="bone" style={{ width: "88%" }} />
      <span className="bone" style={{ width: "71%" }} />
    </div>
  );
}

export function MessageList({ session, state }: { session: SessionHandle; state: SessionState }) {
  const scroller = useRef<HTMLDivElement>(null);
  const column = useRef<HTMLDivElement>(null);
  const olderRow = useRef<HTMLDivElement>(null);
  const previous = useRef({ key: "", offset: 0, height: 0 });
  const [away, setAway] = useState(false);
  const { atBottom, loadOlder, trim } = session;

  // Keep the reader where they were: glued to the newest message, or on the same line when history is added above.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const before = previous.current;
    if (before.key !== state.key) {
      atBottom.current = true;
      setAway(false);
    }
    if (atBottom.current) element.scrollTop = element.scrollHeight;
    else if (before.key === state.key && state.offset < before.offset) {
      element.scrollTop += element.scrollHeight - before.height;
    }
    previous.current = { key: state.key, offset: state.offset, height: element.scrollHeight };
  }, [state.key, state.messages, state.offset, state.phase, state.older, atBottom]);

  // Late layout changes (images, fonts, window resize) should not unstick the view from the bottom.
  useEffect(() => {
    const element = scroller.current;
    const inner = column.current;
    if (!element || !inner) return;
    const observer = new ResizeObserver(() => {
      if (atBottom.current) element.scrollTop = element.scrollHeight;
      previous.current.height = element.scrollHeight;
    });
    observer.observe(inner);
    observer.observe(element);
    return () => observer.disconnect();
  }, [atBottom]);

  // Reaching the top asks for the previous page.
  const canLoadOlder = state.phase === "ready" && state.offset > 0 && state.older === "idle";
  useEffect(() => {
    const root = scroller.current;
    const marker = olderRow.current;
    if (!canLoadOlder || !root || !marker) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadOlder();
      },
      { root, rootMargin: "240px 0px 0px 0px" },
    );
    observer.observe(marker);
    return () => observer.disconnect();
  }, [canLoadOlder, state.key, state.offset, loadOlder]);

  const onScroll = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    const bottom = element.scrollHeight - element.scrollTop - element.clientHeight < 64;
    if (bottom && !atBottom.current) trim();
    atBottom.current = bottom;
    setAway(!bottom);
    // Scroll events are the dependable trigger; the observer above covers lists too short to scroll.
    if (element.scrollTop < 320) loadOlder();
  }, [atBottom, trim, loadOlder]);

  const jump = () => {
    const element = scroller.current;
    if (!element) return;
    atBottom.current = true;
    element.scrollTop = element.scrollHeight;
    setAway(false);
    trim();
  };

  const olderCount = Math.min(PAGE, state.offset);
  const blocks = useMemo(() => blocksOf(state.messages), [state.messages]);

  return (
    <div className="messages-wrap">
      <div className="messages" ref={scroller} onScroll={onScroll}>
        <div className="column" ref={column}>
          {state.phase === "loading" && <Skeleton />}
          {state.phase === "missing" && (
            <p className="blank">这条会话已经不在了。它可能被归档或删除，从左侧换一条。</p>
          )}
          {state.phase === "ready" && (
            <>
              <div className="older" ref={olderRow}>
                {state.offset > 0 && state.older === "loading" && (
                  <span className="older-status" role="status">
                    <Spinner />
                    正在读取更早的 {olderCount} 条
                  </span>
                )}
                {state.offset > 0 && state.older === "idle" && (
                  <button type="button" className="link-button" onClick={loadOlder}>
                    读取更早的 {olderCount} 条（前面还有 {state.offset} 条）
                  </button>
                )}
                {state.offset > 0 && state.older === "failed" && (
                  <button type="button" className="link-button is-warning" onClick={loadOlder}>
                    更早的消息没有读到，再试一次
                  </button>
                )}
                {state.offset === 0 && state.total > 0 && <span className="older-status">会话从这里开始</span>}
              </div>
              {state.total === 0 && <p className="blank">这条会话还没有消息。在下面写第一句话。</p>}
              {state.meta?.tool === "cursor" ? (
                <CursorThread messages={state.messages} />
              ) : (
                /* Each tool's transcript is drawn with that tool's own terminal marks. */
                <FlavorContext.Provider value={state.meta?.tool === "codex" ? "codex" : "claude"}>
                  {blocks.map((block) =>
                    block.kind === "steps" ? (
                      <StepGroup key={`steps-${block.id}`} items={block.items} />
                    ) : (
                      <MessageRow key={block.message.id} message={block.message} />
                    ),
                  )}
                </FlavorContext.Provider>
              )}
            </>
          )}
        </div>
      </div>
      {away && state.phase === "ready" && (
        <button type="button" className="jump" onClick={jump}>
          <DownIcon />
          回到最新
        </button>
      )}
    </div>
  );
}

const drafts = new Map<string, string>();

/** A file or picture added to the message: uploaded at once, named by its path in the message that goes out. */
interface Attachment {
  key: string;
  name: string;
  image: boolean;
  /** A local preview of a picture, shown until the message goes. */
  preview?: string;
  status: "uploading" | "done" | "error";
  path?: string;
  error?: string;
}

const attached = new Map<string, Attachment[]>();
let attachmentSeq = 0;

const UPLOAD_ERRORS: Record<string, string> = {
  too_large: "超过 30 MB",
  empty_file: "是空文件",
};

/** The message as sent: the words, then each attachment's full path on a line, so the AI opens them itself. */
export function withAttachments(text: string, paths: Array<{ path: string; image: boolean }>): string {
  if (!paths.length) return text;
  const lines = paths.map((item) => `${item.image ? "[图片]" : "[文件]"} ${item.path}`).join("\n");
  const words = text.trim();
  return words ? `${words}\n\n附件：\n${lines}` : `请查看附件：\n${lines}`;
}

/** A pasted picture has no name of its own; it gets one from the time it was pasted. */
function pastedName(file: File): string {
  if (file.name && file.name !== "image.png") return file.name;
  const now = new Date();
  const stamp = [now.getHours(), now.getMinutes(), now.getSeconds()].map((part) => String(part).padStart(2, "0")).join("");
  const extension = (file.type.split("/")[1] || "png").replace("jpeg", "jpg").replace(/[^a-z0-9]/gi, "");
  return `粘贴图片-${stamp}.${extension}`;
}

/** Mount with `key={session key}` so each session keeps its own unsent text. */
export function Composer({
  sessionKey,
  enabled,
  placeholder,
  queue,
  onSend,
  onSendNow,
  loadCommands,
  tools,
  busy = false,
  stopping = false,
  onStop,
  mobile = false,
  clearOnSend = false,
  respondingPlaceholder,
}: {
  sessionKey: string;
  /** A reply is under way: a stop button shows beside send. */
  busy?: boolean;
  stopping?: boolean;
  onStop?: () => void;
  /** Shown at the bottom left while the box has focus, opposite the send button: the model picker. */
  tools?: ReactNode;
  enabled: boolean;
  placeholder: string;
  /** Touch keyboards: return adds a line, the button sends, and the keyboard stays up after sending. */
  mobile?: boolean;
  /** Clear before delivery resolves; a failed delivery restores the draft. */
  clearOnSend?: boolean;
  /** Replaces the normal hint while this composer is sending or receiving. */
  respondingPlaceholder?: string;
  /** Follow-ups waiting in Cursor's queue, shown above the input the way that client does. */
  queue?: string[];
  onSend: (text: string) => Promise<boolean>;
  /** Interrupts the running reply and sends this queued line, the way Cursor's Send now does. */
  onSendNow?: (text: string) => Promise<boolean>;
  /** The session's slash commands, asked for the first time a message starts with "/". */
  loadCommands?: () => Promise<SlashCommand[]>;
}) {
  const [draft, setDraft] = useState(() => drafts.get(sessionKey) ?? "");
  const [attachments, setAttachmentsState] = useState<Attachment[]>(() => attached.get(sessionKey) ?? []);
  const setAttachments = (update: (current: Attachment[]) => Attachment[]) => {
    setAttachmentsState((current) => {
      const next = update(current);
      if (next.length) attached.set(sessionKey, next);
      else attached.delete(sessionKey);
      return next;
    });
  };
  const [addOpen, setAddOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const addMenu = useRef<HTMLDivElement>(null);
  const uploading = attachments.some((item) => item.status === "uploading");
  const ready = attachments.filter((item) => item.status === "done" && item.path);
  const [sending, setSending] = useState(false);
  const [sendingNow, setSendingNow] = useState<string | null>(null);
  const canSend = enabled && !sending && !uploading && (Boolean(draft.trim()) || ready.length > 0);
  /** Focus is somewhere in the box: the text, the model picker or its menu. The box then opens to two rows. */
  const [focused, setFocused] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  // A press outside closes it. Some browsers (Safari) do not focus a clicked button, so focus alone cannot tell.
  useEffect(() => {
    if (!focused) return;
    const onPointer = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) setFocused(false);
    };
    window.addEventListener("pointerdown", onPointer);
    return () => window.removeEventListener("pointerdown", onPointer);
  }, [focused]);
  /** Two rows (the text, then the model picker and send). A computer has the room for it always; a phone only while typing. */
  const open = focused || !mobile;
  const field = useRef<HTMLTextAreaElement>(null);
  const [commands, setCommands] = useState<SlashCommand[] | null>(null);
  const asked = useRef(false);
  const [picked, setPicked] = useState(0);
  /** The text the menu was closed for with Esc, so it stays closed until the word changes. */
  const [dismissed, setDismissed] = useState<string | null>(null);
  const menuRef = useRef<HTMLUListElement>(null);

  // The menu belongs to the first word only: "/" and a name, before any space.
  const slash = /^\/(\S*)$/.exec(draft);
  const menuOpen = Boolean(slash && loadCommands && enabled && dismissed !== draft);
  const matches = menuOpen && commands ? matchCommands(commands, slash![1]) : [];

  useEffect(() => {
    if (!menuOpen || asked.current || !loadCommands) return;
    asked.current = true;
    loadCommands()
      .then(setCommands)
      .catch(() => {
        asked.current = false;
        setCommands([]);
      });
  }, [menuOpen, loadCommands]);

  useEffect(() => setPicked(0), [slash?.[1]]);

  useEffect(() => {
    menuRef.current?.querySelector<HTMLElement>(".slash-item.is-picked")?.scrollIntoView({ block: "nearest" });
  }, [picked]);

  const choose = (command: SlashCommand) => {
    change(`/${command.name} `);
    setDismissed(null);
    field.current?.focus();
  };

  useLayoutEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 220)}px`;
  }, [draft]);

  const addFiles = (files: File[]) => {
    if (!enabled || !files.length) return;
    for (const file of files) {
      const key = `a${++attachmentSeq}`;
      const name = pastedName(file);
      const image = file.type.startsWith("image/");
      setAttachments((current) => [...current, { key, name, image, preview: image ? URL.createObjectURL(file) : undefined, status: "uploading" }]);
      api
        .upload(file, name)
        .then((saved) =>
          setAttachments((current) =>
            current.map((item) => (item.key === key ? { ...item, status: "done", path: saved.path, image: item.image || saved.image } : item)),
          ),
        )
        .catch((error: { code?: string }) =>
          setAttachments((current) =>
            current.map((item) => (item.key === key ? { ...item, status: "error", error: UPLOAD_ERRORS[error.code ?? ""] ?? "上传失败" } : item)),
          ),
        );
    }
    field.current?.focus();
  };

  const removeAttachment = (key: string) =>
    setAttachments((current) => {
      const gone = current.find((item) => item.key === key);
      if (gone?.preview) URL.revokeObjectURL(gone.preview);
      return current.filter((item) => item.key !== key);
    });

  // The + menu closes on a press outside it or on Escape.
  useEffect(() => {
    if (!addOpen) return;
    const onPointer = (event: PointerEvent) => {
      if (!addMenu.current?.contains(event.target as Node)) setAddOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAddOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [addOpen]);

  const change = (text: string) => {
    setDraft(text);
    if (text) drafts.set(sessionKey, text);
    else drafts.delete(sessionKey);
  };

  /**
   * The box empties the moment Send is pressed, for every tool (`clearOnSend` asked it of Cursor alone before), and
   * the message shows in the conversation at once; delivering it (a few seconds when it is typed into a desktop
   * window) goes on behind, counted in the reply's time. Only if it is not delivered do the words and attachments
   * come back, unless something new was typed meanwhile.
   */
  const submit = async () => {
    if (!canSend) return;
    void clearOnSend;
    const text = draft;
    const sent = ready;
    const message = withAttachments(text, sent.map((item) => ({ path: item.path!, image: item.image })));
    change("");
    setAttachments((current) => current.filter((item) => !sent.includes(item)));
    // Keep the keyboard up on a phone only when there is more to say; otherwise let the reply have the screen.
    if (!mobile) field.current?.focus();
    else {
      field.current?.blur();
      setFocused(false);
    }
    setSending(true);
    const delivered = await onSend(message);
    setSending(false);
    if (delivered) {
      for (const item of sent) if (item.preview) URL.revokeObjectURL(item.preview);
      return;
    }
    // Not sent: give the words back. The session may have been left meanwhile, so its saved draft takes them too.
    if (!drafts.get(sessionKey)) {
      drafts.set(sessionKey, text);
      change(text);
    }
    if (sent.length) {
      attached.set(sessionKey, [...sent, ...(attached.get(sessionKey) ?? []).filter((item) => !sent.includes(item))]);
      setAttachments((current) => [...sent, ...current.filter((item) => !sent.includes(item))]);
    }
    field.current?.focus();
  };

  const sendNow = async (text: string) => {
    if (!onSendNow || sendingNow) return;
    setSendingNow(text);
    try {
      await onSendNow(text);
    } finally {
      setSendingNow(null);
    }
  };

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {queue && queue.length > 0 && (
        <section className="queue-tray" aria-label="Queued messages">
          <div className="queue-tray-head">{queue.length} Queued</div>
          <ul>
            {queue.map((text, index) => (
              <li key={index}>
                <p>{text}</p>
                {onSendNow && (
                  <button type="button" className="queue-now" disabled={sendingNow === text} onClick={() => void sendNow(text)}>
                    立即发送
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {menuOpen && (
        <div className="slash-menu" role="listbox" aria-label="斜杠命令">
          {commands === null ? (
            <p className="slash-note">正在读取命令…</p>
          ) : matches.length === 0 ? (
            <p className="slash-note">没有以“/{slash![1]}”开头的命令，回车会照原样发送</p>
          ) : (
            <ul ref={menuRef}>
              {matches.map((command, index) => (
                <li key={command.name}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === picked}
                    className={index === picked ? "slash-item is-picked" : "slash-item"}
                    // Keep the caret in the box: a press here must not blur it first.
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setPicked(index)}
                    onClick={() => choose(command)}
                  >
                    <span className="slash-name">/{command.name}</span>
                    <span className="slash-desc">{command.description}</span>
                    <span className="slash-source">{SOURCE_LABEL[command.source]}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div
        ref={box}
        className={`composer-box${enabled ? "" : " disabled"}${open ? " is-open" : ""}${dragging ? " is-dropping" : ""}`}
        onDragOver={(event) => {
          if (!enabled || !event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.files.length) return;
          event.preventDefault();
          setDragging(false);
          addFiles([...event.dataTransfer.files]);
        }}
        onFocus={() => setFocused(true)}
        onBlur={(event) => {
          // Moving between the text and the picker keeps the box open; focus moving to something else closes it.
          const next = event.relatedTarget as Node | null;
          if (next && !event.currentTarget.contains(next)) setFocused(false);
        }}
      >
        {attachments.length > 0 && (
          <ul className="attachments" aria-label="附件">
            {attachments.map((item) => (
              <li
                key={item.key}
                className={`attachment is-${item.status}${item.preview ? " has-preview" : ""}`}
                title={item.error ? `${item.name}：${item.error}` : item.path ?? item.name}
              >
                {item.preview ? (
                  <img src={item.preview} alt={item.name} />
                ) : (
                  <span className="attachment-icon">
                    <FileIcon />
                  </span>
                )}
                {!item.preview && <span className="attachment-name">{item.name}</span>}
                {item.status === "uploading" && (
                  <span className="attachment-state">
                    <Spinner />
                  </span>
                )}
                {item.status === "error" && <span className="attachment-error">{item.error}</span>}
                <button type="button" className="attachment-remove" aria-label={`移除 ${item.name}`} onClick={() => removeAttachment(item.key)}>
                  <CloseIcon />
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={field}
          rows={1}
          value={draft}
          placeholder={(sending || busy) && respondingPlaceholder ? respondingPlaceholder : placeholder}
          aria-label="消息"
          disabled={!enabled}
          enterKeyHint={mobile ? "enter" : "send"}
          onChange={(event) => change(event.target.value)}
          onPaste={(event) => {
            // A picture or file on the clipboard becomes an attachment; text pastes as usual.
            const files = [...event.clipboardData.items]
              .filter((item) => item.kind === "file")
              .map((item) => item.getAsFile())
              .filter((file): file is File => Boolean(file));
            if (!files.length) return;
            event.preventDefault();
            addFiles(files);
          }}
          onKeyDown={(event) => {
            if (menuOpen && matches.length && !event.nativeEvent.isComposing) {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const step = event.key === "ArrowDown" ? 1 : -1;
                setPicked((current) => (current + step + matches.length) % matches.length);
                return;
              }
              if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
                event.preventDefault();
                choose(matches[Math.min(picked, matches.length - 1)]);
                return;
              }
            }
            if (menuOpen && event.key === "Escape") {
              event.preventDefault();
              setDismissed(draft);
              return;
            }
            if (!mobile && event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <div className="composer-bar">
          <div className="composer-add" ref={addMenu}>
            <button
              type="button"
              className={addOpen ? "add-button active" : "add-button"}
              aria-label="添加文件或图片"
              aria-haspopup="menu"
              aria-expanded={addOpen}
              title="添加文件或图片，也可以直接粘贴或拖进来"
              disabled={!enabled}
              onClick={() => setAddOpen((value) => !value)}
            >
              <PlusIcon />
            </button>
            {addOpen && (
              <div className="add-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setAddOpen(false);
                    fileInput.current?.click();
                  }}
                >
                  <FileIcon />
                  <span>添加文件</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setAddOpen(false);
                    imageInput.current?.click();
                  }}
                >
                  <ImageIcon />
                  <span>添加图片</span>
                </button>
                <p className="add-hint">也可以粘贴截图，或把文件拖进输入框</p>
              </div>
            )}
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(event) => {
                addFiles([...(event.target.files ?? [])]);
                event.target.value = "";
              }}
            />
            <input
              ref={imageInput}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(event) => {
                addFiles([...(event.target.files ?? [])]);
                event.target.value = "";
              }}
            />
          </div>
          {open && tools && <div className="composer-tools">{tools}</div>}
          {busy && onStop && (
            <button type="button" className="stop-reply" disabled={stopping} aria-label="终止回复" title="终止正在进行的回复" onClick={onStop}>
              {stopping ? <Spinner /> : <span className="stop-square" aria-hidden="true" />}
              <span>{stopping ? "正在终止" : "终止"}</span>
            </button>
          )}
          <button type="submit" className="send" disabled={!canSend}>
            <SendIcon />
            <span>发送</span>
          </button>
        </div>
      </div>
    </form>
  );
}
