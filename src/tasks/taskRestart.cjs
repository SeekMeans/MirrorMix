// Restarts a command task whose process tree holds MirrorMix itself. MirrorMix cannot stop its own server and then
// start it again, so it hands the job to this helper, which runs outside that tree: the first copy starts a second
// one and exits at once, leaving the second with no parent in the tree, so stopping the tree does not stop it.
// The second copy ends the old run, starts the command again through the task runner, and records the new PID where
// the restarted MirrorMix reads it.
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const [mode, payload] = process.argv.slice(2);

if (mode === "--hand-off") {
  spawn(process.execPath, [__filename, "--run", payload], { detached: true, windowsHide: true, stdio: "ignore" }).unref();
  process.exit(0);
}

const job = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function writeJson(file, value) {
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temp, file);
}

(async () => {
  // Let MirrorMix answer the request that asked for this first.
  await sleep(400);
  try {
    execFileSync("taskkill.exe", ["/pid", String(job.oldPid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } catch {
    /* already gone */
  }
  for (let i = 0; i < 100 && alive(job.oldPid); i++) await sleep(100);
  // The old server's port is released a moment after its process ends.
  await sleep(800);

  const logDir = path.join(job.dir, "task-logs");
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `${job.id}.log`);
  const exitFile = path.join(logDir, `${job.id}.exit`);
  try {
    fs.unlinkSync(exitFile);
  } catch {
    /* no earlier run */
  }
  const startedAt = new Date().toISOString();
  const fd = fs.openSync(logFile, "a");
  fs.writeSync(fd, `\n── ${startedAt}  ${job.command}  (重启)\n`);
  const child = spawn(process.execPath, [path.join(__dirname, "taskRunner.cjs"), exitFile, job.cwd, job.command], {
    cwd: job.cwd,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", fd, fd],
  });
  child.unref();
  fs.closeSync(fd);

  const runsFile = path.join(job.dir, "task-runs.json");
  let runs = {};
  try {
    runs = JSON.parse(fs.readFileSync(runsFile, "utf8"));
  } catch {
    /* none yet */
  }
  runs[job.id] = { pid: child.pid, startedAt };
  writeJson(runsFile, runs);
  process.exit(0);
})();
