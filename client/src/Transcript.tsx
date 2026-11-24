import { createContext, memo, useContext, useEffect, useState } from "react";
import type { DiffLine, StepResult, TranscriptMessage } from "./api";

import { tr, useLanguage } from "./i18n";
/** Which terminal the transcript imitates. Codex draws with other marks than Claude Code. */
export type Flavor = "claude" | "codex";
export const FlavorContext = createContext<Flavor>("claude");

const MARKS = {
  claude: { prompt: ">", bullet: "●", elbow: "⎿", done: "☒", todo: "☐" },
  codex: { prompt: "›", bullet: "•", elbow: "└", done: "✔", todo: "□" },
};

export function useMarks() {
  return MARKS[useContext(FlavorContext)];
}

/* Rows that read like Claude Code's own terminal: `● Tool(args)`, the result under `⎿`,
   folded thinking, and the spinner line with the round's clock and tokens. */

/** Seconds the way the terminal counts them: 8s, 1m 05s, 1h 02m. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
}

const SPINNER = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];
const VERBS = ["Working", "Thinking", "Pondering", "Cogitating", "Computing", "Brewing", "Crafting", "Mulling", "Noodling", "Percolating"];

/** The same round keeps the same word, so the line does not flicker between refreshes. */
function verbOf(seed: string): string {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return VERBS[hash % VERBS.length];
}

/** Glyph and clock on their own node, so only this span re-renders while the round runs. */
function LiveStatus({ since, tokens, codex }: { since: string; tokens: number; codex: boolean }) {
  const start = Date.parse(since);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), 120);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <>
      <span className="cc-glyph" aria-hidden="true">
        {codex ? (tick % 8 < 4 ? "•" : "◦") : SPINNER[tick % SPINNER.length]}
      </span>
      {/* Codex always says "Working"; Claude Code picks a word per round. */}
      <span className="cc-verb">{codex ? "Working" : `${verbOf(since)}…`}</span>
      <span className="cc-faint">
        ({formatDuration(Date.now() - start)}
        {tokens ? ` · ↓ ${formatTokens(tokens)} tokens` : ""})
      </span>
    </>
  );
}

export const RoundRow = memo(function RoundRow({ round }: { round: TranscriptMessage }) {
  useLanguage();
  const codex = useContext(FlavorContext) === "codex";
  if (!round.startedAt) return null;
  if (!round.endedAt) {
    return (
      <div className="cc-round is-live" role="status">
        <LiveStatus since={round.startedAt} tokens={round.tokens ?? 0} codex={codex} />
      </div>
    );
  }
  if (codex) {
    // Codex closes a turn with a rule across the transcript.
    return (
      <div className="cc-round is-rule">
        <span>
          Worked for {formatDuration(Date.parse(round.endedAt) - Date.parse(round.startedAt))}
          {round.tokens ? ` · ↓ ${formatTokens(round.tokens)} tokens` : ""}
        </span>
      </div>
    );
  }
  return (
    <>
      <div className="cc-round">
        <span className="cc-glyph" aria-hidden="true">✻</span>
        <span>
          Worked for {formatDuration(Date.parse(round.endedAt) - Date.parse(round.startedAt))}
          {round.tokens ? ` · ↓ ${formatTokens(round.tokens)} tokens` : ""}
        </span>
      </div>
      {round.stalled && <StalledNote tool={round.stalled.tool} limitMs={round.stalled.limitMs} />}
    </>
  );
});

/** Under a round MirrorMix closed itself: its last command never answered. */
function StalledNote({ tool, limitMs }: { tool: string; limitMs: number }) {
  const limit = limitMs >= 60_000 ? tr(`${Math.round(limitMs / 60_000)} 分钟`, `${Math.round(limitMs / 60_000)} min`) : tr("立即返回", "return at once");
  return (
    <div className="cc-stalled" role="note">
      {tr(
        `${tool} 已经过了它自己的时限（${limit}）还没有结果，可能卡住了，或在等你批准。这一轮先当作结束，发送下一条消息就能接着做。`,
        `${tool} has passed its own time limit (${limit}) with no result. It may be stuck or waiting for your approval. This turn is treated as over; send the next message to carry on.`,
      )}
    </div>
  );
}

export const ThinkingRow = memo(function ThinkingRow({ message }: { message: TranscriptMessage }) {
  useLanguage();
  const marks = useMarks();
  // Codex prints its reasoning headings inline; Claude Code folds thinking away.
  if (marks.bullet === "•") {
    return (
      <div className="cc-thinking is-inline">
        <span className="cc-glyph" aria-hidden="true">•</span>
        <em>{message.text}</em>
      </div>
    );
  }
  return (
    <details className="cc-thinking">
      <summary>
        <span className="cc-glyph" aria-hidden="true">✻</span>
        Thinking…
      </summary>
      <div className="cc-thinking-text">{message.text}</div>
    </details>
  );
});

