import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import type { ToolId } from "./api";
import { Spinner } from "./icons";
import { modelFamily, modelName } from "./modelName";

import { tr } from "./i18n";
/** What Claude Code's `/model` takes. "default" goes back to what the account would pick. */
const CLAUDE_CHOICES: Array<{ alias: string; label: string; note: string }> = [
  {
    alias: "opus",
    label: "Opus",
    get note() {
      return tr("最强，适合难题", "Most capable, for hard problems");
    },
  },
  {
    alias: "sonnet",
    label: "Sonnet",
    get note() {
      return tr("又快又好，日常主力", "Fast and strong, for everyday work");
    },
  },
  {
    alias: "haiku",
    label: "Haiku",
    get note() {
      return tr("最快、最省", "Fastest and cheapest");
    },
  },
  {
    alias: "default",
    get label() {
      return tr("默认", "Default");
    },
    get note() {
      return tr("按账号的默认设置", "What the account would pick");
    },
  },
];

const WHERE = (): Record<ToolId, string> => ({
  claude: tr("在 Claude 桌面端的输入框旁边切换", "Switch it next to the input box in the Claude desktop app"),
  codex: tr("在 Codex 里用 /model 切换", "Switch it with /model in Codex"),
  cursor: tr("在 Cursor 的输入框下方切换", "Switch it under Cursor's input box"),
  deepseek: tr("在 DSH 的模型设置里切换", "Switch it in DSH's model settings"),
});

interface Props {
  tool: ToolId;
  model?: string;
  effort?: string;
  /** `/model <name>` reaches Claude Code's own terminal for this session. */
  canSwitch: boolean;
  /** Whether a reply is under way: switching then would land in the middle of it. */
  busy: boolean;
  onSwitch: (text: string) => Promise<boolean>;
}

/**
 * The model the session is on, beside the session name. For a session running in MirrorMix's own Claude Code it
 * also switches the model, by sending `/model <name>` the way it would be typed in the terminal.
 */
export function ModelChip({ tool, model, effort, canSwitch, busy, onSwitch }: Props) {
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState<string | null>(null);
  /** The alias asked for, until the transcript shows the model changed. */
  const [asked, setAsked] = useState<{ alias: string; from: string } | null>(null);
  const [custom, setCustom] = useState("");
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // The switch shows as done once the transcript names another model, or after a while if it never does.
  useEffect(() => {
    if (!asked) return;
    if ((model ?? "") !== asked.from) {
      setAsked(null);
      return;
    }
    const timer = window.setTimeout(() => setAsked(null), 20_000);
    return () => window.clearTimeout(timer);
  }, [asked, model]);

  if (!model && !canSwitch) return null;

  const name = model ? modelName(model) : tr("模型", "Model");
  const label = name;
  const current = model ? modelFamily(model) : "";

  const pick = async (alias: string) => {
    setSending(alias);
    const sent = await onSwitch(`/model ${alias}`);
    setSending(null);
    if (sent) {
      setAsked({ alias, from: model ?? "" });
      setOpen(false);
      setCustom("");
    }
  };

  const submitCustom = (event: SyntheticEvent) => {
    event.preventDefault();
    const value = custom.trim();
    if (value && !/\s/.test(value)) void pick(value);
  };

  if (!canSwitch) {
    return (
      <span className="model-chip is-static" title={model ? tr(`${model}${effort ? `，推理强度 ${effort}` : ""}。${WHERE()[tool]}`, `${model}${effort ? `, reasoning effort ${effort}` : ""}. ${WHERE()[tool]}`) : undefined}>
        {label}
      </span>
    );
  }

  return (
    <div className="model" ref={box}>
      <button
        type="button"
        className={open ? "model-chip is-on" : "model-chip"}
        aria-haspopup="menu"
        aria-expanded={open}
        title={model ? tr(`当前模型 ${model}。点击切换`, `Current model ${model}. Click to switch`) : tr("切换模型", "Switch model")}
        onClick={() => setOpen((value) => !value)}
      >
        {asked ? <Spinner /> : null}
        {asked ? tr(`切换到 ${asked.alias}`, `Switching to ${asked.alias}`) : label}
        <span className="model-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="model-menu" role="menu">
          <div className="preview-head">
            <span>{tr("切换模型", "Switch model")}</span>
          </div>
          {busy && <p className="preview-hint">{tr("正在回复中。新模型从下一轮回复开始用。", "Replying now. The new model is used from the next reply.")}</p>}
          <ul className="model-list">
            {CLAUDE_CHOICES.map((choice) => (
              <li key={choice.alias}>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={choice.alias === current}
                  className={choice.alias === current ? "is-current" : ""}
                  disabled={sending !== null}
                  onClick={() => void pick(choice.alias)}
                >
                  <span className="model-option">{choice.label}</span>
                  <span className="preview-name">{choice.note}</span>
                  {sending === choice.alias ? <Spinner /> : choice.alias === current ? <span className="model-tick">✓</span> : null}
                </button>
              </li>
            ))}
          </ul>
          {/* Not a <form>: the chip can sit inside the message box's form, and Enter here must not send the draft. */}
          <div className="preview-custom">
            <input
              value={custom}
              onChange={(event) => setCustom(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) submitCustom(event);
              }}
              placeholder={tr("其他模型 ID，如 claude-opus-5-5", "Another model ID, e.g. claude-opus-5-5")}
              aria-label={tr("模型 ID", "Model ID")}
              spellCheck={false}
            />
            <button type="button" className="quiet-button" disabled={!custom.trim() || /\s/.test(custom.trim()) || sending !== null} onClick={submitCustom}>
              {tr("切换", "Switch")}
            </button>
          </div>
          <p className="preview-hint model-foot">{tr("发送的是 /model 命令，对这条会话之后的回复生效。", "This sends a /model command; it applies to this conversation's later replies.")}</p>
        </div>
      )}
    </div>
  );
}
