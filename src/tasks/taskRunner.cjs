// Runs one command task. MirrorMix starts this detached, so it outlives a MirrorMix restart. A detached process has
// no console, and console programs started under it (node, npm, PowerShell) would print into a console of their own
// instead of the log; so the command runs in a child that gets a hidden console and inherits the log as its output.
// The exit code is written to a file, so a restarted MirrorMix still learns how the run ended.
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");

const [exitFile, cwd, command] = process.argv.slice(2);
const child = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"chcp 65001>nul & ${command}"`], {
  cwd,
  windowsHide: true,
  windowsVerbatimArguments: true,
  stdio: "inherit",
  env: { ...process.env, FORCE_COLOR: "0" },
});

function done(code) {
  try {
    writeFileSync(exitFile, code === null || code === undefined ? "" : String(code));
  } catch {
    /* the log folder went away */
  }
  process.exit(typeof code === "number" ? code : 1);
}

child.on("exit", (code) => done(code));
child.on("error", () => done(null));
