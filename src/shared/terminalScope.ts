/** Browser-safe identity for a workspace directory; Windows paths are case-insensitive. */
export function workspaceTerminalKey(directory: string): string {
  const plain = directory.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "");
  if (/^[a-z]:[\\/]|^\\\\/i.test(plain)) return plain.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return plain === "/" ? plain : plain.replace(/\/+$/, "");
}

export interface TerminalProject {
  key: string;
  root: string;
  elevated: boolean | null;
  survivesRestart: false;
  /** Describes the server's PTY, even when the browser runs on another OS. */
  windowsPty?: { backend: "conpty" | "winpty"; buildNumber: number };
}
