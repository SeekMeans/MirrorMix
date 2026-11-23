import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { MAX_SERVICES } from "../../src/shared/projectServices";
import { api, type ProjectService, type ServiceAction, type ServiceView, type TerminalList, type ToolId } from "./api";
import { PlusIcon, Spinner, TrashIcon } from "./icons";

const ERRORS: Record<string, string> = {
  service_name: "每个服务需要一个名称（20 字以内）。",
  service_duplicate: "服务名称不能重复。",
  service_command: "每个服务需要一条单行启动命令。",
  service_dir: "目录要写项目里的相对路径，比如 server 或 apps/web；留空表示项目根目录。",
  service_invalid: "最多设置 6 个服务。",
  service_dir_missing: "服务的目录不存在了，请检查设置。",
  service_missing: "这个服务已经不在设置里了，列表已刷新。",
  service_stop: "没能停止正在运行的程序，可以在它的终端里按 Ctrl+C 后再试。",
  service_status: "暂时无法获取服务进程状态，请稍后再试。",
  too_many: "这个项目的终端已满 8 个，先关掉一个再启动。",
  missing_workspace: "项目目录不存在了。",
};

function errorText(error: unknown): string {
  return ERRORS[(error as { code?: string }).code ?? ""] ?? "操作没有成功，请稍后再试。";
}

const ACTION_LABEL: Record<ServiceAction, string> = { start: "启动", stop: "停止", restart: "重启" };

/**
 * The project's own programs (前端, 后端…), each started in a terminal tab named after it.
 * Restart stops only what was started in that tab and types its command again.
 */
