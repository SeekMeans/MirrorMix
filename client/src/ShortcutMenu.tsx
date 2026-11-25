import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { api, type Shortcut, type ShortcutLibrary } from "./api";
import { EditIcon, PlusIcon, TrashIcon } from "./icons";

import { tr } from "./i18n";
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
  if (code === "commands_changed") return tr("命令库已在别处修改，已重新读取，请再试一次。", "The command library changed elsewhere and was reloaded. Please try again.");
  if (code === "commands_duplicate") return tr("这个分组里已有同名命令，请换一个名称。", "This group already has a command with that name. Choose another name.");
  if (code === "commands_template") return tr('提交说明参数请写成：git commit -m "{{message}}"。', 'Write the commit message parameter as: git commit -m "{{message}}".');
  if (code === "commands_invalid") return tr("命令库格式有误：每项需要分组、名称和单行命令，分组内名称不能重复。", "The command library is malformed: each entry needs a group, a name and a one-line command, with unique names in a group.");
  if (code === "commands_message") return tr("提交说明最多 1000 个字符，请使用单行文字。", "A commit message can be up to 1000 characters on one line.");
  if (code === "unauthenticated") return tr("登录已失效，请重新登录。", "Your sign-in has expired. Please sign in again.");
  return tr("命令库没有读取或保存成功，请检查 JSON 文件后重新打开这个菜单。", "The command library did not load or save. Check the JSON file, then reopen this menu.");
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
      const result = await api.prepareCommand(entry, library.revision, "");
      if (!mounted.current) return;
      if (onRun(result.command)) onChoose(entry.name);
      else setProblem(tr("终端尚未连接，请连接后重试。", "The terminal is not connected yet. Connect it and try again."));
    } catch (error) { reloadAfter(error); }
    finally { setBusy(false); }
  }

  function edit(entry?: Shortcut) {
    setOriginal(entry ? keyOf(entry) : null);
    setEditor(entry ? { ...entry } : { group: groups.keys().next().value ?? tr("通用命令", "General"), name: "", command: "" });
    setRemoving(null); setProblem("");
  }

  return (
    <section id="global-shortcut-menu" className="cmd-menu shortcut-menu" aria-label={tr("全局快捷命令", "Global shortcuts")} onKeyDown={event => {
      if (event.key === "Escape" && (editor || removing)) {
        event.stopPropagation(); setEditor(null); setRemoving(null);
      }
    }}>
      {problem && <p className="shortcut-error" role="alert">{problem}</p>}
      {!library && !problem && <p className="cmd-menu-empty">{tr("正在读取命令库…", "Loading commands…")}</p>}
      {!editor && (
        <div className="cmd-menu-list">
          {[...groups].map(([group, entries]) => (
            <details className="shortcut-group" key={group}>
              <summary>{group}<span>{entries.length}</span></summary>
              {entries.map(entry => {
                const key = keyOf(entry);
                return <div className="shortcut-entry" key={key}>
                  <div className="shortcut-row">
                    <button type="button" className="shortcut-run" title={entry.command} disabled={!ready || busy} onClick={() => void execute(entry)}>{entry.name}</button>
                    <button type="button" className="shortcut-action is-icon" disabled={busy} aria-label={tr(`编辑 ${entry.name}`, `Edit ${entry.name}`)} title={tr("编辑", "Edit")} onClick={() => edit(entry)}><EditIcon /></button>
                    <button type="button" className="shortcut-action is-icon is-danger" disabled={busy} aria-label={tr(`删除 ${entry.name}`, `Delete ${entry.name}`)} title={tr("删除", "Delete")} onClick={() => setRemoving(removing === key ? null : key)}><TrashIcon /></button>
                  </div>
                  {removing === key && <div className="shortcut-remove">{tr(`从全局命令库移除“${entry.name}”？`, `Remove "${entry.name}" from the global commands? `)}<button type="button" disabled={busy} onClick={() => void save(library!.commands.filter(item => keyOf(item) !== key)).then(ok => { if (ok) setRemoving(null); })}>{tr("确认移除", "Remove")}</button><button type="button" onClick={() => setRemoving(null)}>{tr("取消", "Cancel")}</button></div>}
                </div>;
              })}
            </details>
          ))}
          {library?.commands.length === 0 && <p className="cmd-menu-empty">{tr("还没有全局快捷命令", "No global shortcuts yet")}</p>}
          {oldCommands.length > 0 && <details className="shortcut-group"><summary>{tr("本项目旧快捷命令", "This project's old shortcuts")}<span>{oldCommands.length}</span></summary>
            {oldCommands.map((command, index) => <div className="shortcut-row" key={`${index}:${command}`}><button type="button" className="shortcut-run" title={command} disabled={!ready || busy} onClick={() => { if (onRun(command)) onChoose(command); }}>{command}</button><button type="button" className="shortcut-action" disabled={!library || busy} onClick={() => { setOriginal(null); setEditor({ group: tr("通用命令", "General"), name: command.slice(0, 80), command }); }}>{tr("另存全局", "Save as global")}</button></div>)}
          </details>}
        </div>
      )}
      {editor && <form className="shortcut-form" onSubmit={event => void submitEditor(event)}>
        <strong>{original ? tr("编辑全局命令", "Edit global command") : tr("添加全局命令", "Add global command")}</strong>
        <label>{tr("分组", "Group")}<input required maxLength={80} list={groupList} value={editor.group} onChange={event => setEditor({ ...editor, group: event.target.value })} /></label>
        <datalist id={groupList}>{[...groups.keys()].map(group => <option key={group} value={group} />)}</datalist>
        <label>{tr("名称", "Name")}<input required autoFocus maxLength={80} value={editor.name} onChange={event => setEditor({ ...editor, name: event.target.value })} /></label>
        <label>{tr("命令", "Command")}<textarea required rows={3} maxLength={10_000} value={editor.command} onChange={event => setEditor({ ...editor, command: event.target.value })} /></label>
        <p>{tr('多条命令用 && 连接。写 git commit -m "{{message}}" 时，提交说明自动填为当前时间和电脑名。', 'Join several commands with &&. In git commit -m "{{message}}", the message is filled in with the current time and computer name.')}</p>
        <div className="shortcut-buttons"><button type="button" disabled={busy} onClick={() => setEditor(null)}>{tr("取消", "Cancel")}</button><button type="submit" disabled={busy}>{busy ? tr("正在保存…", "Saving…") : tr("保存到全局", "Save as global")}</button></div>
      </form>}
      {!editor && <button type="button" className="cmd-add-open" disabled={!library || busy} onClick={() => edit()}><PlusIcon /><span>{tr("添加全局命令", "Add global command")}</span></button>}
    </section>
  );
}
