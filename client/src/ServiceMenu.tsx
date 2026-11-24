import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { MAX_SERVICES } from "../../src/shared/projectServices";
import { api, type ProjectService, type ServiceAction, type ServiceView, type TerminalList, type ToolId } from "./api";
import { PlusIcon, Spinner, TrashIcon } from "./icons";

import { tr } from "./i18n";
const ERRORS = (): Record<string, string> => ({
  service_name: tr("每个服务需要一个名称（20 字以内）。", "Each service needs a name (up to 20 characters)."),
  service_duplicate: tr("服务名称不能重复。", "Service names must be unique."),
  service_command: tr("每个服务需要一条单行启动命令。", "Each service needs a one-line start command."),
  service_dir: tr("目录要写项目里的相对路径，比如 server 或 apps/web；留空表示项目根目录。", "The folder is a path inside the project, such as server or apps/web; leave it empty for the project root."),
  service_invalid: tr("最多设置 6 个服务。", "Up to 6 services."),
  service_dir_missing: tr("服务的目录不存在了，请检查设置。", "The service's folder no longer exists; check the settings."),
  service_missing: tr("这个服务已经不在设置里了，列表已刷新。", "This service is no longer in the settings; the list has been refreshed."),
  service_stop: tr("没能停止正在运行的程序，可以在它的终端里按 Ctrl+C 后再试。", "Could not stop the running program. Press Ctrl+C in its terminal and try again."),
  service_status: tr("暂时无法获取服务进程状态，请稍后再试。", "Cannot get the services' process state right now; try again later."),
  too_many: tr("这个项目的终端已满 8 个，先关掉一个再启动。", "This project already has 8 terminals; close one first."),
  missing_workspace: tr("项目目录不存在了。", "The project folder no longer exists."),
});

function errorText(error: unknown): string {
  return ERRORS()[(error as { code?: string }).code ?? ""] ?? tr("操作没有成功，请稍后再试。", "That did not work. Please try again later.");
}

const ACTION_LABEL = (): Record<ServiceAction, string> => ({ start: tr("启动", "Start"), stop: tr("停止", "Stop"), restart: tr("重启", "Restart") });

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
      setNote(found.length ? added.length ? tr(`识别到 ${added.length} 个，确认后保存。`, `Found ${added.length}; check them, then save.`) : tr("没有发现新的服务。", "No new services found.") : tr("没有识别出启动方式，请手动填写。", "Could not tell how to start it; fill it in by hand."));
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
    <section id="project-service-menu" className="cmd-menu shortcut-menu service-menu" aria-label={tr("项目服务", "Project services")} onKeyDown={event => {
      if (event.key === "Escape" && draft) { event.stopPropagation(); setDraft(null); setNote(""); }
    }}>
      {problem && <p className="shortcut-error" role="alert">{problem}</p>}
      {!services && !problem && <p className="cmd-menu-empty">{tr("正在读取项目服务…", "Loading project services…")}</p>}
      {services && !draft && (
        <>
          {services.length === 0 ? (
            <div className="service-empty">
              <p>{tr("还没有设置这个项目要启动的程序。可以自动识别前端、后端的目录和启动命令，再按需修改。", "No programs are set up to start for this project. Detect the front- and back-end folders and start commands automatically, then adjust them.")}</p>
              <div className="shortcut-buttons">
                <button type="button" disabled={disabled} onClick={() => { setDraft([{ name: "", dir: "", command: "" }]); setNote(""); }}>{tr("手动填写", "Fill in by hand")}</button>
                <button type="button" disabled={disabled} onClick={() => void detect([])}>{spin("detect")}{tr("自动识别", "Detect")}</button>
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
                      title={service.tid ? tr("切换到它的终端", "Switch to its terminal") : tr("还没有启动过", "Never started")}
                      onClick={() => service.tid && onShow(service.tid)}
                    >
                      <strong>{service.name}</strong>
                      <small title={`${service.dir || "."} › ${service.command}`}>{service.dir ? `${service.dir} › ` : ""}{service.command}</small>
                    </button>
                    {service.running ? (
                      <>
                        <button type="button" className="shortcut-action" disabled={disabled} onClick={() => void act("restart", [service.name])}>{spin(key("restart"))}{tr("重启", "Restart")}</button>
                        <button type="button" className="shortcut-action" disabled={disabled} onClick={() => void act("stop", [service.name])}>{spin(key("stop"))}{tr("停止", "Stop")}</button>
                      </>
                    ) : (
                      <button type="button" className="shortcut-action is-go" disabled={disabled} onClick={() => void act("start", [service.name])}>{spin(key("start"))}{tr("启动", "Start")}</button>
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
                  {spin(`${action}:`)}{tr(`全部${ACTION_LABEL()[action]}`, `${ACTION_LABEL()[action]} all`)}
                </button>
              ))}
              <span className="service-gap" />
              <button type="button" className="shortcut-action" disabled={disabled} onClick={() => { setDraft(services.map(({ name, dir, command }) => ({ name, dir, command }))); setNote(""); }}>{tr("设置", "Settings")}</button>
            </div>
          )}
        </>
      )}
      {draft && (
        <form className="shortcut-form service-form" onSubmit={event => void save(event)}>
          <strong>{tr("项目服务", "Project services")}</strong>
          <p title={root}>{tr(`目录相对于 ${root || "项目根目录"}，留空即根目录。每个服务在自己的终端标签里运行。`, `Folders are relative to ${root || "the project root"}; leave it empty for the root. Each service runs in its own terminal tab.`)}</p>
          {draft.map((row, index) => (
            <div className="service-edit" key={index}>
              <input aria-label={tr("名称", "Name")} placeholder={tr("后端", "Back end")} maxLength={20} value={row.name} onChange={event => edit(index, { name: event.target.value })} />
              <input aria-label={tr("目录", "Folder")} placeholder="server" spellCheck={false} value={row.dir} onChange={event => edit(index, { dir: event.target.value })} />
              <input aria-label={tr("启动命令", "Start command")} className="mono" placeholder="npm run dev" spellCheck={false} value={row.command} onChange={event => edit(index, { command: event.target.value })} />
              <button type="button" className="shortcut-action is-icon is-danger" aria-label={tr(`删除 ${row.name || "这一行"}`, `Delete ${row.name || "this row"}`)} title={tr("删除", "Delete")} onClick={() => setDraft(draft.filter((_, at) => at !== index))}><TrashIcon /></button>
            </div>
          ))}
          {note && <p role="status">{note}</p>}
          <div className="shortcut-buttons">
            <button type="button" disabled={disabled || draft.length >= MAX_SERVICES} onClick={() => setDraft([...draft, { name: "", dir: "", command: "" }])}><PlusIcon />{tr("添加", "Add")}</button>
            <button type="button" disabled={disabled} onClick={() => void detect(draft)}>{spin("detect")}{tr("自动识别", "Detect")}</button>
            <span className="service-gap" />
            <button type="button" disabled={disabled} onClick={() => { setDraft(null); setNote(""); setProblem(""); }}>{tr("取消", "Cancel")}</button>
            <button type="submit" disabled={disabled}>{spin("save")}{tr("保存", "Save")}</button>
          </div>
        </form>
      )}
    </section>
  );
}
