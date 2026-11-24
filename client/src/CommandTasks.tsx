import { useCallback, useEffect, useRef, useState } from "react";
import { api, type CommandTask, type TaskDraft, type TaskKind } from "./api";
import { Spinner } from "./icons";

import { tr, uiLocale } from "./i18n";
const KIND_LABEL = (): Record<TaskKind, string> => ({ once: tr("一次性", "One-off"), service: tr("持续运行", "Keeps running") });

const ERRORS = (): Record<string, string> => ({
  task_name: tr("请填写名称（80 字以内）。", "Enter a name (up to 80 characters)."),
  task_command: tr("请填写要执行的命令。", "Enter the command to run."),
  task_cwd: tr("目录不存在，请填写这台电脑上已有文件夹的完整路径。", "That folder does not exist. Enter the full path of a folder on this computer."),
  task_running: tr("任务正在运行，先停止再修改。", "The task is running. Stop it before editing."),
  task_limit: tr("最多保存 100 个命令任务。", "Up to 100 command tasks can be saved."),
  task_spawn: tr("命令没能启动。", "The command did not start."),
  task_missing: tr("这个任务已经不在了，列表已刷新。", "This task is gone; the list has been refreshed."),
});

function errorText(error: unknown): string {
  // fetch itself failed: the server is down for a moment, usually restarting.
  if (error instanceof TypeError) return tr("连不上 MirrorMix，可能正在重启。恢复后列表会自动刷新。", "Cannot reach MirrorMix; it may be restarting. The list refreshes once it is back.");
  const code = (error as { code?: string }).code ?? "";
  return ERRORS()[code] ?? tr("操作没有成功，请稍后再试。", "That did not work. Please try again later.");
}

function clock(iso?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  const sameDay = date.toDateString() === new Date().toDateString();
  return date.toLocaleString(uiLocale(), sameDay ? { hour12: false, timeStyle: "medium" } : { hour12: false, dateStyle: "short", timeStyle: "short" });
}

/** The status line of a task: a long-running one leads with its PID; a one-off with how it ended. */
function statusOf(task: CommandTask): { tone: "on" | "ok" | "bad" | "off"; text: string } {
  if (task.status === "running") {
    const lead = task.kind === "service" ? tr(`运行中 · PID ${task.pid}`, `Running · PID ${task.pid}`) : tr(`正在执行 · PID ${task.pid}`, `Executing · PID ${task.pid}`);
    // Ports come from a separate look at the process tree; a service that listens on nothing (yet) says so.
    const ports = !task.ports ? "" : task.ports.length ? tr(` · 端口 ${task.ports.join(", ")}`, ` · port ${task.ports.join(", ")}`) : task.kind === "service" ? tr(" · 未监听端口", " · no port") : "";
    return { tone: "on", text: lead + ports };
  }
  if (task.status === "idle") return { tone: "off", text: task.kind === "service" ? tr("未启动", "Not started") : tr("还没运行过", "Never run") };
  const code = task.exitCode == null ? "" : tr(`（退出码 ${task.exitCode}）`, ` (exit code ${task.exitCode})`);
  if (task.status === "stopped") return { tone: "off", text: tr(`已停止 ${clock(task.endedAt)}`, `Stopped ${clock(task.endedAt)}`) };
  if (task.status === "failed") return { tone: "bad", text: `${task.kind === "service" ? tr("已退出", "Exited") : tr("失败", "Failed")}${code} ${clock(task.endedAt)}` };
  return { tone: "ok", text: `${task.kind === "service" ? tr("已退出", "Exited") : tr("完成", "Done")}${code} ${clock(task.endedAt)}` };
}

const EMPTY: TaskDraft = { name: "", cwd: "", command: "", kind: "once" };

