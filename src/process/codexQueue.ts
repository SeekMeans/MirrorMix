import { spawn } from "node:child_process";
import type { ToolBins } from "../shared/types";

/**
 * Hands a message to a Codex session through its local daemon.
 * The interactive terminal stops reading while the screen is locked; the daemon does not need that terminal.
 */
export function queueCodexMessage(bins: ToolBins, id: string, cwd: string, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      bins.nodeExe,
      [bins.codexJs, "queue", "--thread", id, "--message", text, "--resume", "-C", cwd],
      { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("timeout"));
    }, 20_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`exit ${code ?? 1}`));
    });
  });
}
