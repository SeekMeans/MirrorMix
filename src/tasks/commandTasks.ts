import { spawn as nodeSpawn, execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync, fstatSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describeTrees, readSnapshot, type TreeInfo } from "./processTree";

/** once: runs to the end (a build, a script). service: keeps running until stopped (`npm run dev`). */
export type TaskKind = "once" | "service";

export interface TaskDefinition {
  id: string;
  name: string;
  cwd: string;
  command: string;
  kind: TaskKind;
}

export type TaskStatus = "idle" | "running" | "exited" | "failed" | "stopped";

/** What one run left behind. Saved, so a server restart still knows the process it started. */
interface RunState {
  pid: number;
  startedAt: string;
  endedAt?: string;
  /** Null when the process ended while the server was not watching it. */
  exitCode?: number | null;
  stopped?: boolean;
}

export interface TaskView extends TaskDefinition {
  status: TaskStatus;
  pid?: number;
  startedAt?: string;
  endedAt?: string;
  exitCode?: number | null;
  /** Running only: the TCP ports its process tree listens on. */
  ports?: number[];
  /** Running only: the tree holds this MirrorMix server, so stopping it takes the page away. */
  self?: boolean;
}

/** What a restart helper needs to end a run and start it again on its own. */
export interface RestartJob {
  dir: string;
  id: string;
  command: string;
  cwd: string;
  oldPid: number;
}

export class TaskError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
  }
}

export interface Spawned {
  pid: number | undefined;
  onExit(callback: (code: number | null) => void): void;
}

export interface TaskHost {
  /**
   * Starts `command` through the shell in `cwd`, detached, with stdout and stderr going to `logFd`. When it ends,
   * its exit code is written to `exitFile`, which a restarted MirrorMix reads.
   */
  spawn(command: string, cwd: string, logFd: number, exitFile: string): Spawned;
  alive(pid: number): boolean;
  /** Ends the process and everything it started (npm starts node, node may start more). */
  killTree(pid: number): Promise<void>;
  /** Listening ports and whether this server is inside, for each running root process. */
  describe(roots: number[]): Promise<Map<number, TreeInfo>>;
  /** Restarts a run from outside its process tree: the way to restart the MirrorMix this code runs in. */
  handOffRestart(job: RestartJob): void;
}

const runner = fileURLToPath(new URL("./taskRunner.cjs", import.meta.url));
const restarter = fileURLToPath(new URL("./taskRestart.cjs", import.meta.url));

export const windowsHost: TaskHost = {
  spawn(command, cwd, logFd, exitFile) {
    const child = nodeSpawn(process.execPath, [runner, exitFile, cwd, command], {
      cwd,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
    return {
      pid: child.pid,
      onExit(callback) {
        child.once("exit", (code) => callback(code));
        child.once("error", () => callback(null));
      },
    };
  },
  alive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  },
  killTree(pid) {
    return new Promise((resolve) => {
      execFile("taskkill.exe", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
    });
  },
  async describe(roots) {
    return describeTrees(await readSnapshot(), roots, process.pid);
  },
  handOffRestart(job) {
    const payload = Buffer.from(JSON.stringify(job), "utf8").toString("base64");
    nodeSpawn(process.execPath, [restarter, "--hand-off", payload], { detached: true, windowsHide: true, stdio: "ignore" }).unref();
  },
};

const MAX_TASKS = 100;
/** How much of the end of the output the page gets. */
const LOG_TAIL = 64 * 1024;
/** A log larger than this is started over on the next run rather than appended to. */
const LOG_LIMIT = 4 * 1024 * 1024;

function validate(value: unknown, existingId?: string): TaskDefinition {
  if (!value || typeof value !== "object") throw new TaskError(400, "task_invalid");
  const row = value as Record<string, unknown>;
  const name = typeof row.name === "string" ? row.name.trim() : "";
  const cwd = typeof row.cwd === "string" ? row.cwd.trim() : "";
  const command = typeof row.command === "string" ? row.command.trim() : "";
  const kind = row.kind === "service" ? "service" : row.kind === "once" ? "once" : null;
  if (!name || name.length > 80 || /[\x00-\x1f]/.test(name)) throw new TaskError(400, "task_name");
  if (!command || command.length > 4000 || /[\x00-\x1f]/.test(command)) throw new TaskError(400, "task_command");
  if (!kind) throw new TaskError(400, "task_invalid");
  if (!cwd || !path.isAbsolute(cwd) || /[\x00-\x1f]/.test(cwd)) throw new TaskError(400, "task_cwd");
  let isDir = false;
  try {
    isDir = statSync(cwd).isDirectory();
  } catch {
    /* missing */
  }
  if (!isDir) throw new TaskError(400, "task_cwd");
  return { id: existingId ?? randomBytes(6).toString("hex"), name, cwd: path.resolve(cwd), command, kind };
}

function writeJson(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, file);
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")) as T;
  } catch {
    return fallback;
  }
}