function TaskForm({
  initial,
  busy,
  onSave,
  onCancel,
}: {
  initial: TaskDraft;
  busy: boolean;
  onSave: (draft: TaskDraft) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const set = (change: Partial<TaskDraft>) => setDraft((current) => ({ ...current, ...change }));
  return (
    <form
      className="task-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(draft);
      }}
    >
      <div className="remote-fields">
        <label>
          {tr("名称", "Name")}
          <input value={draft.name} maxLength={80} placeholder={tr("前端开发服务器", "Front-end dev server")} onChange={(e) => set({ name: e.target.value })} autoFocus />
        </label>
        <label className="task-span2">
          {tr("目录", "Folder")}
          <input value={draft.cwd} placeholder={"E:\\project\\web"} spellCheck={false} onChange={(e) => set({ cwd: e.target.value })} />
        </label>
        <label className="wide">
          {tr("命令", "Command")}
          <input
            className="mono"
            value={draft.command}
            placeholder={draft.kind === "service" ? "npm run dev" : "npm run build"}
            spellCheck={false}
            onChange={(e) => set({ command: e.target.value })}
          />
        </label>
      </div>
      <div className="task-form-foot">
        <div className="task-kind" role="radiogroup" aria-label={tr("任务类型", "Task type")}>
          {(["once", "service"] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              role="radio"
              aria-checked={draft.kind === kind}
              className={draft.kind === kind ? "active" : ""}
              onClick={() => set({ kind })}
            >
              {KIND_LABEL()[kind]}
            </button>
          ))}
        </div>
        <p className="task-kind-note">
          {draft.kind === "service" ? tr("一直运行，直到你点停止，比如 npm run dev。", "Runs until you click Stop, e.g. npm run dev.") : tr("执行完就结束，比如构建或脚本。", "Ends when done, e.g. a build or a script.")}
        </p>
        <div className="task-form-actions">
          <button type="button" className="quiet-button" onClick={onCancel}>
            {tr("取消", "Cancel")}
          </button>
          <button type="submit" className="quiet-button primary" disabled={busy}>
            {busy && <Spinner />}
            {tr("保存", "Save")}
          </button>
        </div>
      </div>
    </form>
  );
}

