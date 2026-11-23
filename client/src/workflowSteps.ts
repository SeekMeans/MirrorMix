import type { ToolId, WorkflowStep } from "./api";

/** Where a list of steps lives: the workflow's own list, or a slot of a condition or loop. */
export type Slot = { parent: string | null; key: "steps" | "then" | "else" | "body" };

export const newId = () => Math.random().toString(36).slice(2, 10);

/** A fresh step of a kind, named so it does not clash with the names already used. */
export function blankStep(kind: WorkflowStep["kind"], taken: Set<string>, tool: ToolId): WorkflowStep {
  const base = { ai: "AI", model: "模型", command: "命令", if: "条件", loop: "循环" }[kind];
  let name = base;
  for (let n = 2; taken.has(name); n += 1) name = `${base}${n}`;
  const id = newId();
  if (kind === "ai") return { id, name, kind, tool, session: "new", prompt: "" };
  if (kind === "model") return { id, name, kind, modelId: "", system: "", prompt: "" };
  if (kind === "command") return { id, name, kind, command: "", failOnError: true };
  if (kind === "if") return { id, name, kind, condition: { source: "", op: "contains", value: "" }, then: [], else: [] };
  return { id, name, kind, mode: "until", condition: { source: "", op: "equals", value: "0" }, list: "", max: 3, body: [] };
}

/** Every step, depth first, in the order they run. */
export function flatten(steps: WorkflowStep[]): WorkflowStep[] {
  return steps.flatMap((step) => [
    step,
    ...(step.kind === "if" ? [...flatten(step.then), ...flatten(step.else)] : step.kind === "loop" ? flatten(step.body) : []),
  ]);
}

export function findStep(steps: WorkflowStep[], id: string): WorkflowStep | null {
  return flatten(steps).find((step) => step.id === id) ?? null;
}

/** The steps that run before `id` (what its references can point at), and whether it sits inside a loop. */
export function before(steps: WorkflowStep[], id: string): { earlier: WorkflowStep[]; inLoop: boolean } {
  const earlier: WorkflowStep[] = [];
  let inLoop = false;
  const walk = (list: WorkflowStep[], loop: boolean): boolean => {
    for (const step of list) {
      if (step.id === id) {
        inLoop = loop;
        return true;
      }
      if (step.kind === "if" && (walk(step.then, loop) || walk(step.else, loop))) return true;
      if (step.kind === "loop" && walk(step.body, true)) return true;
      earlier.push(step);
    }
    return false;
  };
  walk(steps, false);
  // A step inside a loop can also use what the loop's later steps left from the round before; kept simple: earlier only.
  return { earlier, inLoop };
}

function mapLists(steps: WorkflowStep[], fn: (list: WorkflowStep[], slot: Slot) => WorkflowStep[], parent: string | null = null, key: Slot["key"] = "steps"): WorkflowStep[] {
  const mapped = steps.map((step) => {
    if (step.kind === "if") return { ...step, then: mapLists(step.then, fn, step.id, "then"), else: mapLists(step.else, fn, step.id, "else") };
    if (step.kind === "loop") return { ...step, body: mapLists(step.body, fn, step.id, "body") };
    return step;
  });
  return fn(mapped, { parent, key });
}

export function updateStep(steps: WorkflowStep[], id: string, change: (step: WorkflowStep) => WorkflowStep): WorkflowStep[] {
  return mapLists(steps, (list) => list.map((step) => (step.id === id ? change(step) : step)));
}

export function removeStep(steps: WorkflowStep[], id: string): WorkflowStep[] {
  return mapLists(steps, (list) => list.filter((step) => step.id !== id));
}

export function moveStep(steps: WorkflowStep[], id: string, by: -1 | 1): WorkflowStep[] {
  return mapLists(steps, (list) => {
    const at = list.findIndex((step) => step.id === id);
    const to = at + by;
    if (at < 0 || to < 0 || to >= list.length) return list;
    const next = [...list];
    [next[at], next[to]] = [next[to], next[at]];
    return next;
  });
}

export function insertStep(steps: WorkflowStep[], slot: Slot, step: WorkflowStep): WorkflowStep[] {
  return mapLists(steps, (list, here) => (here.parent === slot.parent && here.key === slot.key ? [...list, step] : list));
}

const OP_WORD: Record<string, string> = {
  contains: "包含",
  not_contains: "不包含",
  equals: "等于",
  not_equals: "不等于",
  matches: "匹配正则",
  empty: "为空",
  not_empty: "不为空",
};
export const OPS = Object.keys(OP_WORD);
export const opWord = (op: string) => OP_WORD[op] ?? op;

/** One line under a block's name: what it will do. */
export function summarize(step: WorkflowStep, toolName: Record<ToolId, string>): string {
  const cut = (value: string) => (value.length > 60 ? `${value.slice(0, 60)}…` : value);
  if (step.kind === "ai") return `${toolName[step.tool]} · ${step.prompt ? cut(step.prompt.replace(/\s+/g, " ")) : "还没写提示词"}`;
  if (step.kind === "command") return step.command ? cut(step.command.replace(/\s+/g, " ")) : "还没写命令";
  if (step.kind === "model") return step.prompt ? cut(step.prompt.replace(/\s+/g, " ")) : "还没写提示词";
  const rule = (step.kind === "if" ? step.condition : step.condition) ?? { source: "", op: "", value: "" };
  const said = `${rule.source || "…"} ${opWord(rule.op)}${rule.op === "empty" || rule.op === "not_empty" ? "" : ` ${rule.value || "…"}`}`;
  if (step.kind === "if") return `如果 ${cut(said)}`;
  return step.mode === "each" ? `逐行处理 ${cut(step.list || "…")}，最多 ${step.max} 项` : `重复，直到 ${cut(said)}，最多 ${step.max} 轮`;
}