export interface CommandTasks {
  list(): TaskView[];
  create(value: unknown): TaskView;
  update(id: string, value: unknown): TaskView;
  remove(id: string): Promise<void>;
  start(id: string): TaskView;
  stop(id: string): Promise<TaskView>;
  /** Stops and starts again. A run holding this MirrorMix is restarted by a helper, after this server is gone. */
  restart(id: string): Promise<TaskView>;
  /** Adds the listening ports, and whether it is this MirrorMix, to each running task. */
  inspect(views: TaskView[]): Promise<TaskView[]>;
  log(id: string): { text: string; truncated: boolean };
}

/**
 * Commands the person keeps in Settings. Each run is a detached process writing to its own log file, and its PID is
 * saved, so a long-running one (a dev server) keeps going and stays tracked when MirrorMix itself restarts.
 */
export function createCommandTasks(dir: string, host: TaskHost = windowsHost): CommandTasks {
  const tasksFile = path.join(dir, "tasks.json");
  const runsFile = path.join(dir, "task-runs.json");
  const logDir = path.join(dir, "task-logs");
  let tasks = readJson<TaskDefinition[]>(tasksFile, []).filter((task) => task && typeof task.id === "string");
  const runs = new Map<string, RunState>(Object.entries(readJson<Record<string, RunState>>(runsFile, {})));
  /** Runs started by this server process, whose exit code it will hear about. */
  const watched = new Set<string>();

  const saveTasks = () => writeJson(tasksFile, tasks);
  const saveRuns = () => writeJson(runsFile, Object.fromEntries(runs));
  const logFile = (id: string) => path.join(logDir, `${id}.log`);
  const exitFile = (id: string) => path.join(logDir, `${id}.exit`);
  /** The exit code the runner left behind, or null when it left none (killed, or the run is from an older MirrorMix). */
  const savedExit = (id: string): number | null => {
    try {
      const text = readFileSync(exitFile(id), "utf8").trim();
      return /^-?\d+$/.test(text) ? Number(text) : null;
    } catch {
      return null;
    }
  };
  const find = (id: string) => {
    const task = tasks.find((item) => item.id === id);
    if (!task) throw new TaskError(404, "task_missing");
    return task;
  };

  /** A run from before a restart whose process is gone ended while nobody was looking. */
  const settle = (id: string): RunState | undefined => {
    const run = runs.get(id);
    if (run && !run.endedAt && !watched.has(id) && !host.alive(run.pid)) {
      runs.set(id, { ...run, endedAt: new Date().toISOString(), exitCode: savedExit(id) });
      saveRuns();
      return runs.get(id);
    }
    return run;
  };

  const view = (task: TaskDefinition): TaskView => {
    const run = settle(task.id);
    if (!run) return { ...task, status: "idle" };
    const status: TaskStatus = !run.endedAt
      ? "running"
      : run.stopped
        ? "stopped"
        : run.exitCode === 0 || (run.exitCode === null && task.kind === "once")
          ? "exited"
          : "failed";
    return {
      ...task,
      status,
      pid: run.pid,
      startedAt: run.startedAt,
      ...(run.endedAt ? { endedAt: run.endedAt, exitCode: run.exitCode ?? null } : {}),
    };
  };

  const running = (id: string) => {
    const run = settle(id);
    return Boolean(run && !run.endedAt);
  };

  const stopRun = async (id: string) => {
    const run = runs.get(id);
    if (!run || run.endedAt) return;
    runs.set(id, { ...run, stopped: true });
    await host.killTree(run.pid);
    const after = runs.get(id);
    // The exit handler may already have recorded the end; otherwise record it here.
    if (after && !after.endedAt) {
      runs.set(id, { ...after, stopped: true, endedAt: new Date().toISOString(), exitCode: null });
    }
    saveRuns();
  };

  return {
    list: () => tasks.map(view),
    create(value) {
      if (tasks.length >= MAX_TASKS) throw new TaskError(400, "task_limit");
      const task = validate(value);
      tasks = [...tasks, task];
      saveTasks();
      return view(task);
    },
    update(id, value) {
      find(id);
      if (running(id)) throw new TaskError(409, "task_running");
      const task = validate(value, id);
      tasks = tasks.map((item) => (item.id === id ? task : item));
      saveTasks();
      return view(task);
    },
    async remove(id) {
      find(id);
      await stopRun(id);
      tasks = tasks.filter((item) => item.id !== id);
      runs.delete(id);
      watched.delete(id);
      saveTasks();
      saveRuns();
      for (const file of [logFile(id), exitFile(id)]) {
        try {
          unlinkSync(file);
        } catch {
          /* no log yet */
        }
      }
    },
    start(id) {
      const task = find(id);
      if (running(id)) throw new TaskError(409, "task_running");
      if (!existsSync(task.cwd) || !statSync(task.cwd).isDirectory()) throw new TaskError(409, "task_cwd");
      mkdirSync(logDir, { recursive: true });
      const file = logFile(id);
      let size = 0;
      try {
        size = statSync(file).size;
      } catch {
        /* first run */
      }
      try {
        unlinkSync(exitFile(id));
      } catch {
        /* no earlier run */
      }
      const fd = openSync(file, size > LOG_LIMIT ? "w" : "a");
      const startedAt = new Date().toISOString();
      let child: Spawned;
      try {
        writeFileSync(fd, `\n── ${startedAt}  ${task.command}\n`);
        child = host.spawn(task.command, task.cwd, fd, exitFile(id));
      } finally {
        closeSync(fd);
      }
      if (!child.pid) throw new TaskError(500, "task_spawn");
      const pid = child.pid;
      runs.set(id, { pid, startedAt });
      watched.add(id);
      saveRuns();
      child.onExit((code) => {
        watched.delete(id);
        const run = runs.get(id);
        if (!run || run.pid !== pid || run.endedAt) return;
        runs.set(id, { ...run, endedAt: new Date().toISOString(), exitCode: code });
        saveRuns();
      });
      return view(task);
    },
    async stop(id) {
      const task = find(id);
      await stopRun(id);
      return view(task);
    },
    async restart(id) {
      const task = find(id);
      const run = settle(id);
      if (!run || run.endedAt) return this.start(id);
      const info = (await host.describe([run.pid])).get(run.pid);
      if (info?.self) {
        if (!existsSync(task.cwd) || !statSync(task.cwd).isDirectory()) throw new TaskError(409, "task_cwd");
        host.handOffRestart({ dir, id, command: task.command, cwd: task.cwd, oldPid: run.pid });
        return { ...view(task), ...info };
      }
      await stopRun(id);
      return this.start(id);
    },
    async inspect(views) {
      const roots = views.filter((item) => item.status === "running" && item.pid).map((item) => item.pid!);
      if (!roots.length) return views;
      const trees = await host.describe(roots);
      return views.map((item) => {
        const info = item.status === "running" && item.pid ? trees.get(item.pid) : undefined;
        return info ? { ...item, ports: info.ports, self: info.self } : item;
      });
    },
    log(id) {
      find(id);
      let fd: number;
      try {
        fd = openSync(logFile(id), "r");
      } catch {
        return { text: "", truncated: false };
      }
      try {
        const size = fstatSync(fd).size;
        const length = Math.min(size, LOG_TAIL);
        const buffer = Buffer.alloc(length);
        readSync(fd, buffer, 0, length, size - length);
        return { text: buffer.toString("utf8"), truncated: size > length };
      } finally {
        closeSync(fd);
      }
    },
  };
}
