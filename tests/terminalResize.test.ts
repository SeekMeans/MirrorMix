import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import type { Terminal as XTerminal } from "@xterm/headless";
import { commandPtyCompatibility } from "../src/process/commandPty";

const require = createRequire(import.meta.url);
const { Terminal } = require("@xterm/headless") as { Terminal: typeof XTerminal };

describe.skipIf(process.platform !== "win32")("Windows command terminal resizing", () => {
  it("keeps subsequent output below long history after enlarging, shrinking and enlarging again", async () => {
    const pty = await import("node-pty");
    const compatibility = commandPtyCompatibility();
    // Run the shipped default, independently of a developer's explicit legacy-backend override.
    const original = process.env.MIRRORMIX_COMMAND_CONPTY_DLL;
    delete process.env.MIRRORMIX_COMMAND_CONPTY_DLL;
    const useConptyDll = commandPtyCompatibility().useConptyDll;
    if (original !== undefined) process.env.MIRRORMIX_COMMAND_CONPTY_DLL = original;
    const term = new Terminal({ cols: 64, rows: 18, allowProposedApi: true, windowsPty: compatibility.windowsPty });
    const shell = pty.spawn(process.env.ComSpec || "cmd.exe", ["/d"], {
      cols: 64, rows: 18, useConptyDll, cwd: process.cwd(), env: { ...process.env },
    });
    const output = (data: string) => new Promise<void>(resolve => term.write(data, resolve));
    let parsed = Promise.resolve();
    shell.onData(data => { parsed = parsed.then(() => output(data)); });
    const replies = term.onData(data => shell.write(data));
    const lines = () => Array.from({ length: term.buffer.active.length }, (_, i) => term.buffer.active.getLine(i)!.translateToString(true)).filter(Boolean);
    const waitFor = async (predicate: (screen: string[]) => boolean) => {
      const deadline = Date.now() + 7000;
      while (Date.now() < deadline) {
        await parsed;
        if (predicate(lines())) return;
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      throw new Error(`Terminal did not reach expected screen:\n${lines().join("\n")}`);
    };
    try {
      await waitFor(screen => screen.at(-1)?.endsWith(">") === true);
      shell.write(`"${process.execPath}" -e "for(let i=1;i<=35;i++)console.log('ROW_'+i+' '+'abcdefghij'.repeat(9)+' END');console.log('HISTORY_READY')"\r`);
      await waitFor(screen => screen.includes("HISTORY_READY") && screen.at(-1)?.endsWith(">") === true);
      for (const [index, [cols, rows]] of [[120, 36], [52, 14], [100, 30]].entries()) {
        await parsed;
        term.resize(cols, rows);
        shell.resize(cols, rows);
        shell.write(`echo RESIZE_OK_${index}\r`);
        await waitFor(screen => screen.includes(`RESIZE_OK_${index}`) && screen.at(-1)?.endsWith(">") === true);
        const screen = lines();
        // The original bundled ConPTY writes the echo inside ROW_29 and leaves old rows below the prompt.
        expect(screen.slice(-3)).toEqual([`${process.cwd()}>echo RESIZE_OK_${index}`, `RESIZE_OK_${index}`, `${process.cwd()}>`]);
      }
    } finally {
      replies.dispose();
      shell.kill();
      await parsed;
      term.dispose();
    }
  }, 25_000);
});
