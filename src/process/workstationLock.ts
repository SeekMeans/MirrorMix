import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "workstationLock.ps1");

/** Asks Windows whether the interactive session is locked. A failed check reports unlocked, so a send is not blocked by the check itself. */
export function createWorkstationLock() {
  let child: ChildProcessWithoutNullStreams | null = null;
  let chain: Promise<void> = Promise.resolve();
  const waiters: Array<(locked: boolean) => void> = [];

  const ensure = () => {
    if (child && child.exitCode === null) return;
    child = spawn("powershell.exe", ["-NoProfile", "-NoLogo", "-File", scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stderr.on("data", () => {});
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const waiter = waiters.shift();
      if (!waiter) return;
      waiter(line.trim() === "1");
    });
    child.on("exit", () => {
      while (waiters.length) waiters.shift()?.(false);
      child = null;
    });
  };

  return {
    locked() {
      const run = chain.then(
        () =>
          new Promise<boolean>((resolve) => {
            ensure();
            if (!child) {
              resolve(false);
              return;
            }
            const timer = setTimeout(() => {
              const index = waiters.indexOf(finish);
              if (index >= 0) waiters.splice(index, 1);
              resolve(false);
            }, 3_000);
            const finish = (locked: boolean) => {
              clearTimeout(timer);
              resolve(locked);
            };
            waiters.push(finish);
            child.stdin.write("?\n");
          }),
        () => Promise.resolve(false),
      );
      chain = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
    dispose() {
      child?.kill();
      child = null;
    },
  };
}
