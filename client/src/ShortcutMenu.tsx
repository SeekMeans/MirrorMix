import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { api, type Shortcut, type ShortcutLibrary } from "./api";
import { COMMIT_MESSAGE_TOKEN } from "../../src/shared/shortcuts";
import { EditIcon, PlusIcon, TrashIcon } from "./icons";

const LEGACY_KEY = "mirrormix.cmd.shortcuts";
const keyOf = (entry: Shortcut) => JSON.stringify([entry.group, entry.name]);

function legacyCommands(cwd: string): string[] {
  try {
    const book = JSON.parse(localStorage.getItem(LEGACY_KEY) ?? "{}");
    return Array.isArray(book?.[cwd]) ? book[cwd].filter((item: unknown): item is string => typeof item === "string" && Boolean(item.trim())) : [];
  } catch { return []; }
}

function errorText(error: unknown): string {
  const code = (error as { code?: string }).code;
  if (code === "commands_changed") return "命令库已在别处修改，已重新读取，请再试一次。";
  if (code === "commands_duplicate") return "这个分组里已有同名命令，请换一个名称。";
  if (code === "commands_template") return '提交说明参数请写成：git commit -m "{{message}}"。';
  if (code === "commands_invalid") return "命令库格式有误：每项需要分组、名称和单行命令，分组内名称不能重复。";
  if (code === "commands_message") return "提交说明最多 1000 个字符，请使用单行文字。";
  if (code === "unauthenticated") return "登录已失效，请重新登录。";
  return "命令库没有读取或保存成功，请检查 JSON 文件后重新打开这个菜单。";
}

