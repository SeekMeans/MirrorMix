import { useEffect, useState } from "react";
import type { TranscriptMessage } from "./api";
import { MarkdownMessage } from "./MarkdownMessage";
import { cursorTurns, toolGroupLine, type CursorStepView, type CursorTurnView } from "../../src/transcript/cursor";

import { tr } from "./i18n";
const LONG_USER_TEXT = 1500;

function UserBubble({ text, pending, queued }: { text: string; pending: boolean; queued: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > LONG_USER_TEXT;
  return (
    <div className={pending ? "cursor-user pending" : "cursor-user"}>
      {queued && <span className="queue-mark">{tr("排队", "Queued")}</span>}
      {long && !expanded ? `${text.slice(0, LONG_USER_TEXT)}…` : text}
      {long && (
        <button type="button" className="link-button unfold" onClick={() => setExpanded((open) => !open)}>
          {expanded ? tr("收起", "Show less") : tr(`展开全文（${text.length} 字）`, `Show all (${text.length} characters)`)}
        </button>
      )}
    </div>
  );
}

function StepList({ steps }: { steps: CursorStepView[] }) {
  if (!steps.length) return null;
  return (
    <ul className="cursor-steps">
      {steps.map((step) => (
        <li key={step.id} className={`is-${step.status}`}>
          {step.label}
        </li>
      ))}
    </ul>
  );
}

function clockLabel(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m ${rest}s`;
}

function Elapsed({ since }: { since: string }) {
  const start = Date.parse(since);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  if (Number.isNaN(start)) return null;
  return <span className="cursor-elapsed"> ({clockLabel(now - start)})</span>;
}

function ToolGroup({ steps, live }: { steps: CursorStepView[]; live: boolean }) {
  const line = toolGroupLine(steps, live);
  const label = line || (live ? "Working" : "Worked");
  return (
    <details className="cursor-fold">
      <summary>{label}</summary>
      <StepList steps={steps} />
    </details>
  );
}

function Turn({ turn }: { turn: CursorTurnView }) {
  let lastTools = -1;
  turn.parts.forEach((part, index) => {
    if (part.kind === "tools") lastTools = index;
  });
  return (
    <section className="cursor-turn">
      {turn.user && <UserBubble text={turn.user} pending={turn.pending} queued={turn.id.startsWith("queued-")} />}
      {turn.parts.map((part, index) =>
        part.kind === "text" ? (
          <div className="cursor-answer" key={`${turn.id}-text-${index}`}>
            <MarkdownMessage text={part.text} />
          </div>
        ) : (
          <div className="cursor-activity" key={`${turn.id}-tools-${index}`}>
            <ToolGroup steps={part.steps} live={turn.live && index === lastTools} />
          </div>
        ),
      )}
      {turn.live && turn.running && (
        <div className="cursor-status">
          {turn.running}
          {turn.startedAt && <Elapsed since={turn.startedAt} />}
        </div>
      )}
    </section>
  );
}

/** Cursor's own transcript: a bubble for what you typed, the reply underneath, tools folded into one line. */
export function CursorThread({ messages }: { messages: TranscriptMessage[] }) {
  const turns = cursorTurns(messages.filter((message) => !message.id.startsWith("queued-")));
  return (
    <div className="cursor-thread">
      {turns.map((turn) => (
        <Turn key={turn.id} turn={turn} />
      ))}
    </div>
  );
}
