import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  api,
  type Catalog,
  type ModelView,
  type RunSummary,
  type StepRun,
  type ToolId,
  type Workflow,
  type WorkflowCondition,
  type WorkflowRun,
  type WorkflowStep,
} from "./api";
import { BackIcon, ChevronIcon, CloseIcon, ConsoleIcon, DownIcon, FlowIcon, FolderIcon, ModelIcon, PlayIcon, PlusIcon, Spinner, StopIcon, TrashIcon, UpIcon } from "./icons";
import { ToolIcon } from "./ToolIcon";
import { Select } from "./Select";
import { toolName } from "./text";
import {
  before,
  blankStep,
  findStep,
  flatten,
  insertStep,
  moveStep,
  OPS,
  opWord,
  removeStep,
  summarize,
  updateStep,
  type Slot,
} from "./workflowSteps";

type Draft = Omit<Workflow, "id" | "createdAt" | "updatedAt"> & { id?: string };

const KIND_WORD: Record<WorkflowStep["kind"], string> = { ai: "AI 工具", model: "模型", command: "命令", if: "条件", loop: "循环" };
const KINDS: WorkflowStep["kind"][] = ["ai", "model", "command", "if", "loop"];

/** Starting points for a model step's prompt framework: role, task, rules, output. Picked, then edited. */
const FRAMES: { name: string; text: string }[] = [
  {
    name: "通用",
    text: "# 角色\n你是一名……\n\n# 任务\n……\n\n# 要求\n- ……\n- ……\n\n# 输出格式\n……",
  },
  {
    name: "代码评审",
    text: "# 角色\n你是一名资深代码评审。\n\n# 任务\n评审用户给出的改动，找出会出错的地方。\n\n# 要求\n- 只说确定的问题，每条写明文件、原因和改法\n- 没有问题就直接说“没有问题”\n\n# 输出格式\nJSON：{\"ok\": true/false, \"issues\": [{\"file\": \"\", \"problem\": \"\", \"fix\": \"\"}]}",
  },
  {
    name: "总结",
    text: "# 角色\n你是一名技术写作者。\n\n# 任务\n把用户给出的内容总结成要点。\n\n# 要求\n- 不超过 5 条，每条一句话\n- 保留关键数字和名称\n\n# 输出格式\n每行一条，以“- ”开头。",
  },
  {
    name: "判断",
    text: "# 任务\n根据用户给出的内容回答一个是非问题。\n\n# 输出格式\n只回答“是”或“否”，不要别的文字。",
  },
];
const RUN_WORD: Record<string, string> = { running: "运行中", ok: "成功", failed: "失败", stopped: "已停止", skipped: "跳过" };

const folderName = (value: string) => value.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || value;
const errorWord = (code?: string) =>
  ({
    name_required: "先给工作流起个名字",
    workspace_required: "先选一个工作区",
    running: "这个工作流正在运行",
    no_steps: "还没有步骤",
    too_many_steps: "步骤太多了",
    not_found: "工作流已经不在了",
  })[code ?? ""] ?? "没有成功，请再试一次";

function when(iso?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  const today = new Date();
  const time = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  return date.toDateString() === today.toDateString() ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}