export function ShortcutMenu({ cwd, ready, onRun, onChoose, initial }: {
  cwd: string;
  ready: boolean;
  onRun: (command: string) => boolean;
  onChoose: (name: string) => void;
  /** The list as the terminal panel read it when it opened: shown at once, then read again here. */
  initial?: ShortcutLibrary | null;
}) {
  const [library, setLibrary] = useState<ShortcutLibrary | null>(initial ?? null);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<Shortcut | null>(null);
  const [original, setOriginal] = useState<string | null>(null);
  const [selected, setSelected] = useState<Shortcut | null>(null);
  const [message, setMessage] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);
  const groupList = useId();
  const mounted = useRef(true);
  const [legacy] = useState(() => legacyCommands(cwd));

  useEffect(() => {
    mounted.current = true;
    let gone = false;
    api.commands().then(value => { if (!gone) setLibrary(value); }, error => { if (!gone) setProblem(errorText(error)); });
    return () => { gone = true; mounted.current = false; };
  }, []);

  const groups = new Map<string, Shortcut[]>();
  for (const entry of library?.commands ?? []) groups.set(entry.group, [...(groups.get(entry.group) ?? []), entry]);
  const oldCommands = legacy.filter(command => !library?.commands.some(entry => entry.command === command));

  /** Someone else changed the library: read it again so the next try saves against the new version. */
  function reloadAfter(error: unknown) {
    setProblem(errorText(error));
    if ((error as { code?: string }).code !== "commands_changed") return;
    api.commands().then(value => { if (mounted.current) setLibrary(value); }, () => undefined);
  }

  async function save(commands: Shortcut[]) {
    if (!library || busy) return false;
    setBusy(true); setProblem("");
    try { setLibrary(await api.saveCommands(commands, library.revision)); return true; }
    catch (error) { reloadAfter(error); return false; }
    finally { setBusy(false); }
  }

  async function submitEditor(event: FormEvent) {
    event.preventDefault();
    if (!library || !editor) return;
    const next = { group: editor.group.trim(), name: editor.name.trim(), command: editor.command.trim() };
    const commands = original === null ? [...library.commands, next] : library.commands.map(entry => keyOf(entry) === original ? next : entry);
    if (await save(commands)) { setEditor(null); setOriginal(null); }
  }

  async function execute(entry: Shortcut) {
    if (!library || busy) return;
    setBusy(true); setProblem("");
    try {
      const result = await api.prepareCommand(entry, library.revision, message);
      if (!mounted.current) return;
      if (onRun(result.command)) onChoose(entry.name);
      else setProblem("终端尚未连接，请连接后重试。");
    } catch (error) { reloadAfter(error); }
    finally { setBusy(false); }
  }

  function edit(entry?: Shortcut) {
    setOriginal(entry ? keyOf(entry) : null);
    setEditor(entry ? { ...entry } : { group: groups.keys().next().value ?? "通用命令", name: "", command: "" });
    setSelected(null); setRemoving(null); setProblem("");
  }

  return (
    <section id="global-shortcut-menu" className="cmd-menu shortcut-menu" aria-label="全局快捷命令" onKeyDown={event => {
      if (event.key === "Escape" && (editor || selected || removing)) {
        event.stopPropagation(); setEditor(null); setSelected(null); setRemoving(null);
      }
    }}>
      {problem && <p className="shortcut-error" role="alert">{problem}</p>}
      {!library && !problem && <p className="cmd-menu-empty">正在读取命令库…</p>}
      {!editor && !selected && (
        <div className="cmd-menu-list">
          {[...groups].map(([group, entries]) => (
            <details className="shortcut-group" key={group}>
              <summary>{group}<span>{entries.length}</span></summary>
              {entries.map(entry => {
                const key = keyOf(entry);
                return <div className="shortcut-entry" key={key}>
                  <div className="shortcut-row">
                    <button type="button" className="shortcut-run" title={entry.command} disabled={!ready || busy} onClick={() => {
                      setProblem("");
                      if (entry.command.includes(COMMIT_MESSAGE_TOKEN)) { setSelected(entry); setMessage(""); }
                      else void execute(entry);
                    }}>{entry.name}</button>
                    <button type="button" className="shortcut-action is-icon" disabled={busy} aria-label={`编辑 ${entry.name}`} title="编辑" onClick={() => edit(entry)}><EditIcon /></button>
                    <button type="button" className="shortcut-action is-icon is-danger" disabled={busy} aria-label={`删除 ${entry.name}`} title="删除" onClick={() => setRemoving(removing === key ? null : key)}><TrashIcon /></button>
                  </div>
                  {removing === key && <div className="shortcut-remove">从全局命令库移除“{entry.name}”？<button type="button" disabled={busy} onClick={() => void save(library!.commands.filter(item => keyOf(item) !== key)).then(ok => { if (ok) setRemoving(null); })}>确认移除</button><button type="button" onClick={() => setRemoving(null)}>取消</button></div>}
                </div>;
              })}
            </details>
          ))}
          {library?.commands.length === 0 && <p className="cmd-menu-empty">还没有全局快捷命令</p>}
          {oldCommands.length > 0 && <details className="shortcut-group"><summary>本项目旧快捷命令<span>{oldCommands.length}</span></summary>
            {oldCommands.map((command, index) => <div className="shortcut-row" key={`${index}:${command}`}><button type="button" className="shortcut-run" title={command} disabled={!ready || busy} onClick={() => { if (onRun(command)) onChoose(command); }}>{command}</button><button type="button" className="shortcut-action" disabled={!library || busy} onClick={() => { setOriginal(null); setEditor({ group: "通用命令", name: command.slice(0, 80), command }); }}>另存全局</button></div>)}
          </details>}
        </div>
      )}
      {selected && <form className="shortcut-form" onSubmit={event => { event.preventDefault(); void execute(selected); }}>
        <strong>{selected.name}</strong>
        <label>提交说明<input autoFocus maxLength={1000} value={message} placeholder="留空使用 new" onChange={event => setMessage(event.target.value)} /></label>
        <p>留空会使用 new。执行时会暂存当前目录的改动，并依次提交、拉取、推送；任一步失败即停止。</p>
        <details><summary>查看命令</summary><pre>{selected.command.replaceAll(COMMIT_MESSAGE_TOKEN, (message.trim() || "new"))}</pre></details>
        <div className="shortcut-buttons"><button type="button" disabled={busy} onClick={() => setSelected(null)}>返回</button><button type="submit" disabled={!ready || busy}>{busy ? "正在准备…" : "执行"}</button></div>
      </form>}
      {editor && <form className="shortcut-form" onSubmit={event => void submitEditor(event)}>
        <strong>{original ? "编辑全局命令" : "添加全局命令"}</strong>
        <label>分组<input required maxLength={80} list={groupList} value={editor.group} onChange={event => setEditor({ ...editor, group: event.target.value })} /></label>
        <datalist id={groupList}>{[...groups.keys()].map(group => <option key={group} value={group} />)}</datalist>
        <label>名称<input required autoFocus maxLength={80} value={editor.name} onChange={event => setEditor({ ...editor, name: event.target.value })} /></label>
        <label>命令<textarea required rows={3} maxLength={10_000} value={editor.command} onChange={event => setEditor({ ...editor, command: event.target.value })} /></label>
        <p>多条命令用 && 连接。可用 git commit -m "{'{{message}}'}" 在执行时填写提交说明。</p>
        <div className="shortcut-buttons"><button type="button" disabled={busy} onClick={() => setEditor(null)}>取消</button><button type="submit" disabled={busy}>{busy ? "正在保存…" : "保存到全局"}</button></div>
      </form>}
      {!editor && !selected && <button type="button" className="cmd-add-open" disabled={!library || busy} onClick={() => edit()}><PlusIcon /><span>添加全局命令</span></button>}
    </section>
  );
}
