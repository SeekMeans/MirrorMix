import type { HtmlFile, ListeningPort, PreviewPickView, PreviewPicks } from "./api";

export interface FileChoice {
  path: string;
  title?: string;
  modifiedAt?: string;
  /** Picked before, but no longer in the folder. */
  missing?: boolean;
}

export interface PortChoice {
  port: number;
  name?: string;
  running: boolean;
}

/** Everything that can be ticked: what is in the folder and running now, plus what was picked before and is gone. */
export function pickChoices(files: HtmlFile[], running: ListeningPort[], view: PreviewPickView | null): { files: FileChoice[]; ports: PortChoice[] } {
  const fileRows: FileChoice[] = files.map((item) => ({ path: item.path, title: item.title, modifiedAt: item.modifiedAt }));
  const known = new Set(files.map((item) => item.path.toLowerCase()));
  for (const item of view?.files ?? []) {
    if (known.has(item.path.toLowerCase())) continue;
    known.add(item.path.toLowerCase());
    fileRows.push("missing" in item ? { path: item.path, missing: true } : { path: item.path, title: item.title, modifiedAt: item.modifiedAt });
  }
  return { files: fileRows, ports: mergePorts(running, view?.picks?.ports ?? [], true) };
}

/** The picked ports, each marked running or not; a stopped one stays listed so it does not silently vanish. */
export function pickedPorts(picks: PreviewPicks | null, running: ListeningPort[]): PortChoice[] {
  return mergePorts(running, picks?.ports ?? [], false);
}

function mergePorts(running: ListeningPort[], picked: Array<{ port: number; name?: string }>, includeAllRunning: boolean): PortChoice[] {
  const live = new Map(running.map((item) => [item.port, item.name]));
  const rows = new Map<number, PortChoice>();
  if (includeAllRunning) for (const item of running) rows.set(item.port, { port: item.port, name: item.name, running: true });
  for (const item of picked) {
    if (rows.has(item.port)) continue;
    const name = live.get(item.port) ?? item.name;
    rows.set(item.port, { port: item.port, ...(name ? { name } : {}), running: live.has(item.port) });
  }
  return [...rows.values()].sort((a, b) => a.port - b.port);
}

/** What is saved: the ticked files and ports, a port with the program name it had, for when it is not running. */
export function picksToSave(files: Set<string>, ports: Set<number>, portRows: PortChoice[]): { files: string[]; ports: Array<{ port: number; name?: string }> } {
  const names = new Map(portRows.map((row) => [row.port, row.name]));
  return {
    files: [...files],
    ports: [...ports].sort((a, b) => a - b).map((port) => {
      const name = names.get(port);
      return name ? { port, name } : { port };
    }),
  };
}