function took(start: string, end?: string): string {
  const seconds = Math.max(0, Math.round(((end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime()) / 1000));
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function StepMark({ step }: { step: Pick<WorkflowStep, "kind"> & { tool?: ToolId } }) {
  if (step.kind === "ai" && step.tool) return <ToolIcon tool={step.tool} size={18} />;
  if (step.kind === "command") return <ConsoleIcon />;
  if (step.kind === "model") return <ModelIcon />;
  if (step.kind === "if")
    return (
      <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M8 2v4M8 6 4 10v4M8 6l4 4v4" />
      </svg>
    );
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12.5 6.5A4.8 4.8 0 0 0 3.6 5M3.5 9.5a4.8 4.8 0 0 0 8.9 1.5M3.4 2.6V5h2.4M12.6 13.4V11h-2.4" />
    </svg>
  );
}

/** The workspaces the AI tools know about, the choices for where a workflow works. */
function workspacesOf(catalog: Catalog | null): string[] {
  const seen = new Map<string, string>();
  for (const tool of ["claude", "codex", "cursor", "deepseek"] as ToolId[]) {
    for (const group of catalog?.[tool] ?? []) {
      if (group.label || !group.path) continue;
      const key = group.path.replace(/[\\/]+$/, "").toLowerCase();
      if (!seen.has(key)) seen.set(key, group.path);
    }
  }
  return [...seen.values()];
}

// ---------------- Blocks ----------------

function Blocks({
  steps,
  slot,
  selected,
  onSelect,
  onAdd,
  onMove,
  onRemove,
  depth = 0,
}: {
  steps: WorkflowStep[];
  slot: Slot;
  selected: string | null;
  onSelect: (id: string) => void;
  onAdd: (slot: Slot, kind: WorkflowStep["kind"]) => void;
  onMove: (id: string, by: -1 | 1) => void;
  onRemove: (id: string) => void;
  depth?: number;
}) {
  return (
    <ol className="flow-blocks">
      {steps.map((step, index) => (
        <li key={step.id} className={`flow-block is-${step.kind}`}>
          <div className={selected === step.id ? "flow-card is-on" : "flow-card"}>
            <button type="button" className="flow-card-main" onClick={() => onSelect(step.id)}>
              <span className="flow-card-mark">
                <StepMark step={step.kind === "ai" ? { kind: "ai", tool: step.tool } : step} />
              </span>
              <span className="flow-card-text">
                <span className="flow-card-name">
                  {step.name}
                  <em>{KIND_WORD[step.kind]}</em>
                </span>
                <span className="flow-card-sum">{summarize(step, toolName)}</span>
              </span>
            </button>
            <span className="flow-card-tools">
              <button type="button" className="icon-button" aria-label="上移" title="上移" disabled={index === 0} onClick={() => onMove(step.id, -1)}>
                <UpIcon />
              </button>
              <button type="button" className="icon-button" aria-label="下移" title="下移" disabled={index === steps.length - 1} onClick={() => onMove(step.id, 1)}>
                <DownIcon />
              </button>
              <button type="button" className="icon-button" aria-label="删除这一步" title="删除" onClick={() => onRemove(step.id)}>
                <TrashIcon />
              </button>
            </span>
          </div>
          {step.kind === "if" && (
            <div className="flow-nest">
              <div className="flow-branch">
                <span className="flow-branch-label is-yes">成立</span>
                <Blocks {...{ selected, onSelect, onAdd, onMove, onRemove }} steps={step.then} slot={{ parent: step.id, key: "then" }} depth={depth + 1} />
              </div>
              <div className="flow-branch">
                <span className="flow-branch-label is-no">不成立</span>
                <Blocks {...{ selected, onSelect, onAdd, onMove, onRemove }} steps={step.else} slot={{ parent: step.id, key: "else" }} depth={depth + 1} />
              </div>
            </div>
          )}
          {step.kind === "loop" && (
            <div className="flow-nest">
              <div className="flow-branch">
                <span className="flow-branch-label">{step.mode === "each" ? "每一项" : "每一轮"}</span>
                <Blocks {...{ selected, onSelect, onAdd, onMove, onRemove }} steps={step.body} slot={{ parent: step.id, key: "body" }} depth={depth + 1} />
              </div>
            </div>
          )}
        </li>
      ))}
      <li className="flow-add-row">
        <AddMenu compact={depth > 0} onPick={(kind) => onAdd(slot, kind)} />
      </li>
    </ol>
  );
}

function AddMenu({ onPick, compact }: { onPick: (kind: WorkflowStep["kind"]) => void; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  return open ? (
    <span className="flow-add-menu" role="menu">
      {KINDS.map((kind) => (
        <button
          key={kind}
          type="button"
          role="menuitem"
          onClick={() => {
            setOpen(false);
            onPick(kind);
          }}
        >
          <StepMark step={kind === "ai" ? { kind, tool: "claude" } : { kind }} />
          {KIND_WORD[kind]}
        </button>
      ))}
      <button type="button" className="icon-button" aria-label="取消" onClick={() => setOpen(false)}>
        <CloseIcon />
      </button>
    </span>
  ) : (
    <button type="button" className={compact ? "flow-add is-compact" : "flow-add"} onClick={() => setOpen(true)}>
      <PlusIcon />
      添加步骤
    </button>
  );
}

// ---------------- Step settings ----------------

function Refs({ names, inLoop, onPick }: { names: string[]; inLoop: boolean; onPick: (ref: string) => void }) {
  const refs = ["输入", ...names.map((name) => `${name}.输出`), ...(inLoop ? ["循环.当前项", "循环.次数"] : [])];
  return (
    <span className="flow-refs" aria-label="可以引用的内容">
      {refs.map((ref) => (
        <button key={ref} type="button" onClick={() => onPick(`{{${ref}}}`)}>
          {`{{${ref}}}`}
        </button>
      ))}
    </span>
  );
}

function useInsert(value: string, set: (next: string) => void) {
  const box = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  const insert = (piece: string) => {
    const element = box.current;
    const at = element?.selectionStart ?? value.length;
    const end = element?.selectionEnd ?? at;
    set(value.slice(0, at) + piece + value.slice(end));
    requestAnimationFrame(() => {
      element?.focus();
      element?.setSelectionRange(at + piece.length, at + piece.length);
    });
  };
  return { box, insert };
}

function ConditionFields({ rule, onChange, names, inLoop }: { rule: WorkflowCondition; onChange: (rule: WorkflowCondition) => void; names: string[]; inLoop: boolean }) {
  const { box, insert } = useInsert(rule.source, (source) => onChange({ ...rule, source }));
  const noValue = rule.op === "empty" || rule.op === "not_empty";
  return (
    <>
      <label className="flow-field">
        <span>检查的内容</span>
        <input ref={box} value={rule.source} placeholder="如 {{测试.退出码}}" onChange={(event) => onChange({ ...rule, source: event.target.value })} />
        <Refs names={names} inLoop={inLoop} onPick={insert} />
      </label>
      <div className="flow-field-row">
        <label className="flow-field">
          <span>判断</span>
          <Select ariaLabel="判断" value={rule.op} onChange={(op) => onChange({ ...rule, op: op as WorkflowCondition["op"] })} options={OPS.map((op) => ({ value: op, label: opWord(op) }))} />
        </label>
        {!noValue && (
          <label className="flow-field">
            <span>{rule.op === "matches" ? "正则" : "值"}</span>
            <input value={rule.value} onChange={(event) => onChange({ ...rule, value: event.target.value })} />
          </label>
        )}
      </div>
    </>
  );
}

function StepSettings({
  step,
  steps,
  tools,
  workspace,
  catalog,
  models,
  onChange,
}: {
  step: WorkflowStep;
  steps: WorkflowStep[];
  tools: ToolId[];
  workspace: string;
  catalog: Catalog | null;
  models: ModelView[] | null;
  onChange: (step: WorkflowStep) => void;
}) {
  const { earlier, inLoop } = before(steps, step.id);
  const names = earlier.map((item) => item.name);
  const clash = flatten(steps).some((item) => item.id !== step.id && item.name === step.name);
  const main = step.kind === "ai" || step.kind === "model" ? step.prompt : step.kind === "command" ? step.command : "";
  const { box, insert } = useInsert(main, (next) =>
    onChange(step.kind === "ai" || step.kind === "model" ? { ...step, prompt: next } : step.kind === "command" ? { ...step, command: next } : step),
  );
  const frame = useInsert(step.kind === "model" ? step.system : "", (next) => step.kind === "model" && onChange({ ...step, system: next }));
  // Sessions of this tool already in the workspace, to carry on one of them.
  const existing = useMemo(() => {
    if (step.kind !== "ai") return [];
    const key = workspace.replace(/[\\/]+$/, "").toLowerCase();
    return (catalog?.[step.tool] ?? [])
      .filter((group) => group.path.replace(/[\\/]+$/, "").toLowerCase() === key)
      .flatMap((group) => group.sessions)
      .slice(0, 30);
  }, [catalog, step, workspace]);

  return (
    <div className="flow-settings">
      <label className="flow-field">
        <span>名称</span>
        <input value={step.name} maxLength={40} onChange={(event) => onChange({ ...step, name: event.target.value })} />
        {clash && <em className="flow-warn">和另一步重名了，引用时会分不清</em>}
        {!clash && step.kind !== "if" && step.kind !== "loop" && <em className="flow-hint">后面的步骤用 {`{{${step.name}.输出}}`} 拿到它的结果</em>}
      </label>

      {step.kind === "ai" && (
        <>
          <div className="flow-field-row">
            <label className="flow-field">
              <span>AI 工具</span>
              <Select
                ariaLabel="AI 工具"
                value={step.tool}
                onChange={(tool) => onChange({ ...step, tool: tool as ToolId, session: "new" })}
                options={(tools.includes(step.tool) ? tools : [step.tool, ...tools]).map((tool) => ({ value: tool, label: toolName[tool], icon: <ToolIcon tool={tool} size={18} /> }))}
              />
            </label>
            <label className="flow-field">
              <span>会话</span>
              <Select
                ariaLabel="会话"
                value={step.session}
                onChange={(session) => onChange({ ...step, session })}
                searchHint="会话标题"
                options={[
                  { value: "new", label: "新开一条会话" },
                  ...earlier
                    .filter((item) => item.kind === "ai" && item.tool === step.tool)
                    .map((item) => ({ value: `step:${item.id}`, label: `接着“${item.name}”的会话`, group: "这个工作流里的" })),
                  ...existing.map((session) => ({ value: session.id, label: session.title || "（无标题）", group: "已有会话" })),
                ]}
              />
            </label>
          </div>
          <label className="flow-field">
            <span>提示词</span>
            <textarea ref={box} rows={6} value={step.prompt} placeholder="要 AI 做什么。可以引用前面步骤的结果。" onChange={(event) => onChange({ ...step, prompt: event.target.value })} />
            <Refs names={names} inLoop={inLoop} onPick={insert} />
            <em className="flow-hint">想让后面按字段取值，就让它回复 JSON，再用 {"{{名称.字段}}"}。</em>
          </label>
        </>
      )}

      {step.kind === "model" && (
        <>
          <label className="flow-field">
            <span>模型</span>
            {/* A step may name its model instead of holding its id (one written before the model was added). */}
            <Select
              ariaLabel="模型"
              placeholder={models === null ? "正在读取…" : models.length ? "选择模型" : "还没有模型，到 设置 → 模型管理 添加"}
              empty="还没有模型，到 设置 → 模型管理 添加"
              value={models?.find((model) => model.id === step.modelId || model.name === step.modelId)?.id ?? step.modelId}
              onChange={(modelId) => onChange({ ...step, modelId })}
              options={[
                ...(step.modelId && models && !models.some((model) => model.id === step.modelId || model.name === step.modelId)
                  ? [{ value: step.modelId, label: `“${step.modelId}”`, hint: "还没添加这个模型", disabled: true }]
                  : []),
                ...(models ?? []).map((model) => ({ value: model.id, label: model.name, hint: model.model })),
              ]}
            />
          </label>
          <div className="flow-field">
            <span className="flow-field-head">
              提示词框架
              <span className="flow-frames">
                {FRAMES.map((item) => (
                  <button
                    key={item.name}
                    type="button"
                    onClick={() => {
                      if (step.system.trim() && !window.confirm("用这个框架替换现在的内容？")) return;
                      onChange({ ...step, system: item.text });
                    }}
                  >
                    {item.name}
                  </button>
                ))}
              </span>
            </span>
            <textarea ref={frame.box} rows={8} value={step.system} placeholder="角色、任务、要求、输出格式。作为系统提示词发给模型，可以不填。" onChange={(event) => onChange({ ...step, system: event.target.value })} />
            <Refs names={names} inLoop={inLoop} onPick={frame.insert} />
          </div>
          <label className="flow-field">
            <span>提示词</span>
            <textarea ref={box} rows={5} value={step.prompt} placeholder="这一次要它处理的内容，如：评审下面的改动 {{实现.输出}}" onChange={(event) => onChange({ ...step, prompt: event.target.value })} />
            <Refs names={names} inLoop={inLoop} onPick={insert} />
          </label>
          <label className="flow-check">
            <input type="checkbox" checked={step.json === true} onChange={(event) => onChange({ ...step, json: event.target.checked })} />
            要求回复 JSON（后面用 {`{{${step.name}.字段}}`} 取值）
          </label>
        </>
      )}

      {step.kind === "command" && (
        <>
          <label className="flow-field">
            <span>命令</span>
            <textarea ref={box} rows={3} className="is-code" value={step.command} placeholder="npm test" onChange={(event) => onChange({ ...step, command: event.target.value })} />
            <Refs names={names} inLoop={inLoop} onPick={insert} />
          </label>
          <label className="flow-field">
            <span>目录</span>
            <input value={step.cwd ?? ""} placeholder="工作区根目录" onChange={(event) => onChange({ ...step, cwd: event.target.value })} />
          </label>
          <label className="flow-check">
            <input type="checkbox" checked={step.failOnError !== false} onChange={(event) => onChange({ ...step, failOnError: event.target.checked })} />
            退出码不是 0 时停止工作流
          </label>
        </>
      )}

      {step.kind === "if" && <ConditionFields rule={step.condition} names={names} inLoop={inLoop} onChange={(condition) => onChange({ ...step, condition })} />}

      {step.kind === "loop" && (
        <>
          <span className="flow-segment" role="radiogroup" aria-label="循环方式">
            {(["until", "each"] as const).map((mode) => (
              <button key={mode} type="button" role="radio" aria-checked={step.mode === mode} className={step.mode === mode ? "is-on" : ""} onClick={() => onChange({ ...step, mode })}>
                {mode === "until" ? "重复直到" : "逐行处理"}
              </button>
            ))}
          </span>
          {step.mode === "until" ? (
            <>
              <em className="flow-hint">每轮跑完检查一次，条件成立就结束。</em>
              <ConditionFields
                rule={step.condition ?? { source: "", op: "equals", value: "0" }}
                names={[...names, ...flatten(step.body).map((item) => item.name)]}
                inLoop
                onChange={(condition) => onChange({ ...step, condition })}
              />
            </>
          ) : (
            <LoopList step={step} names={names} inLoop={inLoop} onChange={onChange} />
          )}
          <label className="flow-field is-short">
            <span>{step.mode === "each" ? "最多处理几项" : "最多几轮"}</span>
            <input type="number" min={1} max={100} value={step.max} onChange={(event) => onChange({ ...step, max: Math.max(1, Math.min(100, Number(event.target.value) || 1)) })} />
          </label>
        </>
      )}

      {(step.kind === "ai" || step.kind === "model" || step.kind === "command") && (
        <label className="flow-field is-short">
          <span>超时（分钟）</span>
          <input type="number" min={1} max={1440} value={step.timeoutMin ?? (step.kind === "model" ? 10 : 30)} onChange={(event) => onChange({ ...step, timeoutMin: Math.max(1, Number(event.target.value) || 30) })} />
        </label>
      )}
    </div>
  );
}

function LoopList({ step, names, inLoop, onChange }: { step: Extract<WorkflowStep, { kind: "loop" }>; names: string[]; inLoop: boolean; onChange: (step: WorkflowStep) => void }) {
  const { box, insert } = useInsert(step.list ?? "", (list) => onChange({ ...step, list }));
  return (
    <label className="flow-field">
      <span>列表（每行一项）</span>
      <textarea ref={box} rows={3} value={step.list ?? ""} placeholder="{{上一步.输出}}" onChange={(event) => onChange({ ...step, list: event.target.value })} />
      <Refs names={names} inLoop={inLoop} onPick={insert} />
      <em className="flow-hint">循环里的步骤用 {"{{循环.当前项}}"} 拿到这一项。</em>
    </label>
  );
}

// ---------------- Runs ----------------

function RunView({ run, onOpenSession, onStop }: { run: WorkflowRun; onOpenSession: (tool: ToolId, id: string) => void; onStop: () => void }) {
  const [open, setOpen] = useState<Set<number>>(() => new Set());
  const [, tick] = useState(0);
  useEffect(() => {
    if (run.status !== "running") return;
    const timer = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, [run.status]);
  const depthOf = (entry: StepRun) => entry.round?.length ?? 0;
  return (
    <div className="flow-run">
      <header className="flow-run-head">
        <span className={`flow-status is-${run.status}`}>
          {run.status === "running" && <Spinner />}
          {RUN_WORD[run.status]}
        </span>
        <span className="flow-run-time">
          {when(run.startedAt)} · {took(run.startedAt, run.endedAt)}
        </span>
        {run.status === "running" && (
          <button type="button" className="quiet-button" onClick={onStop}>
            <StopIcon />
            停止
          </button>
        )}
      </header>
      {run.input && (
        <p className="flow-run-input">
          <span>输入</span>
          {run.input}
        </p>
      )}
      {run.error && <p className="banner is-warning">{run.error}</p>}
      <ol className="flow-run-steps">
        {run.steps.map((entry, index) => {
          const shown = open.has(index) || (entry.status === "failed" && !open.has(-index - 1));
          const detail = entry.input || entry.output || entry.error;
          return (
            <li key={index} className={`flow-run-step is-${entry.status}`} style={{ marginLeft: depthOf(entry) * 18 }}>
              <button
                type="button"
                className="flow-run-row"
                aria-expanded={shown}
                disabled={!detail}
                onClick={() =>
                  setOpen((current) => {
                    const next = new Set(current);
                    if (shown) {
                      next.delete(index);
                      next.add(-index - 1);
                    } else {
                      next.add(index);
                      next.delete(-index - 1);
                    }
                    return next;
                  })
                }
              >
                <span className="flow-run-dot" aria-hidden="true">
                  {entry.status === "running" ? <Spinner /> : null}
                </span>
                <span className="flow-run-name">
                  {entry.name}
                  {entry.round && <em>第 {entry.round.join("-")} 轮</em>}
                  {entry.branch && <em>{entry.branch === "then" ? "→ 成立" : "→ 不成立"}</em>}
                  {entry.exitCode !== undefined && <em>退出码 {entry.exitCode}</em>}
                </span>
                <span className="flow-run-took">{RUN_WORD[entry.status] === "运行中" ? took(entry.startedAt) : took(entry.startedAt, entry.endedAt)}</span>
                {detail && (
                  <span className={shown ? "flow-run-caret is-open" : "flow-run-caret"}>
                    <ChevronIcon />
                  </span>
                )}
              </button>
              {entry.session && (
                <button type="button" className="flow-run-session" onClick={() => onOpenSession(entry.session!.tool, entry.session!.id)}>
                  <ToolIcon tool={entry.session.tool} size={14} />
                  打开会话
                </button>
              )}
              {shown && detail && (
                <div className="flow-run-detail">
                  {entry.error && <p className="flow-run-error">{entry.error}</p>}
                  {entry.input && (
                    <>
                      <span>{entry.kind === "ai" || entry.kind === "model" ? "发送" : entry.kind === "command" ? "命令" : "检查"}</span>
                      <pre>{entry.input}</pre>
                    </>
                  )}
                  {entry.output && (
                    <>
                      <span>输出</span>
                      <pre>{entry.output}</pre>
                    </>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// ---------------- The page ----------------

export function Workflows({
  variant,
  catalog,
  tools,
  onOpenSession,
}: {
  /** "desk": list beside the editor. "page": a phone screen, one thing at a time. */
  variant: "desk" | "page";
  catalog: Catalog | null;
  tools: ToolId[];
  onOpenSession: (tool: ToolId, id: string) => void;
}) {
  const phone = variant === "page";
  const [flows, setFlows] = useState<Workflow[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState<"edit" | "runs">("edit");
  const [selected, setSelected] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const workspaces = useMemo(() => workspacesOf(catalog), [catalog]);
  const [models, setModels] = useState<ModelView[] | null>(null);
  useEffect(() => {
    api
      .models()
      .then((result) => setModels(result.models))
      .catch(() => setModels([]));
  }, []);
  const usable = tools.length ? tools : (["claude"] as ToolId[]);

  const load = useCallback(async () => {
    try {
      setFlows((await api.workflows()).workflows);
    } catch (failure) {
      setError(errorWord((failure as { code?: string }).code));
    }
  }, []);
  useEffect(() => void load(), [load]);

  const pick = (flow: Workflow | null) => {
    if (dirty && !window.confirm("有没保存的修改，放弃吗？")) return false;
    setDraft(flow ? { id: flow.id, name: flow.name, workspace: flow.workspace, steps: flow.steps } : null);
    setDirty(false);
    setSelected(null);
    setRun(null);
    setRuns([]);
    setTab("edit");
    setError("");
    return true;
  };

  // The desk opens on the first workflow; a phone starts from the list.
  useEffect(() => {
    if (!phone && flows && !draft && flows[0]) pick(flows[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flows, phone]);

  const loadRuns = useCallback(async (id?: string) => {
    if (!id) return;
    try {
      setRuns((await api.workflowRuns(id)).runs);
    } catch {
      /* the list just stays as it was */
    }
  }, []);
  useEffect(() => {
    if (tab === "runs") void loadRuns(draft?.id);
  }, [tab, draft?.id, loadRuns]);

  // A running run is read again every 1.5 s until it ends.
  useEffect(() => {
    if (!run || run.status !== "running") return;
    const timer = window.setInterval(async () => {
      try {
        const next = await api.workflowRun(run.id);
        setRun(next);
        if (next.status !== "running") void loadRuns(next.workflowId);
      } catch {
        /* tried again next tick */
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [run, loadRuns]);

  const change = (next: Partial<Draft>) => {
    setDraft((current) => (current ? { ...current, ...next } : current));
    setDirty(true);
  };
  const changeSteps = (fn: (steps: WorkflowStep[]) => WorkflowStep[]) => {
    setDraft((current) => (current ? { ...current, steps: fn(current.steps) } : current));
    setDirty(true);
  };

  const create = () => {
    if (!pick(null)) return;
    setDraft({ name: "新工作流", workspace: workspaces[0] ?? "", steps: [] });
    setDirty(true);
  };

  const save = async (): Promise<Workflow | null> => {
    if (!draft) return null;
    setBusy(true);
    setError("");
    try {
      const saved = await api.saveWorkflow({ name: draft.name, workspace: draft.workspace, steps: draft.steps }, draft.id);
      setDraft((current) => (current ? { ...current, id: saved.id } : current));
      setDirty(false);
      await load();
      return saved;
    } catch (failure) {
      setError(errorWord((failure as { code?: string }).code));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    const saved = dirty || !draft?.id ? await save() : null;
    const id = saved?.id ?? draft?.id;
    if (!id) return;
    setBusy(true);
    setError("");
    try {
      const started = await api.runWorkflow(id, input);
      setRun(started);
      setTab("runs");
      void loadRuns(id);
    } catch (failure) {
      setError(errorWord((failure as { code?: string }).code));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!draft) return;
    if (!window.confirm(`删除工作流“${draft.name}”和它的运行记录？`)) return;
    if (draft.id) {
      try {
        await api.deleteWorkflow(draft.id);
      } catch (failure) {
        setError(errorWord((failure as { code?: string }).code));
        return;
      }
    }
    setDirty(false);
    setDraft(null);
    await load();
  };

  const openRun = async (id: string) => {
    try {
      setRun(await api.workflowRun(id));
    } catch (failure) {
      setError(errorWord((failure as { code?: string }).code));
    }
  };

  const stop = async () => {
    if (!run) return;
    try {
      setRun(await api.stopWorkflowRun(run.id));
    } catch {
      /* the next read shows where it is */
    }
  };

  const names = draft ? new Set(flatten(draft.steps).map((step) => step.name)) : new Set<string>();
  const add = (slot: Slot, kind: WorkflowStep["kind"]) => {
    const step = blankStep(kind, names, usable[0]);
    changeSteps((steps) => insertStep(steps, slot, step));
    setSelected(step.id);
  };
  const current = draft && selected ? findStep(draft.steps, selected) : null;

  // ---- pieces ----

  const grouped = useMemo(() => {
    const groups = new Map<string, Workflow[]>();
    for (const flow of flows ?? []) {
      const key = flow.workspace.replace(/[\\/]+$/, "").toLowerCase();
      groups.set(key, [...(groups.get(key) ?? []), flow]);
    }
    return [...groups.values()];
  }, [flows]);

  const list = (
    <div className="flow-list">
      {flows === null ? (
        <p className="blank">正在读取…</p>
      ) : flows.length === 0 ? (
        <div className="flow-empty">
          <span className="flow-empty-icon">
            <FlowIcon size={28} />
          </span>
          <p>把 AI 工具和命令串成一条流水线：按顺序执行、按条件分支、循环到满足为止，上一步的结果交给下一步。</p>
          <button type="button" className="quiet-button is-primary" onClick={create}>
            <PlusIcon />
            新建工作流
          </button>
        </div>
      ) : (
        grouped.map((group) => (
          <section key={group[0].workspace} className="flow-list-group">
            <h3 title={group[0].workspace}>{folderName(group[0].workspace)}</h3>
            <ul>
              {group.map((flow) => (
                <li key={flow.id}>
                  <button
                    type="button"
                    className={draft?.id === flow.id ? "flow-list-item is-on" : "flow-list-item"}
                    aria-current={draft?.id === flow.id ? "page" : undefined}
                    onClick={() => pick(flow)}
                  >
                    <span className="flow-list-name">{flow.name}</span>
                    <span className="flow-list-meta">{flatten(flow.steps).length} 步</span>
                    {phone && (
                      <span className="flow-list-caret">
                        <ChevronIcon />
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );

  const editor = draft && (
    <div className={`flow-editor${current ? " has-step" : ""}`}>
      <div className="flow-canvas">
        <div className="flow-meta">
          <label className="flow-field">
            <span>工作区</span>
            <Select
              ariaLabel="工作区"
              placeholder="选择工作区"
              searchHint="文件夹名或路径"
              value={draft.workspace}
              onChange={(workspace) => change({ workspace })}
              options={[
                ...(draft.workspace && !workspaces.includes(draft.workspace) ? [{ value: draft.workspace, label: folderName(draft.workspace), hint: draft.workspace }] : []),
                ...workspaces.map((path) => ({ value: path, label: folderName(path), hint: path, icon: <FolderIcon /> })),
              ]}
            />
          </label>
        </div>
        <div className="flow-start">
          <span className="flow-start-dot" />
          开始
          <input value={input} placeholder="本次的输入 {{输入}}（可不填）" onChange={(event) => setInput(event.target.value)} />
        </div>
        <Blocks
          steps={draft.steps}
          slot={{ parent: null, key: "steps" }}
          selected={selected}
          onSelect={(id) => setSelected((now) => (now === id && !phone ? null : id))}
          onAdd={add}
          onMove={(id, by) => changeSteps((steps) => moveStep(steps, id, by))}
          onRemove={(id) => {
            changeSteps((steps) => removeStep(steps, id));
            if (selected === id) setSelected(null);
          }}
        />
      </div>
      {current && (
        <aside className="flow-side" aria-label="步骤设置">
          {phone && <div className="flow-sheet-backdrop" onClick={() => setSelected(null)} />}
          <div className="flow-side-inner">
            <header className="flow-side-head">
              <span className="flow-card-mark">
                <StepMark step={current.kind === "ai" ? { kind: "ai", tool: current.tool } : current} />
              </span>
              <h3>{KIND_WORD[current.kind]}步骤</h3>
              <button type="button" className="icon-button" aria-label="关闭" onClick={() => setSelected(null)}>
                <CloseIcon />
              </button>
            </header>
            <StepSettings
              key={current.id}
              step={current}
              steps={draft.steps}
              tools={usable}
              workspace={draft.workspace}
              catalog={catalog}
              models={models}
              onChange={(next) => changeSteps((steps) => updateStep(steps, current.id, () => next))}
            />
          </div>
        </aside>
      )}
    </div>
  );

  const runsPane = draft && (
    <div className="flow-runs">
      {run ? (
        <>
          <button type="button" className="flow-back-link" onClick={() => setRun(null)}>
            <BackIcon />
            全部运行记录
          </button>
          <RunView run={run} onOpenSession={onOpenSession} onStop={() => void stop()} />
        </>
      ) : !draft.id ? (
        <p className="blank">保存后才有运行记录。</p>
      ) : runs.length === 0 ? (
        <p className="blank">还没有运行过。</p>
      ) : (
        <ul className="flow-run-list">
          {runs.map((item) => (
            <li key={item.id}>
              <button type="button" className="flow-run-item" onClick={() => void openRun(item.id)}>
                <span className={`flow-status is-${item.status}`}>
                  {item.status === "running" && <Spinner />}
                  {RUN_WORD[item.status]}
                </span>
                <span className="flow-run-item-text">
                  {when(item.startedAt)}
                  {item.input && <em>{item.input.slice(0, 40)}</em>}
                </span>
                <span className="flow-run-took">{took(item.startedAt, item.endedAt)}</span>
                <ChevronIcon />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  const head = draft && (
    <header className="flow-head">
      {phone && (
        <button type="button" className="icon-button settings-back" aria-label="返回工作流列表" onClick={() => pick(null)}>
          <BackIcon />
        </button>
      )}
      <input className="flow-name" value={draft.name} maxLength={60} aria-label="工作流名称" onChange={(event) => change({ name: event.target.value })} />
      <span className="flow-head-actions">
        {dirty && (
          <button type="button" className="quiet-button" disabled={busy} onClick={() => void save()}>
            保存
          </button>
        )}
        <button type="button" className="quiet-button is-primary" disabled={busy || !draft.steps.length || run?.status === "running"} onClick={() => void start()}>
          {busy ? <Spinner /> : <PlayIcon />}
          运行
        </button>
        <button type="button" className="icon-button" aria-label="删除工作流" title="删除工作流" onClick={() => void remove()}>
          <TrashIcon />
        </button>
      </span>
    </header>
  );

  const tabs = draft && (
    <nav className="flow-tabs" role="tablist">
      {(["edit", "runs"] as const).map((key) => (
        <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? "is-on" : ""} onClick={() => setTab(key)}>
          {key === "edit" ? "编辑" : "运行记录"}
          {key === "runs" && run?.status === "running" && <span className="flow-tab-live" />}
        </button>
      ))}
    </nav>
  );

  const body: ReactNode = draft ? (
    <>
      {head}
      {tabs}
      {error && <p className="banner is-warning flow-error">{error}</p>}
      {tab === "edit" ? editor : runsPane}
    </>
  ) : null;

  if (phone) {
    return (
      <section className={`flow-page is-phone${draft ? " is-detail" : ""}`} aria-label="工作流">
        {draft ? (
          body
        ) : (
          <>
            <header className="flow-phone-head">
              <h2>工作流</h2>
              <button type="button" className="icon-button" aria-label="新建工作流" onClick={create}>
                <PlusIcon />
              </button>
            </header>
            {error && <p className="banner is-warning flow-error">{error}</p>}
            {list}
          </>
        )}
      </section>
    );
  }

  return (
    <div className="flow-page plugin-desk">
      <nav className="plugin-desk-nav" aria-label="工作流">
        <header className="plugin-desk-head">
          <h2>工作流</h2>
          <button type="button" className="icon-button" aria-label="新建工作流" title="新建工作流" onClick={create}>
            <PlusIcon />
          </button>
        </header>
        {list}
      </nav>
      <section className="plugin-desk-main flow-main">
        {body ?? (flows?.length ? <p className="blank">选一个工作流，或新建一个。</p> : null)}
      </section>
    </div>
  );
}
