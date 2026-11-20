import { execFile } from "node:child_process";

/** What a running task's process tree is doing right now. */
export interface TreeInfo {
  /** TCP ports something in the tree is listening on, ascending. */
  ports: number[];
  /** The tree holds the MirrorMix server answering this request: stopping it takes the page away. */
  self: boolean;
}

export interface Snapshot {
  processes: Array<{ pid: number; parentPid: number }>;
  listeners: Array<{ port: number; pid: number }>;
}

/** Every process started, directly or not, by each of `roots`, with what those processes listen on. */
export function describeTrees(snapshot: Snapshot, roots: number[], selfPid: number): Map<number, TreeInfo> {
  const children = new Map<number, number[]>();
  for (const { pid, parentPid } of snapshot.processes) {
    if (pid === parentPid) continue;
    const list = children.get(parentPid) ?? [];
    list.push(pid);
    children.set(parentPid, list);
  }
  const result = new Map<number, TreeInfo>();
  for (const root of roots) {
    const tree = new Set<number>([root]);
    const queue = [root];
    while (queue.length) {
      for (const child of children.get(queue.shift()!) ?? []) {
        if (tree.has(child)) continue;
        tree.add(child);
        queue.push(child);
      }
    }
    const ports = [...new Set(snapshot.listeners.filter((item) => tree.has(item.pid)).map((item) => item.port))].sort((a, b) => a - b);
    result.set(root, { ports, self: tree.has(selfPid) });
  }
  return result;
}

const QUERY = [
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  "Get-CimInstance Win32_Process | ForEach-Object { 'P' + [char]9 + $_.ProcessId + [char]9 + $_.ParentProcessId }; " +
    "Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ForEach-Object { 'L' + [char]9 + $_.LocalPort + [char]9 + $_.OwningProcess }",
];

export function parseSnapshot(output: string): Snapshot {
  const snapshot: Snapshot = { processes: [], listeners: [] };
  for (const line of output.split(/\r?\n/)) {
    const [kind, a, b] = line.trim().split("\t");
    const first = Number(a);
    const second = Number(b);
    if (!Number.isInteger(first) || !Number.isInteger(second)) continue;
    if (kind === "P") snapshot.processes.push({ pid: first, parentPid: second });
    else if (kind === "L") snapshot.listeners.push({ port: first, pid: second });
  }
  return snapshot;
}

let cache: { at: number; snapshot: Snapshot } | null = null;
let pending: Promise<Snapshot> | null = null;

/** Processes and listening ports on this PC, read at most every few seconds and never twice at once. */
export function readSnapshot(): Promise<Snapshot> {
  if (cache && Date.now() - cache.at < 3_000) return Promise.resolve(cache.snapshot);
  pending ??= new Promise<Snapshot>((resolve) => {
    execFile("powershell.exe", QUERY, { encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      const snapshot = error ? cache?.snapshot ?? { processes: [], listeners: [] } : parseSnapshot(stdout);
      cache = { at: Date.now(), snapshot };
      pending = null;
      resolve(snapshot);
    });
  });
  return pending;
}
