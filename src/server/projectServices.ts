import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MAX_SERVICES, type ProjectService, type ServiceAction, type ServiceView } from "../shared/projectServices";
import type { TerminalHub } from "./terminals";

/**
 * The programs a project runs while it is worked on (frontend, backend…), kept per project folder.
 * Each one runs in its own named terminal tab, so its output stays visible; restarting it stops only what was started
 * in that tab and types the command again, leaving the cmd.exe and its scrollback in place.
 */

export class ServiceError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
  }
}

// ── Saved list ────────────────────────────────────────────────────────────────────────────────────────────────────

function validDir(projectRoot: string, dir: string): string {
  const root = path.resolve(projectRoot);
  const plain = dir.trim().replace(/\\/g, "/").replace(/\/+$/, "").replace(/^(\.\/)+/, "").replace(/^\.$/, "");
  if (/[\x00-\x1f"%!<>|*?:]/.test(plain) || path.isAbsolute(plain)) throw new ServiceError(400, "service_dir");
  const full = path.resolve(root, plain);
  if (!inside(root, full)) throw new ServiceError(400, "service_dir");
  return plain;
}

function inside(root: string, folder: string): boolean {
  const relative = path.relative(root, folder);
  return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}

function checkServiceFolder(root: string, dir: string): void {
  const folder = path.resolve(root, dir);
  let canonical: string;
  try {
    canonical = realpathSync.native(folder);
    if (!statSync(canonical).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new ServiceError(409, "service_dir_missing");
  }
  if (!inside(realpathSync.native(root), canonical) || /[\x00-\x1f"%!]/.test(folder) || folder.startsWith("\\\\")) {
    throw new ServiceError(400, "service_dir");
  }
}

export function validateServices(root: string, value: unknown): ProjectService[] {
  if (!Array.isArray(value) || value.length > MAX_SERVICES) throw new ServiceError(400, "service_invalid");
  const names = new Set<string>();
  return value.map((item) => {
    const row = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const name = typeof row.name === "string" ? row.name.trim() : "";
    const command = typeof row.command === "string" ? row.command.trim() : "";
    if (!name || name.length > 20 || /[\x00-\x1f]/.test(name)) throw new ServiceError(400, "service_name");
    if (names.has(name)) throw new ServiceError(400, "service_duplicate");
    names.add(name);
    if (!command || command.length > 4000 || /[\x00-\x1f]/.test(command)) throw new ServiceError(400, "service_command");
    return { name, dir: validDir(root, typeof row.dir === "string" ? row.dir : ""), command };
  });
}

export interface ServiceStore {
  get(key: string): ProjectService[];
  set(key: string, root: string, value: unknown): ProjectService[];
}

export function createServiceStore(file: string): ServiceStore {
  const readAll = (): Record<string, ProjectService[]> => {
    try {
      const value = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch {
      return {};
    }
  };
  return {
    get(key) {
      const list = readAll()[key];
      return Array.isArray(list) ? list.filter((item) => item && typeof item.name === "string" && typeof item.command === "string").map((item) => ({ name: item.name, dir: typeof item.dir === "string" ? item.dir : "", command: item.command })) : [];
    },
    set(key, root, value) {
      const services = validateServices(root, value);
      const all = readAll();
      if (services.length) all[key] = services;
      else delete all[key];
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(`${file}.tmp`, `${JSON.stringify(all, null, 2)}\n`);
      renameSync(`${file}.tmp`, file);
      return services;
    },
  };
}

// ── Guessing a project's services ─────────────────────────────────────────────────────────────────────────────────

const FRONT = /^(front|frontend|web|client|ui|app|admin|portal|h5|vue|react|www|site)([-_].*)?$/i;
const BACK = /^(back|backend|server|api|service|services|svc|core|admin-api)([-_].*)?$/i;
const SKIP = /^(node_modules|\.git|\.idea|\.vscode|dist|build|target|out|coverage|\.next|\.nuxt|vendor|venv|\.venv|__pycache__|docs?|tests?|scripts?)$/i;

function readJsonFile(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch {
    return null;
  }
}

/** How a folder is started, judged from the build files in it, or null when nothing says. */
function startCommand(dir: string): { command: string; front: boolean } | null {
  const has = (name: string) => existsSync(path.join(dir, name));
  const pkg = has("package.json") ? readJsonFile(path.join(dir, "package.json")) : null;
  if (pkg) {
    const scripts = (pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {}) as Record<string, unknown>;
    const script = ["dev", "start", "serve"].find((name) => typeof scripts[name] === "string");
    if (script) {
      const runner = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lockb") || has("bun.lock") ? "bun" : "npm";
      const command = runner === "npm" ? (script === "start" ? "npm start" : `npm run ${script}`) : runner === "bun" ? `bun run ${script}` : `${runner} ${script}`;
      const deps = { ...(pkg.dependencies as object | undefined), ...(pkg.devDependencies as object | undefined) } as Record<string, unknown>;
      const front = ["vite", "react-scripts", "@vue/cli-service", "next", "nuxt", "@angular/cli", "webpack-dev-server", "@umijs/max", "umi"].some((name) => name in deps);
      return { command, front };
    }
  }
  if (has("pom.xml")) return { command: has("mvnw.cmd") ? "mvnw.cmd spring-boot:run" : "mvn spring-boot:run", front: false };
  if (has("build.gradle") || has("build.gradle.kts")) return { command: has("gradlew.bat") ? "gradlew.bat bootRun" : "gradle bootRun", front: false };
  if (has("manage.py")) return { command: "python manage.py runserver", front: false };
  if (has("go.mod")) return { command: "go run .", front: false };
  if (has("Cargo.toml")) return { command: "cargo run", front: false };
  if (has("main.py")) return { command: "python main.py", front: false };
  if (has("app.py")) return { command: "python app.py", front: false };
  return null;
}

/** The project root and its first-level folders that look startable, named 前端 / 后端 where that is clear. */
export function detectServices(root: string): ProjectService[] {
  const found: Array<ProjectService & { front: boolean }> = [];
  let folders: string[] = [];
  try {
    folders = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !SKIP.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    /* unreadable root: only the root itself is looked at */
  }
  for (const dir of folders) {
    const start = startCommand(path.join(root, dir));
    if (start) found.push({ name: dir, dir, command: start.command, front: start.front || (FRONT.test(dir) && !BACK.test(dir)) });
  }
  // The root counts only when no sub-folder does: a root package.json is often just workspace tooling.
  if (!found.length) {
    const start = startCommand(root);
    if (start) found.push({ name: path.basename(root) || "项目", dir: "", command: start.command, front: start.front });
  }
  const fronts = found.filter((item) => item.front);
  const backs = found.filter((item) => !item.front);
  const named = found.map((item) => {
    const alone = item.front ? fronts.length === 1 : backs.length === 1;
    const clear = item.front || BACK.test(item.dir) || found.length > 1;
    return { name: alone && clear ? (item.front ? "前端" : "后端") : item.name.slice(0, 20), dir: item.dir, command: item.command };
  });
  // Backends first: a frontend dev server usually proxies to it.
  named.sort((a, b) => (a.name === "后端" ? -1 : b.name === "后端" ? 1 : 0));
  const seen = new Set<string>();
  return named.filter((item) => !seen.has(item.name) && seen.add(item.name)).slice(0, MAX_SERVICES);
}

// ── Running them ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface ProcessOps {
  /** Programs whose parent is one of `parents`. */
  children(parents: number[]): Promise<Array<{ pid: number; parentPid: number; name: string }>>;
  /** Ends a program and everything it started. True once it is gone (or was already). */
  killTree(pid: number): Promise<boolean>;
}

/** The console host of a pseudo-terminal sits under the shell on some Windows builds; it is not a program the person started. */
const CONSOLE_HOSTS = new Set(["conhost.exe", "openconsole.exe"]);

export const windowsProcesses: ProcessOps = {
  children(parents) {
    const ids = parents.filter((pid) => Number.isInteger(pid) && pid > 0);
    if (!ids.length) return Promise.resolve([]);
    const filter = ids.map((pid) => `ParentProcessId=${pid}`).join(" OR ");
    const script = `Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { '' + $_.ProcessId + [char]9 + $_.ParentProcessId + [char]9 + $_.Name }`;
    return new Promise((resolve, reject) => {
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 15_000 }, (error, stdout) => {
        if (error) return reject(new ServiceError(503, "service_status"));
        resolve(
          stdout
            .split(/\r?\n/)
            .map((line) => line.trim().split("\t"))
            .filter((parts) => parts.length === 3 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1]))
            .map(([pid, parentPid, name]) => ({ pid: Number(pid), parentPid: Number(parentPid), name })),
        );
      });
    });
  },
  killTree(pid) {
    return new Promise((resolve) => {
      // 128: no such process, so it already ended.
      execFile("taskkill.exe", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, timeout: 15_000 }, (error) => {
        const code = (error as { code?: unknown } | null)?.code;
        resolve(!error || code === 128);
      });
    });
  },
};