function TaskLog({ task }: { task: CommandTask }) {
  const [log, setLog] = useState<{ text: string; truncated: boolean } | null>(null);
  const box = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    let stopped = false;
    const load = () =>
      api
        .taskLog(task.id)
        .then((next) => !stopped && setLog(next))
        .catch(() => undefined);
    void load();
    // Output keeps coming only while the process runs.
    const timer = task.status === "running" ? window.setInterval(load, 1500) : undefined;
    return () => {
      stopped = true;
      if (timer) window.clearInterval(timer);
    };
  }, [task.id, task.status]);
  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [log]);
  if (!log) return <div className="task-log is-loading"><Spinner /></div>;
  return (
    <pre
      className="task-log"
      ref={box}
      onScroll={(event) => {
        const el = event.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
    >
      {log.truncated && <span className="task-log-cut">{tr("…只显示最后 64 KB\n", "…showing only the last 64 KB\n")}</span>}
      {log.text.trim() ? log.text : tr("还没有输出。", "No output yet.")}
    </pre>
  );
}

/** Commands kept in Settings, run in a chosen folder: one-off, or kept running with their PID shown. */
export function CommandTasks() {
  const [tasks, setTasks] = useState<CommandTask[] | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [saving, setSaving] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  /** The last poll failed. Passing: a task like "restart MirrorMix" takes the server away for a few seconds. */
  const [offline, setOffline] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setTasks((await api.tasks()).tasks);
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const replace = (task: CommandTask) => setTasks((list) => (list ?? []).map((item) => (item.id === task.id ? task : item)));

  const save = async (draft: TaskDraft) => {
    setSaving(true);
    setError("");
    try {
      if (editing === "new") {
        const task = await api.createTask(draft);
        setTasks((list) => [...(list ?? []), task]);
      } else if (editing) {
        replace(await api.updateTask(editing, draft));
      }
      setEditing(null);
    } catch (problem) {
      if (problem instanceof TypeError) setOffline(true);
      else setError(errorText(problem));
    } finally {
      setSaving(false);
    }
  };

  const act = async (task: CommandTask, action: "start" | "stop" | "restart" | "delete") => {
    setActing(task.id);
    setError("");
    try {
      if (action === "delete") {
        await api.deleteTask(task.id);
        setTasks((list) => (list ?? []).filter((item) => item.id !== task.id));
        setConfirming(null);
        return;
      }
      setConfirming(null);
      if (action === "stop") replace(await api.stopTask(task.id));
      // The server restarts the task itself; for MirrorMix it hands the job to a helper and goes away for a moment.
      if (action === "restart") replace(await api.restartTask(task.id));
      if (action === "start") {
        replace(await api.startTask(task.id));
        setOpen(task.id);
      }
    } catch (problem) {
      if (problem instanceof TypeError) setOffline(true);
      else setError(errorText(problem));
      void refresh();
    } finally {
      setActing(null);
    }
  };

  if (!tasks) {
    return (
      <div className="remote-loading">
        {offline ? <p className="banner is-warning">{tr("暂时连不上 MirrorMix，正在重试。", "Cannot reach MirrorMix right now; retrying.")}</p> : <Spinner />}
      </div>
    );
  }

  return (
    <div className="tasks">
      {offline && (
        <p className="task-offline" role="status">
          <Spinner />
          {tr("暂时连不上 MirrorMix，可能正在重启，恢复后自动刷新。", "Cannot reach MirrorMix right now; it may be restarting and refreshes once it is back.")}
        </p>
      )}
      {error && !offline && <p className="banner is-warning">{error}</p>}
      {tasks.length === 0 && editing !== "new" && (
        <p className="blank">{tr("还没有命令任务。添加一个，指定目录和命令，就能在这里运行和停止。", "No command tasks yet. Add one with a folder and a command to run and stop it here.")}</p>
      )}
      <ul className="task-list">
        {tasks.map((task) => {
          if (editing === task.id) {
            return (
              <li key={task.id} className="task-card">
                <TaskForm initial={task} busy={saving} onSave={(draft) => void save(draft)} onCancel={() => setEditing(null)} />
              </li>
            );
          }
          const status = statusOf(task);
          const running = task.status === "running";
          const busy = acting === task.id;
          return (
            <li key={task.id} className={`task-card is-${status.tone}`}>
              <div className="task-head">
                <strong title={task.name}>{task.name}</strong>
                <span className={`task-kind-tag is-${task.kind}`}>{KIND_LABEL()[task.kind]}</span>
                {running && task.self && (
                  <span className="task-kind-tag is-self" title={tr("这个任务运行的就是当前这个 MirrorMix", "This task is the MirrorMix you are using")}>
                    {tr("MirrorMix 本身", "MirrorMix itself")}
                  </span>
                )}
                <span className={`task-status is-${status.tone}`} role="status">
                  {running ? <span className="dot pulse" /> : <span className="dot" />}
                  {status.text}
                </span>
              </div>
              <p className="task-command" title={task.command}>
                <span aria-hidden="true">›</span> {task.command}
              </p>
              <p className="task-cwd" title={task.cwd}>{task.cwd}</p>
              <div className="task-actions">
                {running ? (
                  <>
                    {confirming === `stop:${task.id}` ? (
                      <>
                        <button type="button" className="quiet-button danger" disabled={busy} onClick={() => void act(task, "stop")}>
                          {busy && <Spinner />}{tr("确认停止", "Confirm stop")}
                        </button>
                        <button type="button" className="link-button" onClick={() => setConfirming(null)}>
                          {tr("取消", "Cancel")}
                        </button>
                        <span className="task-warn">{tr("停止后网页会断开，要在电脑上重新启动 MirrorMix。", "Stopping disconnects this page; you will need to start MirrorMix again on the computer.")}</span>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="quiet-button"
                        disabled={busy}
                        onClick={() => (task.self ? setConfirming(`stop:${task.id}`) : void act(task, "stop"))}
                      >
                        {busy && <Spinner />}{tr("停止", "Stop")}
                      </button>
                    )}
                    {task.kind === "service" && (
                      <button type="button" className="quiet-button" disabled={busy} onClick={() => void act(task, "restart")}>
                        {tr("重启", "Restart")}
                      </button>
                    )}
                  </>
                ) : (
                  <button type="button" className="quiet-button primary" disabled={busy} onClick={() => void act(task, "start")}>
                    {busy && <Spinner />}
                    {task.kind === "service" ? tr("启动", "Start") : tr("运行", "Run")}
                  </button>
                )}
                <button
                  type="button"
                  className="quiet-button"
                  aria-expanded={open === task.id}
                  onClick={() => setOpen(open === task.id ? null : task.id)}
                >
                  {open === task.id ? tr("收起输出", "Hide output") : tr("输出", "Output")}
                </button>
                <span className="task-actions-gap" />
                <button type="button" className="link-button" disabled={running} title={running ? tr("先停止再修改", "Stop it before editing") : undefined} onClick={() => setEditing(task.id)}>
                  {tr("修改", "Edit")}
                </button>
                {confirming === task.id ? (
                  <>
                    <button type="button" className="link-button danger" disabled={busy} onClick={() => void act(task, "delete")}>
                      {running ? tr("停止并删除", "Stop and delete") : tr("确认删除", "Confirm delete")}
                    </button>
                    <button type="button" className="link-button" onClick={() => setConfirming(null)}>
                      {tr("取消", "Cancel")}
                    </button>
                  </>
                ) : (
                  <button type="button" className="link-button" onClick={() => setConfirming(task.id)}>
                    {tr("删除", "Delete")}
                  </button>
                )}
              </div>
              {open === task.id && <TaskLog task={task} />}
            </li>
          );
        })}
        {editing === "new" && (
          <li className="task-card">
            <TaskForm initial={EMPTY} busy={saving} onSave={(draft) => void save(draft)} onCancel={() => setEditing(null)} />
          </li>
        )}
      </ul>
      {editing !== "new" && (
        <button type="button" className="quiet-button task-add" onClick={() => setEditing("new")}>
          {tr("+ 添加命令任务", "+ Add command task")}
        </button>
      )}
    </div>
  );
}
