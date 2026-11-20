// Starts a command task from a terminal, for when MirrorMix is not running to do it: chiefly the task that runs
// MirrorMix itself. `npx tsx src/tasks/startTask.ts <task name or id>`
import os from "node:os";
import path from "node:path";
import { createCommandTasks, TaskError } from "./commandTasks";

const wanted = process.argv.slice(2).join(" ").trim();
const tasks = createCommandTasks(process.env.AIMISS_TASKS_DIR || path.join(os.homedir(), ".mirrormix"));
const all = tasks.list();
const task = all.find((item) => item.id === wanted || item.name === wanted);
if (!task) {
  console.error(wanted ? `没有叫“${wanted}”的命令任务。` : "请给出任务名称或 id。");
  for (const item of all) console.error(`  ${item.name}  (${item.id})  ${item.status}`);
  process.exit(1);
}
try {
  const started = tasks.start(task.id);
  console.log(`已启动“${started.name}”，PID ${started.pid}。输出在 MirrorMix 设置的命令任务里查看。`);
} catch (error) {
  if (error instanceof TaskError && error.code === "task_running") {
    console.error(`“${task.name}”已经在运行（PID ${task.pid}）。`);
    process.exit(1);
  }
  throw error;
}