/** The line typed into a service's tab: it moves to its folder first, in case someone cd'd elsewhere in that tab. */
export function serviceLine(root: string, service: ProjectService): string {
  const folder = path.resolve(root, service.dir);
  return `cd /d "${folder}" && ${service.command}\r`;
}

export function createServiceRunner(hub: TerminalHub, store: ServiceStore, processes: ProcessOps = windowsProcesses, waitMs = 250) {
  /** One action at a time per project, so a double click does not start a service twice. */
  const queues = new Map<string, Promise<unknown>>();
  const serial = <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const next = (queues.get(key) ?? Promise.resolve()).then(work, work);
    queues.set(key, next.catch(() => undefined));
    return next;
  };

  const startedIn = async (key: string, tids: string[]) => {
    const shells = new Map<number, string>();
    for (const tid of tids) {
      const pid = hub.pidOf(key, tid);
      if (pid) shells.set(pid, tid);
    }
    const busy = new Map<string, number[]>();
    for (const child of await processes.children([...shells.keys()])) {
      if (CONSOLE_HOSTS.has(child.name.toLowerCase())) continue;
      const tid = shells.get(child.parentPid);
      if (tid) busy.set(tid, [...(busy.get(tid) ?? []), child.pid]);
    }
    return busy;
  };

  /** Several open panels polling the same project share one lookup. */
  const looking = new Map<string, Promise<ServiceView[]>>();
  const list = (key: string): Promise<ServiceView[]> => {
    let pending = looking.get(key);
    if (!pending) {
      pending = lookUp(key).finally(() => looking.delete(key));
      looking.set(key, pending);
    }
    return pending;
  };

  const lookUp = async (key: string): Promise<ServiceView[]> => {
    const services = store.get(key);
    const tabs = new Map(services.map((service) => [service.name, hub.serviceTab(key, service.name)?.tid]));
    const busy = await startedIn(key, [...tabs.values()].filter((tid): tid is string => Boolean(tid)));
    return services.map((service) => {
      const tid = tabs.get(service.name);
      return { ...service, ...(tid ? { tid } : {}), running: Boolean(tid && busy.has(tid)) };
    });
  };

  /**
   * Ends what was started in these tabs. A process lookup costs over a second on Windows, so it is only repeated when
   * taskkill did not confirm every program ended.
   */
  const stopIn = async (key: string, busy: Map<string, number[]>) => {
    let left = busy;
    for (let attempt = 0; left.size; attempt += 1) {
      if (attempt >= 8) throw new ServiceError(500, "service_stop");
      const ended = await Promise.all([...left.values()].flat().map((pid) => processes.killTree(pid)));
      // A moment for the ports it held to be released before the command is typed again.
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      if (ended.every(Boolean)) return;
      left = await startedIn(key, [...left.keys()]);
    }
  };

  const run = (key: string, root: string, action: ServiceAction, names: string[]) =>
    serial(key, async () => {
      const services = validateServices(root, store.get(key));
      const chosen = names.length ? services.filter((service) => names.includes(service.name)) : services;
      if (!chosen.length || names.some((name) => !chosen.some((service) => service.name === name))) throw new ServiceError(404, "service_missing");
      // Checked before anything is stopped, so a restart does not end in a stopped service.
      if (action !== "stop") {
        for (const service of chosen) {
          checkServiceFolder(root, service.dir);
        }
      }
      const tabs = new Map(services.map((service) => [service.name, hub.serviceTab(key, service.name)?.tid]));
      const busy = await startedIn(key, [...tabs.values()].filter((tid): tid is string => Boolean(tid)));
      const running = new Set(busy.keys());
      if (action !== "start") {
        const ending = new Map([...busy].filter(([tid]) => chosen.some((service) => tabs.get(service.name) === tid)));
        await stopIn(key, ending);
        for (const tid of ending.keys()) running.delete(tid);
      }
      let focus: string | undefined;
      if (action !== "stop") {
        for (const service of chosen) {
          let tid = tabs.get(service.name);
          if (tid && running.has(tid)) {
            focus ??= tid;
            continue;
          }
          tid ??= hub.create(key, path.resolve(root, service.dir), service.name).tid;
          tabs.set(service.name, tid);
          hub.write(key, tid, serviceLine(root, service));
          // Taken as running from here; the next look at the processes shows whether it kept running.
          running.add(tid);
          focus ??= tid;
        }
      }
      const views: ServiceView[] = services.map((service) => {
        const tid = tabs.get(service.name);
        return { ...service, ...(tid ? { tid } : {}), running: Boolean(tid && running.has(tid)) };
      });
      return { services: views, focus };
    });

  return { list, run };
}

export type ServiceRunner = ReturnType<typeof createServiceRunner>;
