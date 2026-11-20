import { createRequire } from "node:module";
import type { Terminal as XTerminal } from "@xterm/headless";
import { screenAllowsInput } from "./screen";

const require = createRequire(import.meta.url);
const { Terminal } = require("@xterm/headless") as { Terminal: typeof XTerminal };

export interface ScreenMirror {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  allowsInput(): boolean;
  /** What is on screen now, one string per row. */
  lines(): string[];
  prompt(): string;
  replyWith(write: (data: string) => void): void;
}

export function createScreenMirror(cols = 100, rows = 28): ScreenMirror {
  const term = new Terminal({ cols, rows, allowProposedApi: true });
  let lines: string[] = [];
  let reply: ((data: string) => void) | undefined;
  term.onData((data) => reply?.(data));
  const refresh = () => {
    const next: string[] = [];
    for (let row = 0; row < term.rows; row += 1) {
      next.push(term.buffer.active.getLine(row)?.translateToString(true) ?? "");
    }
    lines = next;
  };
  return {
    write(data: string) {
      term.write(data, refresh);
    },
    resize(nextCols: number, nextRows: number) {
      term.resize(nextCols, nextRows);
      refresh();
    },
    allowsInput() {
      return screenAllowsInput(lines);
    },
    lines() {
      return lines;
    },
    prompt() {
      return lines.filter((line) => line.trim()).join("\n");
    },
    replyWith(write) { reply = write; },
  };
}
