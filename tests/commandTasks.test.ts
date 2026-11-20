import { mkdtempSync, writeFileSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createCommandTasks, TaskError, windowsHost, type RestartJob, type TaskHost } from "../src/tasks/commandTasks";
import { describeTrees, parseSnapshot, type TreeInfo } from "../src/tasks/processTree";

const tempDir = () => mkdtempSync(path.join(os.tmpdir(), "mm-tasks-"));

/** A process host that only pretends: each spawn gets a PID and ends when told to. */
function fakeHost() {
  let next = 4000;
  const live = new Map<number, (code: number | null) => void>();
  const killed: number[] = [];
  /** What each root's tree reports; a root not listed listens on nothing and is not this server. */
  const trees = new Map<number, TreeInfo>();
  const handedOff: RestartJob[] = [];
  const host: TaskHost = {
    async describe(roots) {
      return new Map(roots.map((root) => [root, trees.get(root) ?? { ports: [], self: false }]));
    },
    handOffRestart: (job) => void handedOff.push(job),
    spawn(command, _cwd, fd) {
      writeSync(fd, `out of ${command}\n`);
      const pid = next++;
      let done: ((code: number | null) => void) | undefined;
      live.set(pid, (code) => done?.(code));
      return { pid, onExit: (callback) => void (done = callback) };
    },
    alive: (pid) => live.has(pid),
    async killTree(pid) {
      killed.push(pid);
      const end = live.get(pid);
      live.delete(pid);
      end?.(1);
    },
  };
  const exit = (pid: number, code: number) => {
    const end = live.get(pid);
    live.delete(pid);
    end?.(code);
  };
  return { host, exit, killed, live, trees, handedOff };
}

describe("process trees", () => {
  it("finds the ports of every process a task started, and whether this server is among them", () => {
    const snapshot = parseSnapshot(
      ["P\t10\t1", "P\t11\t10", "P\t12\t11", "P\t20\t1", "L\t4789\t12", "L\t5173\t11", "L\t4789\t12", "L\t9000\t20"].join("\r\n"),
    );
    const trees = describeTrees(snapshot, [10, 20], 12);
    expect(trees.get(10)).toEqual({ ports: [4789, 5173], self: true });
    expect(trees.get(20)).toEqual({ ports: [9000], self: false });
  });
});

