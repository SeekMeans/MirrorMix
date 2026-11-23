import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * What the Codex desktop app knows about its threads beyond the transcripts themselves:
 * the names it shows, which folders are projects, and which threads it keeps out of the list.
 */
export interface CodexDesktopState {
  /** Metadata survives when paginated history has replaced the rollout file. */
  threads: Map<string, CodexThreadMetadata>;
  /** Thread id → the name in the sidebar (a rename, or the name Codex generated). */
  names: Map<string, string>;
  /** Project folders in the order the sidebar lists them. */
  projects: string[];
  projectNames: Map<string, string>;
  /** Canonical project paths, including projects pinned through a thread with no local transcript. */
  pinnedProjects: Set<string>;
  /** Thread id → explicitly assigned project root, including threads run in a subdirectory. */
  threadRoots: Map<string, string>;
  /** Threads started without a project. */
  projectless: Set<string>;
  /** The folder Codex files project-less threads under. */
  projectlessRoot: string;
  /** Threads a parent thread spawned; the sidebar never lists them on their own. */
  subagents: Set<string>;
  archived: Set<string>;
  /** Thread id → when a person last wrote in it, which is what the sidebar sorts by. */
  recency: Map<string, string>;
  /** The active transcript when a resumed thread has multiple rollout files. */
  rolloutPaths: Map<string, string>;
  /** Unnamed CLI/exec records are indexed too, but have no desktop sidebar row. */
  cliOnly: Set<string>;
}

export interface CodexThreadMetadata {
  id: string;
  cwd: string;
  title: string;
  updatedAt: string;
  historyMode: string;
  model?: string;
  effort?: string;
}

interface Row {
  id: string;
  title: string | null;
  name: string | null;
  source: string | null;
  thread_source: string | null;
  archived: number | null;
  recency_at: number | null;
  updated_at: number | null;
  rollout_path: string | null;
  cwd: string | null;
  is_pinned: number | null;
  history_mode: string | null;
  model: string | null;
  reasoning_effort: string | null;
}

const cache = new Map<string, { signature: string; state: CodexDesktopState | null }>();
let latest: CodexDesktopState | null = null;

function stamp(file: string): string {
  try {
    const stat = statSync(file);
    return `${file}\0${stat.mtimeMs}\0${stat.size}`;
  } catch {
    return `${file}\0-`;
  }
}

/** The newest `state_N.sqlite` next to the sessions folder. */
function stateDatabase(home: string): string | null {
  let best: { file: string; version: number } | null = null;
  let names: string[];
  try {
    names = readdirSync(home);
  } catch {
    return null;
  }
  for (const name of names) {
    const match = name.match(/^state_(\d+)\.sqlite$/);
    if (!match) continue;
    const version = Number(match[1]);
    if (!best || version > best.version) best = { file: path.join(home, name), version };
  }
  return best?.file ?? null;
}

function openState(file: string) {
  // Loaded without a static import so the test runner does not try to bundle node:sqlite.
  const require = createRequire(import.meta.url);
  const sqlite = require(["node", "sqlite"].join(":")) as {
    DatabaseSync: new (location: string, options?: { readOnly?: boolean }) => {
      prepare(sql: string): { all(): unknown[] };
      close(): void;
    };
  };
  return new sqlite.DatabaseSync(file, { readOnly: true });
}

function readRows(file: string): Row[] {
  const db = openState(file);
  try {
    const columns = new Set((db.prepare("pragma table_info(threads)").all() as Array<{ name: string }>).map((column) => column.name));
    const pick = (name: string) => (columns.has(name) ? name : `null as ${name}`);
    return db
      .prepare(
        `select id, ${pick("title")}, ${pick("name")}, ${pick("source")}, ${pick("thread_source")}, ${pick("archived")}, ${pick("recency_at")}, ${pick("updated_at")}, ${pick("rollout_path")}, ${pick("cwd")}, ${pick("is_pinned")}, ${pick("history_mode")}, ${pick("model")}, ${pick("reasoning_effort")} from threads`,
      )
      .all() as Row[];
  } finally {
    db.close();
  }
}

interface ProjectRow { id: string; name: string; path: string }

