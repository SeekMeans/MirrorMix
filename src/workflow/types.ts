import type { ToolId } from "../shared/types";

/**
 * A rule a condition or a loop checks. `source` is text with `{{…}}` references (an earlier step's output or exit
 * code); `value` is what it is compared with.
 */
export interface WorkflowCondition {
  source: string;
  op: "contains" | "not_contains" | "equals" | "not_equals" | "matches" | "empty" | "not_empty";
  value: string;
}

interface StepBase {
  id: string;
  /** How later steps refer to it: `{{name.输出}}`. */
  name: string;
}

/**
 * Sends a prompt to an AI tool and waits for the reply to finish. `session`: "new" opens a fresh session in the
 * workflow's workspace, "step:<id>" carries on in the session an earlier AI step used, anything else is a session id.
 */
export interface AiStep extends StepBase {
  kind: "ai";
  tool: ToolId;
  session: string;
  prompt: string;
  /** Minutes before the step gives up waiting; 30 when unset. */
  timeoutMin?: number;
}

/**
 * Asks a model added in 设置 → 模型管理 directly (no session, no tools): `system` is the prompt framework (role,
 * rules, output format), `prompt` the request with references filled in. The reply's text is the output.
 */
export interface ModelStep extends StepBase {
  kind: "model";
  modelId: string;
  system: string;
  prompt: string;
  /** Asks for a JSON object, so later steps can read its fields. */
  json?: boolean;
  timeoutMin?: number;
}

/** Runs a command in the workspace (or `cwd`, relative to it). Its output and exit code are the step's result. */
export interface CommandStep extends StepBase {
  kind: "command";
  command: string;
  cwd?: string;
  /** Stops the workflow when the exit code is not 0. On by default. */
  failOnError?: boolean;
  timeoutMin?: number;
}

export interface IfStep extends StepBase {
  kind: "if";
  condition: WorkflowCondition;
  then: WorkflowStep[];
  else: WorkflowStep[];
}

/**
 * "until": runs its steps again until the condition holds (checked after each round), at most `max` rounds.
 * "each": runs its steps once for every line of `list`; `{{循环.当前项}}` is that line.
 */
export interface LoopStep extends StepBase {
  kind: "loop";
  mode: "until" | "each";
  condition?: WorkflowCondition;
  list?: string;
  max: number;
  body: WorkflowStep[];
}

export type WorkflowStep = AiStep | ModelStep | CommandStep | IfStep | LoopStep;

export interface Workflow {
  id: string;
  name: string;
  /** The project folder it works in. */
  workspace: string;
  steps: WorkflowStep[];
  createdAt: string;
  updatedAt: string;
}

export type RunStatus = "running" | "ok" | "failed" | "stopped";

/** One step as it ran. A loop's steps appear once per round, with `round` set. */
export interface StepRun {
  stepId: string;
  name: string;
  kind: WorkflowStep["kind"];
  status: "running" | "ok" | "failed" | "skipped" | "stopped";
  /** Loop rounds the step sits in, outermost first, counted from 1. */
  round?: number[];
  startedAt: string;
  endedAt?: string;
  /** The prompt or command after its references were filled in. */
  input?: string;
  output?: string;
  exitCode?: number;
  /** For a condition: which way it went. */
  branch?: "then" | "else";
  /** The AI session that answered, to open from the run. */
  session?: { tool: ToolId; id: string };
  error?: string;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  workflowName: string;
  status: RunStatus;
  /** What was typed when it started: `{{输入}}`. */
  input: string;
  startedAt: string;
  endedAt?: string;
  steps: StepRun[];
  error?: string;
}

/** A run in the history list, without its steps' output. */
export type RunSummary = Omit<WorkflowRun, "steps"> & { stepCount: number };
