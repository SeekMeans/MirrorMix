import { useCallback, useEffect, useRef, useState } from "react";
import { api, type CommandTask, type TaskDraft, type TaskKind } from "./api";
import { Spinner } from "./icons";

const KIND_LABEL: Record<TaskKind, string> = { once: "一次性", service: "持续运行" };

const ERRORS: Record<string, string> = {
  task_name: "请填写名称（80 字以内）。",
  task_command: "请填写要执行的命令。",
  task_cwd: "目录不存在，请填写这台电脑上已有文件夹的完整路径。",
  task_running: "任务正在运行，先停止再修改。",
  task_limit: "最多保存 100 个命令任务。",
  task_spawn: "命令没能启动。",
  task_missing: "这个任务已经不在了，列表已刷新。",
};

function errorText(error: unknown): string {
  // fetch itself failed: the server is down for a moment, usually restarting.
  if (error instanceof TypeError) return "连不上 MirrorMix，可能正在重启。恢复后列表会自动刷新。";
  const code = (error as { code?: string }).code ?? "";
  return ERRORS[code] ?? "操作没有成功，请稍后再试。";
}

function clock(iso?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  const sameDay = date.toDateString() === new Date().toDateString();
  return date.toLocaleString("zh-CN", sameDay ? { hour12: false, timeStyle: "medium" } : { hour12: false, dateStyle: "short", timeStyle: "short" });
}

/** The status line of a task: a long-running one leads with its PID; a one-off with how it ended. */
function statusOf(task: CommandTask): { tone: "on" | "ok" | "bad" | "off"; text: string } {
  if (task.status === "running") {
    const lead = task.kind === "service" ? `运行中 · PID ${task.pid}` : `正在执行 · PID ${task.pid}`;
    // Ports come from a separate look at the process tree; a service that listens on nothing (yet) says so.
    const ports = !task.ports ? "" : task.ports.length ? ` · 端口 ${task.ports.join(", ")}` : task.kind === "service" ? " · 未监听端口" : "";
    return { tone: "on", text: lead + ports };
  }
  if (task.status === "idle") return { tone: "off", text: task.kind === "service" ? "未启动" : "还没运行过" };
  const code = task.exitCode == null ? "" : `（退出码 ${task.exitCode}）`;
  if (task.status === "stopped") return { tone: "off", text: `已停止 ${clock(task.endedAt)}` };
  if (task.status === "failed") return { tone: "bad", text: `${task.kind === "service" ? "已退出" : "失败"}${code} ${clock(task.endedAt)}` };
  return { tone: "ok", text: `${task.kind === "service" ? "已退出" : "完成"}${code} ${clock(task.endedAt)}` };
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
          名称
          <input value={draft.name} maxLength={80} placeholder="前端开发服务器" onChange={(e) => set({ name: e.target.value })} autoFocus />
        </label>
        <label className="task-span2">
          目录
          <input value={draft.cwd} placeholder={"E:\\project\\web"} spellCheck={false} onChange={(e) => set({ cwd: e.target.value })} />
        </label>
        <label className="wide">
          命令
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
        <div className="task-kind" role="radiogroup" aria-label="任务类型">
          {(["once", "service"] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              role="radio"
              aria-checked={draft.kind === kind}
              className={draft.kind === kind ? "active" : ""}
              onClick={() => set({ kind })}
            >
              {KIND_LABEL[kind]}
            </button>
          ))}
        </div>
        <p className="task-kind-note">
          {draft.kind === "service" ? "一直运行，直到你点停止，比如 npm run dev。" : "执行完就结束，比如构建或脚本。"}
        </p>
        <div className="task-form-actions">
          <button type="button" className="quiet-button" onClick={onCancel}>
            取消
          </button>
          <button type="submit" className="quiet-button primary" disabled={busy}>
            {busy && <Spinner />}
            保存
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
      {log.truncated && <span className="task-log-cut">{"…只显示最后 64 KB\n"}</span>}
      {log.text.trim() ? log.text : "还没有输出。"}
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
        {offline ? <p className="banner is-warning">暂时连不上 MirrorMix，正在重试。</p> : <Spinner />}
      </div>
    );
  }

  return (
    <div className="tasks">
      {offline && (
        <p className="task-offline" role="status">
          <Spinner />
          暂时连不上 MirrorMix，可能正在重启，恢复后自动刷新。
        </p>
      )}
      {error && !offline && <p className="banner is-warning">{error}</p>}
      {tasks.length === 0 && editing !== "new" && (
        <p className="blank">还没有命令任务。添加一个，指定目录和命令，就能在这里运行和停止。</p>
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
                <span className={`task-kind-tag is-${task.kind}`}>{KIND_LABEL[task.kind]}</span>
                {running && task.self && (
                  <span className="task-kind-tag is-self" title="这个任务运行的就是当前这个 MirrorMix">
                    MirrorMix 本身
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
                          {busy && <Spinner />}确认停止
                        </button>
                        <button type="button" className="link-button" onClick={() => setConfirming(null)}>
                          取消
                        </button>
                        <span className="task-warn">停止后网页会断开，要在电脑上重新启动 MirrorMix。</span>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="quiet-button"
                        disabled={busy}
                        onClick={() => (task.self ? setConfirming(`stop:${task.id}`) : void act(task, "stop"))}
                      >
                        {busy && <Spinner />}停止
                      </button>
                    )}
                    {task.kind === "service" && (
                      <button type="button" className="quiet-button" disabled={busy} onClick={() => void act(task, "restart")}>
                        重启
                      </button>
                    )}
                  </>
                ) : (
                  <button type="button" className="quiet-button primary" disabled={busy} onClick={() => void act(task, "start")}>
                    {busy && <Spinner />}
                    {task.kind === "service" ? "启动" : "运行"}
                  </button>
                )}
                <button
                  type="button"
                  className="quiet-button"
                  aria-expanded={open === task.id}
                  onClick={() => setOpen(open === task.id ? null : task.id)}
                >
                  {open === task.id ? "收起输出" : "输出"}
                </button>
                <span className="task-actions-gap" />
                <button type="button" className="link-button" disabled={running} title={running ? "先停止再修改" : undefined} onClick={() => setEditing(task.id)}>
                  修改
                </button>
                {confirming === task.id ? (
                  <>
                    <button type="button" className="link-button danger" disabled={busy} onClick={() => void act(task, "delete")}>
                      {running ? "停止并删除" : "确认删除"}
                    </button>
                    <button type="button" className="link-button" onClick={() => setConfirming(null)}>
                      取消
                    </button>
                  </>
                ) : (
                  <button type="button" className="link-button" onClick={() => setConfirming(task.id)}>
                    删除
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
          + 添加命令任务
        </button>
      )}
    </div>
  );
}
