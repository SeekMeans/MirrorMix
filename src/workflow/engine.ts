import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ToolId } from "../shared/types";
import type {
  RunSummary,
  StepRun,
  Workflow,
  WorkflowCondition,
  WorkflowRun,
  WorkflowStep,
} from "./types";

export class WorkflowError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

const TOOLS: ToolId[] = ["claude", "codex", "cursor", "deepseek"];
const OPS: WorkflowCondition["op"][] = ["contains", "not_contains", "equals", "not_equals", "matches", "empty", "not_empty"];
/** How much of a step's output is kept: enough to pass on, not a whole build log. */
const OUTPUT_LIMIT = 200_000;
const RUNS_KEPT = 30;
const MAX_STEPS = 200;

// ---------- Shape checks: a workflow comes from the page, so everything in it is checked. ----------

const text = (value: unknown, limit = 20_000): string => (typeof value === "string" ? value.slice(0, limit) : "");

function condition(value: unknown): WorkflowCondition {
  const raw = (value ?? {}) as Record<string, unknown>;
  const op = OPS.includes(raw.op as WorkflowCondition["op"]) ? (raw.op as WorkflowCondition["op"]) : "contains";
  return { source: text(raw.source, 2_000), op, value: text(raw.value, 2_000) };
}

function steps(value: unknown, count: { n: number }): WorkflowStep[] {
  if (!Array.isArray(value)) return [];
  const out: WorkflowStep[] = [];
  for (const item of value) {
    if (++count.n > MAX_STEPS) throw new WorkflowError(400, "too_many_steps");
    const raw = (item ?? {}) as Record<string, unknown>;
    const id = typeof raw.id === "string" && /^[\w-]{1,40}$/.test(raw.id) ? raw.id : randomUUID().slice(0, 8);
    const name = text(raw.name, 40).trim() || "步骤";
    const minutes = (v: unknown) => (typeof v === "number" && v > 0 ? Math.min(v, 24 * 60) : undefined);
    if (raw.kind === "ai") {
      const tool = TOOLS.includes(raw.tool as ToolId) ? (raw.tool as ToolId) : "claude";
      out.push({ id, name, kind: "ai", tool, session: text(raw.session, 200) || "new", prompt: text(raw.prompt), timeoutMin: minutes(raw.timeoutMin) });
    } else if (raw.kind === "model") {
      out.push({
        id,
        name,
        kind: "model",
        modelId: text(raw.modelId, 100),
        system: text(raw.system),
        prompt: text(raw.prompt),
        json: raw.json === true,
        timeoutMin: minutes(raw.timeoutMin),
      });
    } else if (raw.kind === "command") {
      out.push({
        id,
        name,
        kind: "command",
        command: text(raw.command, 8_000),
        cwd: text(raw.cwd, 1_000) || undefined,
        failOnError: raw.failOnError !== false,
        timeoutMin: minutes(raw.timeoutMin),
      });
    } else if (raw.kind === "if") {
      out.push({ id, name, kind: "if", condition: condition(raw.condition), then: steps(raw.then, count), else: steps(raw.else, count) });
    } else if (raw.kind === "loop") {
      const max = typeof raw.max === "number" ? Math.max(1, Math.min(100, Math.floor(raw.max))) : 3;
      out.push({
        id,
        name,
        kind: "loop",
        mode: raw.mode === "each" ? "each" : "until",
        condition: condition(raw.condition),
        list: text(raw.list, 2_000),
        max,
        body: steps(raw.body, count),
      });
    }
  }
  return out;
}

export function normalizeWorkflow(value: unknown, existing?: Workflow): Workflow {
  const raw = (value ?? {}) as Record<string, unknown>;
  const name = text(raw.name, 60).trim();
  const workspace = text(raw.workspace, 1_000).trim();
  if (!name) throw new WorkflowError(400, "name_required");
  if (!workspace) throw new WorkflowError(400, "workspace_required");
  const now = new Date().toISOString();
  return {
    id: existing?.id ?? randomUUID().replace(/-/g, "").slice(0, 16),
    name,
    workspace,
    steps: steps(raw.steps, { n: 0 }),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

// ---------- References: {{输入}}, {{步骤名.输出}}, {{步骤名.退出码}}, {{步骤名.字段}} (from a JSON reply), {{循环.当前项}}. ----------

export interface Scope {
  input: string;
  results: Map<string, { output: string; exitCode?: number }>;
  loop?: { item: string; round: number };
}

function jsonField(output: string, field: string[]): string {
  // A reply often wraps its JSON in a code fence or a sentence; the first {...} or [...] block is taken.
  const found = output.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ?? output.match(/[[{][\s\S]*[\]}]/)?.[0];
  if (!found) return "";
  try {
    let value: unknown = JSON.parse(found);
    for (const key of field) value = (value as Record<string, unknown> | undefined)?.[key];
    if (value === undefined || value === null) return "";
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return "";
  }
}

export function fillIn(template: string, scope: Scope): string {
  return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, ref: string) => {
    const [head, ...rest] = ref.split(".").map((part) => part.trim());
    if (head === "输入" || head === "input") return scope.input;
    if (head === "循环" || head === "loop") {
      if (!scope.loop) return "";
      return rest[0] === "次数" || rest[0] === "round" ? String(scope.loop.round) : scope.loop.item;
    }
    const result = scope.results.get(head);
    if (!result) return "";
    const field = rest.join(".");
    if (!field || field === "输出" || field === "output") return result.output;
    if (field === "退出码" || field === "exitCode") return result.exitCode === undefined ? "" : String(result.exitCode);
    return jsonField(result.output, rest);
  });
}

