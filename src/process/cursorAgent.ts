import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

export interface CursorAgentBins {
  node: string;
  js: string;
}

const VERSION_NAME = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-(\d{2})-(\d{2})-(\d{2}))?-/;

function versionRank(name: string): number {
  const match = VERSION_NAME.exec(name);
  if (!match) return 0;
  const [, year, month, day, hour = "0", minute = "0", second = "0"] = match;
  return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
}

/** The node binary and index.js the `agent` command actually runs. */
export function resolveCursorAgent(root: string): CursorAgentBins | null {
  if (!root || !existsSync(root)) return null;
  const beside = path.join(root, "node.exe");
  const besideJs = path.join(root, "index.js");
  if (existsSync(beside) && existsSync(besideJs)) return { node: beside, js: besideJs };
  const versions = path.join(root, "versions");
  if (!existsSync(versions)) return null;
  const ranked = readdirSync(versions, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && VERSION_NAME.test(entry.name))
    .map((entry) => ({ name: entry.name, rank: versionRank(entry.name) }))
    .sort((a, b) => b.rank - a.rank);
  for (const version of ranked) {
    const dir = path.join(versions, version.name);
    const node = path.join(dir, "node.exe");
    const js = path.join(dir, "index.js");
    if (existsSync(node) && existsSync(js)) return { node, js };
  }
  return null;
}

function run(bins: CursorAgentBins, args: string[], cwd: string): ChildProcess {
  return spawn(bins.node, [bins.js, ...args], { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
}

/** `agent create-chat` prints the new id and exits. */
export function createCursorChat(bins: CursorAgentBins, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = run(bins, ["create-chat"], cwd);
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("error", () => reject(new Error("failed")));
    child.on("exit", (code) => {
      const id = output.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
      if (code === 0 && id) resolve(id);
      else reject(new Error("failed"));
    });
  });
}

/** One reply, started in the background. The transcript file is what the page reads back. */
export function startCursorRun(
  bins: CursorAgentBins,
  id: string,
  cwd: string,
  text: string,
  onExit: (code: number, output: string) => void,
): { kill: () => void } {
  const child = run(bins, ["--resume", id, "--workspace", cwd, "--trust", "--force", "-p", text, "--output-format", "text"], cwd);
  // Only the tail is kept: enough to say why a run failed.
  let output = "";
  const keep = (chunk: Buffer) => {
    output = (output + chunk.toString("utf8")).slice(-4_000);
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  child.on("error", (error) => onExit(1, error.message));
  child.on("exit", (code) => onExit(code ?? 1, output));
  return {
    kill() {
      child.kill();
    },
  };
}