describe("command tasks", () => {
  it("runs a one-off command to the end and keeps its output", () => {
    const dir = tempDir();
    const fake = fakeHost();
    const tasks = createCommandTasks(dir, fake.host);
    const task = tasks.create({ name: "build", cwd: dir, command: "npm run build", kind: "once" });
    expect(task.status).toBe("idle");
    const started = tasks.start(task.id);
    expect(started).toMatchObject({ status: "running", pid: 4000 });
    expect(() => tasks.start(task.id)).toThrow(TaskError);
    fake.exit(4000, 0);
    expect(tasks.list()[0]).toMatchObject({ status: "exited", exitCode: 0 });
    expect(tasks.log(task.id).text).toContain("out of npm run build");
  });

  it("shows a long-running task's PID, and stops it with its whole tree", async () => {
    const dir = tempDir();
    const fake = fakeHost();
    const tasks = createCommandTasks(dir, fake.host);
    const task = tasks.create({ name: "dev", cwd: dir, command: "npm run dev", kind: "service" });
    tasks.start(task.id);
    expect(() => tasks.update(task.id, { name: "x", cwd: dir, command: "y", kind: "service" })).toThrow(TaskError);
    const stopped = await tasks.stop(task.id);
    expect(fake.killed).toEqual([4000]);
    expect(stopped.status).toBe("stopped");
    expect(stopped.pid).toBe(4000);
  });

  it("shows a running task's ports, and restarts an ordinary one in place", async () => {
    const dir = tempDir();
    const fake = fakeHost();
    const tasks = createCommandTasks(dir, fake.host);
    const task = tasks.create({ name: "web", cwd: dir, command: "npm run dev", kind: "service" });
    tasks.start(task.id);
    fake.trees.set(4000, { ports: [5173], self: false });
    expect((await tasks.inspect(tasks.list()))[0]).toMatchObject({ status: "running", pid: 4000, ports: [5173], self: false });
    const restarted = await tasks.restart(task.id);
    expect(fake.killed).toEqual([4000]);
    expect(restarted).toMatchObject({ status: "running", pid: 4001 });
    expect(fake.handedOff).toEqual([]);
  });

  it("hands the restart of MirrorMix itself to a helper outside its tree", async () => {
    const dir = tempDir();
    const fake = fakeHost();
    const tasks = createCommandTasks(dir, fake.host);
    const task = tasks.create({ name: "MirrorMix", cwd: dir, command: "npm run dev", kind: "service" });
    tasks.start(task.id);
    fake.trees.set(4000, { ports: [4789], self: true });
    const answer = await tasks.restart(task.id);
    // This server keeps running until the helper ends it, so nothing is killed from here.
    expect(fake.killed).toEqual([]);
    expect(fake.handedOff).toEqual([{ dir, id: task.id, command: "npm run dev", cwd: dir, oldPid: 4000 }]);
    expect(answer).toMatchObject({ status: "running", pid: 4000, self: true, ports: [4789] });
  });

  it("keeps tracking a running process after MirrorMix restarts", () => {
    const dir = tempDir();
    const fake = fakeHost();
    const first = createCommandTasks(dir, fake.host);
    const task = first.create({ name: "dev", cwd: dir, command: "npm run dev", kind: "service" });
    first.start(task.id);
    const restarted = createCommandTasks(dir, fake.host);
    expect(restarted.list()[0]).toMatchObject({ status: "running", pid: 4000 });
    // It ends while the new server is not its parent: the exit code is unknown.
    fake.live.delete(4000);
    expect(restarted.list()[0]).toMatchObject({ status: "failed", exitCode: null });
  });

  it("reads the exit code the runner saved when the run ended during a restart", () => {
    const dir = tempDir();
    const fake = fakeHost();
    const exits: string[] = [];
    const host: TaskHost = { ...fake.host, spawn: (c, cwd, fd, exitFile) => (exits.push(exitFile), fake.host.spawn(c, cwd, fd, exitFile)) };
    const first = createCommandTasks(dir, host);
    const task = first.create({ name: "build", cwd: dir, command: "npm run build", kind: "once" });
    first.start(task.id);
    const restarted = createCommandTasks(dir, host);
    writeFileSync(exits[0], "2");
    fake.live.delete(4000);
    expect(restarted.list()[0]).toMatchObject({ status: "failed", exitCode: 2 });
  });

  it("refuses a folder that does not exist", () => {
    const tasks = createCommandTasks(tempDir(), fakeHost().host);
    expect(() => tasks.create({ name: "a", cwd: path.join(tempDir(), "nope"), command: "dir", kind: "once" })).toThrow(
      expect.objectContaining({ code: "task_cwd" }),
    );
    expect(() => tasks.create({ name: "a", cwd: "relative", command: "dir", kind: "once" })).toThrow(TaskError);
  });

  it.runIf(process.platform === "win32")("runs a real command through cmd in the chosen folder", async () => {
    const dir = tempDir();
    const tasks = createCommandTasks(dir, windowsHost);
    const task = tasks.create({ name: "echo", cwd: dir, command: "echo 你好 && cd", kind: "once" });
    tasks.start(task.id);
    for (let i = 0; i < 100 && tasks.list()[0].status === "running"; i++) await new Promise((r) => setTimeout(r, 50));
    expect(tasks.list()[0]).toMatchObject({ status: "exited", exitCode: 0 });
    const text = tasks.log(task.id).text;
    expect(text).toContain("你好");
    expect(text.toLowerCase()).toContain(dir.toLowerCase());
  });

  // Programs started under a detached process with no console print into a console of their own, not the log.
  it.runIf(process.platform === "win32")("keeps the output of node and PowerShell, and their exit code", async () => {
    const dir = tempDir();
    const tasks = createCommandTasks(dir, windowsHost);
    const task = tasks.create({
      name: "mixed",
      cwd: dir,
      command: `node -e "console.log('node 你好')" && powershell -NoProfile -NonInteractive -Command "Write-Output 'ps 你好'; exit 4"`,
      kind: "once",
    });
    tasks.start(task.id);
    for (let i = 0; i < 200 && tasks.list()[0].status === "running"; i++) await new Promise((r) => setTimeout(r, 50));
    expect(tasks.list()[0]).toMatchObject({ status: "failed", exitCode: 4 });
    const text = tasks.log(task.id).text;
    expect(text).toContain("node 你好");
    expect(text).toContain("ps 你好");
  }, 20_000);

  it.runIf(process.platform === "win32")("the restart helper ends the old run and records the new one", async () => {
    const dir = tempDir();
    const tasks = createCommandTasks(dir, windowsHost);
    const command = `node -e "console.log('pid=' + process.pid); setInterval(() => {}, 1000)"`;
    const task = tasks.create({ name: "svc", cwd: dir, command, kind: "service" });
    const { pid: oldPid } = tasks.start(task.id);
    windowsHost.handOffRestart({ dir, id: task.id, command, cwd: dir, oldPid: oldPid! });
    let newPid = 0;
    for (let i = 0; i < 100 && !newPid; i++) {
      await new Promise((r) => setTimeout(r, 100));
      // A MirrorMix started after the restart reads the run the helper recorded.
      const seen = createCommandTasks(dir, windowsHost).list()[0];
      if (seen.status === "running" && seen.pid !== oldPid) newPid = seen.pid!;
    }
    expect(newPid).toBeGreaterThan(0);
    expect(windowsHost.alive(oldPid!)).toBe(false);
    expect(windowsHost.alive(newPid)).toBe(true);
    expect(tasks.log(task.id).text).toContain("(重启)");
    await windowsHost.killTree(newPid);
  }, 20_000);

  it.runIf(process.platform === "win32")("stops a real long-running command and its children", async () => {
    const dir = tempDir();
    const tasks = createCommandTasks(dir, windowsHost);
    // Prints its own PID, so the test can check the grandchild ends too, not only the process MirrorMix started.
    const task = tasks.create({
      name: "wait",
      cwd: dir,
      command: `node -e "console.log('pid=' + process.pid); setInterval(() => {}, 1000)"`,
      kind: "service",
    });
    const { pid } = tasks.start(task.id);
    let inner = 0;
    for (let i = 0; i < 100 && !inner; i++) {
      await new Promise((r) => setTimeout(r, 50));
      inner = Number(/pid=(\d+)/.exec(tasks.log(task.id).text)?.[1] ?? 0);
    }
    expect(inner).toBeGreaterThan(0);
    expect(windowsHost.alive(pid!)).toBe(true);
    const stopped = await tasks.stop(task.id);
    expect(stopped.status).toBe("stopped");
    for (let i = 0; i < 40 && (windowsHost.alive(pid!) || windowsHost.alive(inner)); i++) await new Promise((r) => setTimeout(r, 50));
    expect(windowsHost.alive(pid!)).toBe(false);
    expect(windowsHost.alive(inner)).toBe(false);
  }, 15_000);
});
