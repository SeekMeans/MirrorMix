import { useEffect, useState } from "react";
import { api, type ToolId, type ToolPrompt } from "./api";
import { Spinner } from "./icons";
import { errorText, toolName } from "./text";

import { tr } from "./i18n";
const KIND_LABEL = (): Record<ToolPrompt["kind"], string> => ({
  permission: tr("等你确认", "Needs your OK"),
  question: tr("等你选择", "Needs your choice"),
  plan: tr("计划待批准", "Plan to approve"),
  trust: tr("等你确认", "Needs your OK"),
});

/** Lines of detail shown before "展开全部": enough for a command or a short diff, not a whole plan. */
const FOLDED_LINES = 10;

/**
 * What the AI tool stopped to ask, as a card above the message box: the question, what it is about, and its own
 * answers as buttons. A pick is answered where it was asked (keys in the terminal, a click in the app window), and the
 * card goes away once the tool moves on.
 */
export function PromptCard({ tool, sessionId, prompt }: { tool: ToolId; sessionId: string; prompt: ToolPrompt }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [unfolded, setUnfolded] = useState(false);
  // A new question starts clean.
  useEffect(() => {
    setBusy(null);
    setError("");
    setUnfolded(false);
  }, [prompt.id]);

  const pick = async (optionId: string) => {
    setBusy(optionId);
    setError("");
    try {
      await api.answerPrompt(tool, sessionId, prompt.id, optionId);
      // Kept "busy" until the tool moves on and the card goes, so a second click cannot answer the next question.
    } catch (failure) {
      setError(errorText((failure as { code?: string }).code));
      setBusy(null);
    }
  };

  const lines = prompt.detail ? prompt.detail.split("\n") : [];
  const long = lines.length > FOLDED_LINES;
  const shownDetail = long && !unfolded ? lines.slice(0, FOLDED_LINES).join("\n") : prompt.detail;
  const listed = prompt.kind === "question" || prompt.options.some((option) => option.description);
  const firstYes = prompt.options.find((option) => option.tone === "yes")?.id ?? (prompt.kind === "question" ? undefined : prompt.options[0]?.id);
  const titleId = `prompt-${prompt.id}`;

  return (
    <section className={`prompt-card is-${prompt.kind}${prompt.readOnly ? " is-readonly" : ""}`} role="alertdialog" aria-labelledby={titleId} aria-live="polite">
      <div className="prompt-top">
        <span className="prompt-kind">
          <span className="prompt-pulse" aria-hidden="true" />
          {KIND_LABEL()[prompt.kind]}
        </span>
        {prompt.header && <span className="prompt-chip">{prompt.header}</span>}
        <span className="prompt-where">{toolName[tool]}</span>
      </div>
      <h3 id={titleId} className="prompt-title">
        {prompt.title}
      </h3>
      {prompt.detail && (
        <div className={prompt.kind === "plan" ? "prompt-detail is-plan" : "prompt-detail"}>
          <pre>{shownDetail}</pre>
          {long && (
            <button type="button" className="link-button prompt-unfold" onClick={() => setUnfolded((open) => !open)}>
              {unfolded ? tr("收起", "Show less") : tr(`展开全部（${lines.length} 行）`, `Show all (${lines.length} lines)`)}
            </button>
          )}
        </div>
      )}

      {prompt.readOnly ? (
        <>
          {prompt.options.length > 0 && (
            <ul className="prompt-choices is-static">
              {prompt.options.map((option) => (
                <li key={option.id}>
                  <strong>{option.label}</strong>
                  {option.description && <span>{option.description}</span>}
                </li>
              ))}
            </ul>
          )}
          <p className="prompt-note">{tr(`这个需要在 ${toolName[tool]} 里直接回答，回答后这里会接着显示。`, `Answer this in ${toolName[tool]} itself; this page carries on once it is answered.`)}</p>
        </>
      ) : listed ? (
        <div className="prompt-choices" role="group" aria-label={tr("选项", "Options")}>
          {prompt.options.map((option, index) => (
            <button
              key={option.id}
              type="button"
              className={`prompt-choice${option.tone === "no" ? " is-no" : ""}${busy === option.id ? " is-busy" : ""}`}
              disabled={busy !== null}
              onClick={() => void pick(option.id)}
            >
              <span className="prompt-choice-n" aria-hidden="true">
                {busy === option.id ? <Spinner /> : index + 1}
              </span>
              <span className="prompt-choice-text">
                <strong>{option.label}</strong>
                {option.description && <span>{option.description}</span>}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="prompt-actions" role="group" aria-label={tr("选项", "Options")}>
          {prompt.options.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`quiet-button${option.id === firstYes ? " is-primary" : ""}${option.tone === "no" ? " prompt-no" : ""}`}
              disabled={busy !== null}
              onClick={() => void pick(option.id)}
            >
              {busy === option.id && <Spinner />}
              {option.label}
            </button>
          ))}
        </div>
      )}
      {error && (
        <p className="prompt-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
