import os from "node:os";
import type { TerminalProject } from "../shared/terminalScope";

/** Ordinary command terminals use the system ConPTY renderer, which matches xterm 5's resize handling. */
export function commandPtyCompatibility() {
  const buildNumber = Number(os.release().split(".")[2]);
  const windowsPty: TerminalProject["windowsPty"] = process.platform === "win32"
    ? { backend: buildNumber >= 18309 ? "conpty" : "winpty", buildNumber }
    : undefined;
  return {
    windowsPty,
    // The bundled ConPTY 1.23 passthrough renderer and xterm 5 disagree about cursor position after resize.
    // Keep the previous backend available explicitly, without changing the AI session PTYs.
    useConptyDll: process.platform === "win32" && process.env.MIRRORMIX_COMMAND_CONPTY_DLL === "1",
  };
}
