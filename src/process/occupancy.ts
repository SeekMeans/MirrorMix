export interface ProcessInfo {
  pid: number;
  parentPid: number;
  commandLine: string;
  name?: string;
  windowTitle?: string;
}

export function isOccupied(sessionId: string, processes: ProcessInfo[], ownedPids: number[]): boolean {
  if (!sessionId) return false;
  const owned = new Set(ownedPids);
  const byPid = new Map(processes.map((processInfo) => [processInfo.pid, processInfo]));

  const belongsToUs = (pid: number) => {
    const seen = new Set<number>();
    let current = pid;
    while (current && !seen.has(current)) {
      if (owned.has(current)) return true;
      seen.add(current);
      current = byPid.get(current)?.parentPid ?? 0;
    }
    return false;
  };

  return processes.some(
    (processInfo) => processInfo.commandLine.includes(sessionId) && !belongsToUs(processInfo.pid),
  );
}