function Diff({ lines }: { lines: DiffLine[] }) {
  const width = String(Math.max(0, ...lines.map((line) => line.no ?? 0))).length;
  return (
    <div className="cc-diff">
      {lines.map((line, index) =>
        line.kind === "…" ? (
          <div key={index} className="cc-diff-gap">
            {line.text || "⋮"}
          </div>
        ) : (
          <div key={index} className={`cc-diff-line is-${line.kind === "+" ? "add" : line.kind === "-" ? "del" : "ctx"}`}>
            <span className="cc-diff-no">{String(line.no ?? "").padStart(width, " ")}</span>
            <span className="cc-diff-mark">{line.kind}</span>
            <span className="cc-diff-text">{line.text || " "}</span>
          </div>
        ),
      )}
    </div>
  );
}

/** Everything a call produced; it is only drawn once the person opens the call, so nothing more is folded here. */
function ResultBody({ result }: { result: StepResult }) {
  const marks = useMarks();
  if (result.status === "running") return <div className="cc-faint">Running…</div>;
  const lines = result.lines ?? [];
  const diff = result.diff ?? [];
  return (
    <>
      {result.summary && <div className={result.status === "error" ? "cc-error" : undefined}>{result.summary}</div>}
      {result.todos && (
        <ul className="cc-todos">
          {result.todos.map((todo, index) => (
            <li key={index} className={`is-${todo.status}`}>
              <span aria-hidden="true">{todo.status === "completed" ? marks.done : marks.todo}</span>
              {todo.text}
            </li>
          ))}
        </ul>
      )}
      {lines.length > 0 && (
        <pre className={result.status === "error" ? "cc-output cc-error" : "cc-output"}>{lines.join("\n")}</pre>
      )}
      {diff.length > 0 && <Diff lines={diff} />}
      {(result.more ?? 0) > 0 && <div className="cc-faint">… +{result.more} lines not kept</div>}
      {!result.summary && !lines.length && !diff.length && !result.todos && <div className="cc-faint">(No content)</div>}
    </>
  );
}

/** Shell calls start folded to the command line (the dot's colour says whether it worked); a click opens the output. */
const QUIET_TOOLS = new Set(["Bash", "PowerShell", "Ran"]);

/** A todo update is drawn as a framed card with its list, not as a call with a result. */
function TodoCard({ step }: { step: TranscriptMessage }) {
  const marks = useMarks();
  const todos = step.result?.todos ?? [];
  const done = todos.filter((todo) => todo.status === "completed").length;
  return (
    <div className="cc-todo-card">
      <div className="cc-todo-head">
        <b>{step.tool}</b>
        <span className="cc-faint">
          {done}/{todos.length}
        </span>
      </div>
      <ul className="cc-todos">
        {todos.map((todo, index) => (
          <li key={index} className={`is-${todo.status}`}>
            <span aria-hidden="true">{todo.status === "completed" ? marks.done : marks.todo}</span>
            {todo.text}
          </li>
        ))}
      </ul>
    </div>
  );
}

export const StepRow = memo(function StepRow({ step }: { step: TranscriptMessage }) {
  useLanguage();
  const [wrap, setWrap] = useState(false);
  const marks = useMarks();
  const codex = marks.bullet === "•";
  const status = step.result?.status ?? "ok";
  if (step.result?.todos?.length) return <TodoCard step={step} />;
  const quiet = QUIET_TOOLS.has(step.tool ?? "");
  const result = step.result;
  // Output, added and removed code stay folded in history; the one-line summary still shows.
  const details = Boolean(result && result.status !== "running" && (result.lines?.length || result.diff?.length));
  const foldable = details || (quiet && Boolean(result) && result?.status !== "running");
  const summaryOnly = !wrap && !quiet && result?.summary && result.status !== "running";
  return (
    <div className={`cc-step is-${status}`}>
      <button
        type="button"
        className={wrap ? "cc-call is-wrapped" : "cc-call"}
        aria-expanded={foldable ? wrap : undefined}
        onClick={() => setWrap((value) => !value)}
      >
        <span className="cc-dot" aria-hidden="true">{marks.bullet}</span>
        <span className="cc-call-text">
          {step.tool && <b>{step.tool}</b>}
          {/* Codex commentary has no tool: it is a sentence, not arguments. */}
          {step.text && <span>{step.tool && !codex ? `(${step.text})` : ` ${step.text}`}</span>}
        </span>
        {foldable && (
          <span className="cc-fold" aria-hidden="true">
            {wrap ? "▾" : "▸"}
          </span>
        )}
      </button>
      {result && (wrap || result.status === "running" || summaryOnly) && (
        <div className="cc-result">
          <span className="cc-elbow" aria-hidden="true">{marks.elbow}</span>
          <div className="cc-result-body">
            {wrap || result.status === "running" ? (
              <ResultBody result={result} />
            ) : (
              <div className={result.status === "error" ? "cc-error" : undefined}>{result.summary}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
});