function readProjects(file: string): ProjectRow[] {
  try {
    const db = openState(file);
    try {
      return db.prepare(
        "select p.id, p.name, r.path from projects p join project_roots r on r.project_id = p.id order by p.position, p.id, r.position",
      ).all() as ProjectRow[];
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function ownerAtoms(data: Record<string, unknown>): Record<string, unknown> {
  const owner = data["electron-renderer-content-owner"];
  if (typeof owner === "string") return object(data[`electron-owner-atoms:${owner}`]);
  const keys = Object.keys(data).filter((key) => key.startsWith("electron-owner-atoms:"));
  return object(data[keys.length === 1 ? keys[0] : "electron-persisted-atom-state"]);
}

/** Project order omits projects moved to custom sections; resolve those separately by their item keys. */
function projectFolders(data: Record<string, unknown>, databaseProjects: ProjectRow[]) {
  const byId = new Map<string, string[]>();
  const projectNames = new Map<string, string>();
  const isRoot = (root: string) => path.isAbsolute(root) || path.win32.isAbsolute(root);
  for (const [key, value] of Object.entries(object(data["local-projects"]))) {
    const project = object(value);
    const roots = strings(project.rootPaths).filter(isRoot);
    if (!roots.length) continue;
    byId.set(key, roots);
    if (typeof project.id === "string") byId.set(project.id, roots);
    if (typeof project.name === "string" && project.name.trim()) {
      for (const root of roots) projectNames.set(codexPathKey(root), project.name.trim());
    }
  }
  const databaseRoots = new Map<string, string[]>();
  for (const row of databaseProjects) {
    if (!isRoot(row.path)) continue;
    const roots = databaseRoots.get(row.id) ?? [];
    roots.push(row.path);
    databaseRoots.set(row.id, roots);
    if (row.name.trim()) projectNames.set(codexPathKey(row.path), row.name.trim());
  }
  for (const [id, roots] of databaseRoots) byId.set(id, roots);
  for (const map of Object.values(object(data["app-server-project-id-by-legacy-project-id-by-host"]))) {
    for (const [id, target] of Object.entries(object(map))) {
      const roots = typeof target === "string" ? databaseRoots.get(target) : undefined;
      if (roots) byId.set(id, roots);
    }
  }
  const atoms = ownerAtoms(data);
  const projectPrefix = "codex:project:";
  const itemRoots = (key: string) => key.startsWith(projectPrefix) ? byId.get(key.slice(projectPrefix.length)) ?? [] : [];
  const sectionRoots: string[] = [];
  for (const value of Object.values(object(atoms["sidebar-custom-sections-v3"]))) {
    const { sections } = object(value);
    if (!Array.isArray(sections)) continue;
    for (const section of sections) {
      sectionRoots.push(...strings(object(section).itemKeys).flatMap(itemRoots));
    }
  }
  const seen = new Set<string>();
  const resolveProject = (entry: string) => byId.get(entry) ?? (isRoot(entry) ? [entry] : []);
  const pinnedRoots = strings(data["pinned-project-ids"]).flatMap(resolveProject);
  const pinnedProjects = new Set(pinnedRoots.map(codexPathKey));
  const projects = [
    ...pinnedRoots,
    ...strings(data["project-order"]).flatMap(resolveProject),
    ...strings(atoms["unified-sidebar-project-order-v1"]).flatMap(itemRoots),
    ...sectionRoots,
    ...strings(data["electron-saved-workspace-roots"]).flatMap(resolveProject),
    ...[...databaseRoots.values()].flat(),
  ]
    .filter((root) => {
      const key = codexPathKey(root);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const threadRoots = new Map<string, string>();
  for (const [id, value] of Object.entries(object(data["thread-project-assignments"]))) {
    const assignment = object(value);
    if (assignment.projectKind !== "local" || typeof assignment.projectId !== "string") continue;
    const roots = byId.get(assignment.projectId);
    if (roots?.length) threadRoots.set(id.toLowerCase(), roots[0]);
  }
  return { projects, projectNames, threadRoots, pinnedProjects };
}

/** Codex stores Windows paths with a `\\?\` prefix; the folders are the same ones. */
export function plainPath(value: string): string {
  return value.replace(/^\\\\\?\\/, "").replace(/[\\/]+$/, "");
}

export function codexPathKey(value: string): string {
  return path.resolve(plainPath(value)).toLocaleLowerCase();
}

/** Null when Codex's desktop app has left no project list here (the CLI alone, or a test fixture). */
export function codexDesktopState(sessionsDir: string): CodexDesktopState | null {
  const home = path.dirname(path.resolve(sessionsDir));
  const globalFile = path.join(home, ".codex-global-state.json");
  const indexFile = path.join(home, "session_index.jsonl");
  const database = stateDatabase(home);
  const signature = [globalFile, indexFile, ...(database ? [database, `${database}-wal`] : [])].map(stamp).join("\n");
  const hit = cache.get(home);
  if (hit?.signature === signature) {
    latest = hit.state;
    return hit.state;
  }

  let state: CodexDesktopState | null = null;
  if (existsSync(globalFile) || database) {
    const threads = new Map<string, CodexThreadMetadata>();
    const names = new Map<string, string>();
    const subagents = new Set<string>();
    const archived = new Set<string>();
    const recency = new Map<string, string>();
    const rolloutPaths = new Map<string, string>();
    const cliOnly = new Set<string>();
    let pinnedThreads = new Set<string>();
    let projectless = new Set<string>();
    let projectlessRoot = "";
    let data: Record<string, unknown> = {};
    try {
      data = object(JSON.parse(readFileSync(globalFile, "utf8")));
      pinnedThreads = new Set(strings(data["pinned-thread-ids"]).map(id => id.trim().toLowerCase()));
      projectless = new Set(strings(data["projectless-thread-ids"]).map((id) => id.toLowerCase()));
      const hints = data["thread-workspace-root-hints"];
      if (hints && typeof hints === "object") {
        projectlessRoot = strings(Object.values(hints as Record<string, unknown>))[0] ?? "";
      }
    } catch {
      /* a half-written state file: fall through with what was read */
    }
    const { projects, projectNames, threadRoots, pinnedProjects } = projectFolders(data, database ? readProjects(database) : []);
    if (database) {
      try {
        for (const row of readRows(database)) {
          const id = row.id.toLowerCase();
          if (["cli", "exec"].includes(row.source ?? "") && !row.name?.trim()) cliOnly.add(id);
          if (row.thread_source === "subagent" || (row.source ?? "").includes('"subagent"')) subagents.add(id);
          if (row.archived) archived.add(id);
          if ((pinnedThreads.has(id) || row.is_pinned === 1) && !row.archived && !subagents.has(id) && !cliOnly.has(id)) {
            const cwd = threadRoots.get(id) ?? row.cwd;
            if (cwd && !projectless.has(id)) {
              const key = codexPathKey(cwd);
              const project = projects.map(codexPathKey).filter(root => key === root || key.startsWith(root + path.sep)).sort((a, b) => b.length - a.length)[0];
              if (project) pinnedProjects.add(project);
            }
          }
          if (row.rollout_path) rolloutPaths.set(id, plainPath(row.rollout_path));
          const title = (row.name ?? "").trim() || (row.title ?? "").trim();
          if (title) names.set(id, title);
          const at = row.recency_at || row.updated_at;
          if (at) recency.set(id, new Date(at * 1000).toISOString());
          if (row.cwd) threads.set(id, {
            id, cwd: plainPath(row.cwd), title: title || id,
            updatedAt: new Date((row.updated_at || at || 0) * 1000).toISOString(),
            historyMode: row.history_mode ?? "legacy",
            ...(row.model ? { model: row.model } : {}),
            ...(row.reasoning_effort ? { effort: row.reasoning_effort } : {}),
          });
        }
      } catch {
        /* the database is locked or from a version this does not know: names fall back to the index */
      }
    }
    // The index is appended to on every rename, so the last line for a thread is its current name.
    try {
      for (const line of readFileSync(indexFile, "utf8").split(/\n/)) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as { id?: unknown; thread_name?: unknown };
          if (typeof entry.id === "string" && typeof entry.thread_name === "string" && entry.thread_name.trim()) {
            names.set(entry.id.toLowerCase(), entry.thread_name.trim());
          }
        } catch {
          continue;
        }
      }
    } catch {
      /* no index yet */
    }
    state = { threads, names, projects, projectNames, pinnedProjects, threadRoots, projectless, projectlessRoot, subagents, archived, recency, rolloutPaths, cliOnly };
  }
  cache.set(home, { signature, state });
  latest = state;
  return state;
}

export function codexDesktopSession(sessionsDir: string, sessionId: string): { title: string } | null {
  const state = codexDesktopState(sessionsDir);
  const id = sessionId.toLowerCase();
  if (!state || state.cliOnly.has(id) || state.archived.has(id) || state.subagents.has(id)) return null;
  const title = state.names.get(id);
  return title ? { title } : null;
}

/** The sidebar name of a thread, from the state read most recently. */
export function codexThreadName(id: string): string | undefined {
  return latest?.names.get(id.toLowerCase());
}