export function ServiceMenu({ tool, id, onTerminals, onShow }: {
  tool: ToolId;
  id: string;
  /** A service was started: show the tabs as they are now, with `focus` in front. */
  onTerminals: (list: TerminalList, focus?: string) => void;
  onShow: (tid: string) => void;
}) {
  const [services, setServices] = useState<ServiceView[] | null>(null);
  const [root, setRoot] = useState("");
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState<ProjectService[] | null>(null);
  const [note, setNote] = useState("");
  const mounted = useRef(true);
  const acting = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const list = await api.services(tool, id);
      if (!mounted.current || acting.current) return;
      setServices(list.services);
      setRoot(list.root);
    } catch (error) {
      if (mounted.current) { setServices(current => current ?? []); setProblem(errorText(error)); }
    }
  }, [tool, id]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    // Something started in a service's tab can end on its own (a crash, Ctrl+C typed there).
    // Each look costs the PC a process lookup, so it waits while an action runs and is not repeated too often.
    const timer = window.setInterval(() => { if (document.visibilityState !== "hidden" && !acting.current) void refresh(); }, 4000);
    return () => { mounted.current = false; window.clearInterval(timer); };
  }, [refresh]);

  const act = async (action: ServiceAction, names: string[] = []) => {
    if (acting.current) return;
    acting.current = true;
    setBusy(`${action}:${names.join("\n")}`);
    setProblem("");
    try {
      const result = await api.runServices(tool, id, action, names);
      if (!mounted.current) return;
      setServices(result.services);
      onTerminals(result, action === "stop" ? undefined : result.focus);
    } catch (error) {
      if (mounted.current) setProblem(errorText(error));
    } finally {
      acting.current = false;
      if (mounted.current) setBusy(null);
    }
  };

  const detect = async (into: ProjectService[]) => {
    setBusy("detect");
    setProblem("");
    try {
      const found = (await api.detectServices(tool, id)).services;
      if (!mounted.current) return;
      const names = new Set(into.map(item => item.name));
      const filled = into.filter(row => row.name || row.command);
      const added = found.filter(item => !names.has(item.name) && !filled.some(row => row.dir === item.dir && row.command === item.command))
        .slice(0, MAX_SERVICES - filled.length);
      setDraft([...filled, ...added]);
      setNote(found.length ? added.length ? `识别到 ${added.length} 个，确认后保存。` : "没有发现新的服务。" : "没有识别出启动方式，请手动填写。");
    } catch (error) {
      if (mounted.current) setProblem(errorText(error));
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft) return;
    setBusy("save");
    setProblem("");
    try {
      const list = await api.saveServices(tool, id, draft.filter(row => row.name.trim() || row.command.trim()));
      if (!mounted.current) return;
      setServices(list.services);
      setDraft(null);
      setNote("");
    } catch (error) {
      if (mounted.current) setProblem(errorText(error));
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const edit = (index: number, change: Partial<ProjectService>) =>
    setDraft(rows => rows?.map((row, at) => at === index ? { ...row, ...change } : row) ?? rows);

  const anyRunning = services?.some(item => item.running) ?? false;
  const disabled = busy !== null;
  const spin = (key: string) => busy === key ? <Spinner /> : null;

  return (
    <section id="project-service-menu" className="cmd-menu shortcut-menu service-menu" aria-label="项目服务" onKeyDown={event => {
      if (event.key === "Escape" && draft) { event.stopPropagation(); setDraft(null); setNote(""); }
    }}>
      {problem && <p className="shortcut-error" role="alert">{problem}</p>}
      {!services && !problem && <p className="cmd-menu-empty">正在读取项目服务…</p>}
      {services && !draft && (
        <>
          {services.length === 0 ? (
            <div className="service-empty">
              <p>还没有设置这个项目要启动的程序。可以自动识别前端、后端的目录和启动命令，再按需修改。</p>
              <div className="shortcut-buttons">
                <button type="button" disabled={disabled} onClick={() => { setDraft([{ name: "", dir: "", command: "" }]); setNote(""); }}>手动填写</button>
                <button type="button" disabled={disabled} onClick={() => void detect([])}>{spin("detect")}自动识别</button>
              </div>
            </div>
          ) : (
            <ul className="service-list">
              {services.map(service => {
                const key = (action: ServiceAction) => `${action}:${service.name}`;
                return (
                  <li key={service.name} className={service.running ? "service-row is-on" : "service-row"}>
                    <span className={service.running ? "dot pulse" : "dot"} aria-hidden="true" />
                    <button
                      type="button"
                      className="service-name"
                      disabled={!service.tid}
                      title={service.tid ? "切换到它的终端" : "还没有启动过"}
                      onClick={() => service.tid && onShow(service.tid)}
                    >
                      <strong>{service.name}</strong>
                      <small title={`${service.dir || "."} › ${service.command}`}>{service.dir ? `${service.dir} › ` : ""}{service.command}</small>
                    </button>
                    {service.running ? (
                      <>
                        <button type="button" className="shortcut-action" disabled={disabled} onClick={() => void act("restart", [service.name])}>{spin(key("restart"))}重启</button>
                        <button type="button" className="shortcut-action" disabled={disabled} onClick={() => void act("stop", [service.name])}>{spin(key("stop"))}停止</button>
                      </>
                    ) : (
                      <button type="button" className="shortcut-action is-go" disabled={disabled} onClick={() => void act("start", [service.name])}>{spin(key("start"))}启动</button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {services.length > 0 && (
            <div className="service-foot">
              {(["start", "restart", "stop"] as const).map(action => (
                <button
                  type="button"
                  key={action}
                  className={action === "start" ? "shortcut-action is-go" : "shortcut-action"}
                  disabled={disabled || (action !== "start" && !anyRunning)}
                  onClick={() => void act(action)}
                >
                  {spin(`${action}:`)}全部{ACTION_LABEL[action]}
                </button>
              ))}
              <span className="service-gap" />
              <button type="button" className="shortcut-action" disabled={disabled} onClick={() => { setDraft(services.map(({ name, dir, command }) => ({ name, dir, command }))); setNote(""); }}>设置</button>
            </div>
          )}
        </>
      )}
      {draft && (
        <form className="shortcut-form service-form" onSubmit={event => void save(event)}>
          <strong>项目服务</strong>
          <p title={root}>目录相对于 {root || "项目根目录"}，留空即根目录。每个服务在自己的终端标签里运行。</p>
          {draft.map((row, index) => (
            <div className="service-edit" key={index}>
              <input aria-label="名称" placeholder="后端" maxLength={20} value={row.name} onChange={event => edit(index, { name: event.target.value })} />
              <input aria-label="目录" placeholder="server" spellCheck={false} value={row.dir} onChange={event => edit(index, { dir: event.target.value })} />
              <input aria-label="启动命令" className="mono" placeholder="npm run dev" spellCheck={false} value={row.command} onChange={event => edit(index, { command: event.target.value })} />
              <button type="button" className="shortcut-action is-icon is-danger" aria-label={`删除 ${row.name || "这一行"}`} title="删除" onClick={() => setDraft(draft.filter((_, at) => at !== index))}><TrashIcon /></button>
            </div>
          ))}
          {note && <p role="status">{note}</p>}
          <div className="shortcut-buttons">
            <button type="button" disabled={disabled || draft.length >= MAX_SERVICES} onClick={() => setDraft([...draft, { name: "", dir: "", command: "" }])}><PlusIcon />添加</button>
            <button type="button" disabled={disabled} onClick={() => void detect(draft)}>{spin("detect")}自动识别</button>
            <span className="service-gap" />
            <button type="button" disabled={disabled} onClick={() => { setDraft(null); setNote(""); setProblem(""); }}>取消</button>
            <button type="submit" disabled={disabled}>{spin("save")}保存</button>
          </div>
        </form>
      )}
    </section>
  );
}