export function holds(rule: WorkflowCondition, scope: Scope): boolean {
  const source = fillIn(rule.source, scope).trim();
  const value = fillIn(rule.value, scope).trim();
  switch (rule.op) {
    case "contains":
      return source.includes(value);
    case "not_contains":
      return !source.includes(value);
    case "equals":
      return source === value;
    case "not_equals":
      return source !== value;
    case "empty":
      return source === "";
    case "not_empty":
      return source !== "";
    case "matches":
      try {
        return new RegExp(value, "m").test(source);
      } catch {
        return false;
      }
  }
}

// ---------- What a step needs from the rest of MirrorMix. ----------

export interface AiRequest {
  tool: ToolId;
  /** null: a new session in `workspace`. */
  sessionId: string | null;
  workspace: string;
  prompt: string;
  timeoutMs: number;
  signal: AbortSignal;
  /** Called as soon as the session is known, so the run can link to it while it replies. */
  onSession: (id: string) => void;
}

export interface CommandRequest {
  command: string;
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface ModelRequest {
  modelId: string;
  system: string;
  prompt: string;
  json: boolean;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface WorkflowDeps {
  /** Where workflows and their runs are kept (~/.mirrormix). */
  dir: string;
  ai: (request: AiRequest) => Promise<{ output: string; sessionId: string }>;
  command?: (request: CommandRequest) => Promise<{ output: string; exitCode: number }>;
  /** A model from 设置 → 模型管理. */
  model?: (request: ModelRequest) => Promise<string>;
}

export interface WorkflowEngine {
  list(): Workflow[];
  get(id: string): Workflow;
  save(value: unknown, id?: string): Workflow;
  remove(id: string): void;
  run(id: string, input: string): WorkflowRun;
  stop(runId: string): WorkflowRun;
  runs(workflowId: string): RunSummary[];
  getRun(runId: string): WorkflowRun;
  /** Resolves when the run ends (for tests). */
  settled(runId: string): Promise<void>;
}

class Stopped extends Error {}

/** Runs a command through the system shell, collecting what it prints. */
export function runShell(request: CommandRequest): Promise<{ output: string; exitCode: number }> {
  return new Promise((resolve) => {
    const windows = process.platform === "win32";
    const child = windows
      ? spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${request.command}`], {
          cwd: request.cwd,
          windowsHide: true,
        })
      : spawn("/bin/sh", ["-c", request.command], { cwd: request.cwd });
    let output = "";
    const take = (chunk: Buffer) => {
      if (output.length < OUTPUT_LIMIT) output += chunk.toString("utf8");
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const kill = () => {
      if (windows && child.pid) spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
      else child.kill("SIGTERM");
    };
    let note = "";
    const timer = setTimeout(() => {
      note = "\n[超时，已停止]";
      kill();
    }, request.timeoutMs);
    const onAbort = () => {
      note = "\n[已停止]";
      kill();
    };
    request.signal.addEventListener("abort", onAbort, { once: true });
    const finish = (exitCode: number) => {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", onAbort);
      resolve({ output: (output + note).slice(0, OUTPUT_LIMIT), exitCode });
    };
    child.on("error", (error) => {
      output += String(error.message);
      finish(127);
    });
    child.on("close", (code) => finish(code ?? 1));
  });
}

export function createWorkflowEngine(deps: WorkflowDeps): WorkflowEngine {
  const flowsDir = path.join(deps.dir, "workflows");
  const runsDir = path.join(deps.dir, "workflow-runs");
  const command = deps.command ?? runShell;
  const live = new Map<string, { run: WorkflowRun; abort: AbortController; done: Promise<void> }>();

  const writeJson = (file: string, value: unknown) => {
    mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(value, null, 2));
    renameSync(temp, file);
  };
  const readJson = <T>(file: string): T | null => {
    try {
      return JSON.parse(readFileSync(file, "utf8")) as T;
    } catch {
      return null;
    }
  };
  const safeId = (id: string) => {
    if (!/^[\w-]{1,64}$/.test(id)) throw new WorkflowError(404, "not_found");
    return id;
  };
  const flowFile = (id: string) => path.join(flowsDir, `${safeId(id)}.json`);
  const runFile = (id: string) => path.join(runsDir, `${safeId(id)}.json`);

  const allRuns = (): WorkflowRun[] => {
    if (!existsSync(runsDir)) return [];
    return readdirSync(runsDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => readJson<WorkflowRun>(path.join(runsDir, name)))
      .filter((run): run is WorkflowRun => Boolean(run));
  };

  // A run that was going when MirrorMix stopped cannot carry on: its steps' processes went with it.
  for (const run of allRuns()) {
    if (run.status !== "running") continue;
    run.status = "failed";
    run.error = "MirrorMix 重启，运行中断";
    run.endedAt = new Date().toISOString();
    for (const step of run.steps) if (step.status === "running") step.status = "stopped";
    writeJson(runFile(run.id), run);
  }

  const list = (): Workflow[] => {
    if (!existsSync(flowsDir)) return [];
    return readdirSync(flowsDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => readJson<Workflow>(path.join(flowsDir, name)))
      .filter((flow): flow is Workflow => Boolean(flow))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  };

  const get = (id: string): Workflow => {
    const flow = readJson<Workflow>(flowFile(id));
    if (!flow) throw new WorkflowError(404, "not_found");
    return flow;
  };

  const save = (value: unknown, id?: string): Workflow => {
    const flow = normalizeWorkflow(value, id ? get(id) : undefined);
    writeJson(flowFile(flow.id), flow);
    return flow;
  };

  const remove = (id: string) => {
    for (const entry of live.values()) if (entry.run.workflowId === id) throw new WorkflowError(409, "running");
    rmSync(flowFile(id), { force: true });
    for (const run of allRuns()) if (run.workflowId === id) rmSync(runFile(run.id), { force: true });
  };

  const prune = (workflowId: string) => {
    const old = allRuns()
      .filter((run) => run.workflowId === workflowId && run.status !== "running")
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(RUNS_KEPT);
    for (const run of old) rmSync(runFile(run.id), { force: true });
  };

  const run = (id: string, input: string): WorkflowRun => {
    const flow = get(id);
    for (const entry of live.values()) if (entry.run.workflowId === id) throw new WorkflowError(409, "running");
    if (!flow.steps.length) throw new WorkflowError(400, "no_steps");
    const record: WorkflowRun = {
      id: randomUUID().replace(/-/g, "").slice(0, 16),
      workflowId: flow.id,
      workflowName: flow.name,
      status: "running",
      input: text(input),
      startedAt: new Date().toISOString(),
      steps: [],
    };
    const abort = new AbortController();
    const save = () => writeJson(runFile(record.id), record);
    save();

    const scope: Scope = { input: record.input, results: new Map() };
    // AI sessions an earlier step used, for "step:<id>".
    const sessions = new Map<string, string>();

    const begin = (step: WorkflowStep, rounds: number[]): StepRun => {
      const entry: StepRun = {
        stepId: step.id,
        name: step.name,
        kind: step.kind,
        status: "running",
        startedAt: new Date().toISOString(),
        ...(rounds.length ? { round: [...rounds] } : {}),
      };
      record.steps.push(entry);
      save();
      return entry;
    };
    const end = (entry: StepRun, status: StepRun["status"]) => {
      entry.status = status;
      entry.endedAt = new Date().toISOString();
      save();
    };

    const execute = async (list: WorkflowStep[], rounds: number[]): Promise<void> => {
      for (const step of list) {
        if (abort.signal.aborted) throw new Stopped();
        const entry = begin(step, rounds);
        try {
          if (step.kind === "ai") {
            const prompt = fillIn(step.prompt, scope).trim();
            entry.input = prompt;
            if (!prompt) throw new Error("提示词为空");
            const earlier = step.session.startsWith("step:") ? sessions.get(step.session.slice(5)) : undefined;
            if (step.session.startsWith("step:") && !earlier) throw new Error("要接着的那一步还没有会话");
            const sessionId = step.session === "new" ? null : earlier ?? step.session;
            const reply = await deps.ai({
              tool: step.tool,
              sessionId,
              workspace: flow.workspace,
              prompt,
              timeoutMs: (step.timeoutMin ?? 30) * 60_000,
              signal: abort.signal,
              onSession: (sid) => {
                entry.session = { tool: step.tool, id: sid };
                save();
              },
            });
            sessions.set(step.id, reply.sessionId);
            entry.session = { tool: step.tool, id: reply.sessionId };
            entry.output = reply.output.slice(0, OUTPUT_LIMIT);
            scope.results.set(step.name, { output: entry.output });
            end(entry, "ok");
          } else if (step.kind === "model") {
            if (!deps.model) throw new Error("模型管理不可用");
            if (!step.modelId) throw new Error("还没选模型");
            const system = fillIn(step.system, scope).trim();
            const prompt = fillIn(step.prompt, scope).trim();
            entry.input = system ? `【提示词框架】\n${system}\n\n【提示词】\n${prompt}` : prompt;
            if (!prompt) throw new Error("提示词为空");
            const reply = await deps.model({
              modelId: step.modelId,
              system,
              prompt,
              json: step.json === true,
              timeoutMs: (step.timeoutMin ?? 10) * 60_000,
              signal: abort.signal,
            });
            if (abort.signal.aborted) throw new Stopped();
            entry.output = reply.slice(0, OUTPUT_LIMIT);
            scope.results.set(step.name, { output: entry.output });
            end(entry, "ok");
          } else if (step.kind === "command") {
            const line = fillIn(step.command, scope).trim();
            entry.input = line;
            if (!line) throw new Error("命令为空");
            const cwd = step.cwd ? path.resolve(flow.workspace, fillIn(step.cwd, scope)) : flow.workspace;
            const result = await command({ command: line, cwd, timeoutMs: (step.timeoutMin ?? 30) * 60_000, signal: abort.signal });
            if (abort.signal.aborted) throw new Stopped();
            entry.output = result.output;
            entry.exitCode = result.exitCode;
            scope.results.set(step.name, { output: result.output, exitCode: result.exitCode });
            if (result.exitCode !== 0 && step.failOnError !== false) {
              entry.error = `退出码 ${result.exitCode}`;
              end(entry, "failed");
              throw new Error(`“${step.name}”失败：退出码 ${result.exitCode}`);
            }
            end(entry, "ok");
          } else if (step.kind === "if") {
            const yes = holds(step.condition, scope);
            entry.branch = yes ? "then" : "else";
            entry.input = fillIn(step.condition.source, scope).slice(0, 2_000);
            save();
            await execute(yes ? step.then : step.else, rounds);
            end(entry, "ok");
          } else {
            const items =
              step.mode === "each"
                ? fillIn(step.list ?? "", scope)
                    .split(/\r?\n/)
                    .map((line) => line.trim())
                    .filter(Boolean)
                    .slice(0, step.max)
                : [];
            const total = step.mode === "each" ? items.length : step.max;
            let round = 0;
            let met = false;
            while (round < total) {
              round += 1;
              const outer = scope.loop;
              scope.loop = { item: step.mode === "each" ? items[round - 1] : String(round), round };
              try {
                await execute(step.body, [...rounds, round]);
              } finally {
                scope.loop = outer;
              }
              if (step.mode === "until" && step.condition && holds(step.condition, scope)) {
                met = true;
                break;
              }
            }
            entry.output = step.mode === "each" ? `${round} 项` : met ? `第 ${round} 轮满足条件` : `${round} 轮后仍未满足条件`;
            end(entry, "ok");
          }
        } catch (error) {
          if (entry.status === "running") {
            const stopped = error instanceof Stopped || abort.signal.aborted;
            if (!stopped && !entry.error) entry.error = (error as Error).message;
            end(entry, stopped ? "stopped" : "failed");
          }
          throw error;
        }
      }
    };

    const done = (async () => {
      try {
        await execute(flow.steps, []);
        record.status = "ok";
      } catch (error) {
        const stopped = error instanceof Stopped || abort.signal.aborted;
        record.status = stopped ? "stopped" : "failed";
        if (!stopped) record.error = (error as Error).message;
      } finally {
        record.endedAt = new Date().toISOString();
        save();
        live.delete(record.id);
        prune(flow.id);
      }
    })();
    live.set(record.id, { run: record, abort, done });
    return record;
  };

  const getRun = (runId: string): WorkflowRun => {
    const held = live.get(runId);
    if (held) return held.run;
    const stored = readJson<WorkflowRun>(runFile(runId));
    if (!stored) throw new WorkflowError(404, "not_found");
    return stored;
  };

  const stop = (runId: string): WorkflowRun => {
    const held = live.get(runId);
    if (held) held.abort.abort();
    return getRun(runId);
  };

  const runs = (workflowId: string): RunSummary[] => {
    const found = new Map<string, WorkflowRun>();
    for (const stored of allRuns()) if (stored.workflowId === workflowId) found.set(stored.id, stored);
    for (const entry of live.values()) if (entry.run.workflowId === workflowId) found.set(entry.run.id, entry.run);
    return [...found.values()]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map(({ steps: done, ...rest }) => ({ ...rest, stepCount: done.length }));
  };

  return {
    list,
    get,
    save,
    remove,
    run,
    stop,
    runs,
    getRun,
    settled: async (runId) => {
      await live.get(runId)?.done;
    },
  };
}
