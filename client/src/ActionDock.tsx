import { useEffect, useRef, useState } from "react";
import type { ToolId } from "./api";
import { CloseIcon, ConsoleIcon, FolderIcon } from "./icons";
import { PreviewButton } from "./PreviewButton";

import { tr } from "./i18n";
/**
 * The session's tools (command line, files, browser preview), floating at the right edge of the conversation.
 * Folded into one round button by default; pressing it unfolds the three upward.
 */
export function ActionDock({
  tool,
  id,
  workspacePath,
  cmdOpen,
  filesOpen,
  onCmd,
  onFiles,
}: {
  tool: ToolId;
  id: string;
  workspacePath: string;
  cmdOpen: boolean;
  filesOpen: boolean;
  onCmd: () => void;
  onFiles: () => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Element | null;
      // A tool's panel opens elsewhere on the page (the browser panel, under the header); using it is not leaving.
      if (box.current?.contains(target) || target?.closest?.("[data-dock-panel]")) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Another session starts folded.
  useEffect(() => setOpen(false), [tool, id]);

  const noFolder = tr("这条会话没有工作目录", "This conversation has no working folder");
  const anyOpen = cmdOpen || filesOpen;

  return (
    <div className={open ? "dock is-open" : "dock"} ref={box}>
      {open && (
        <div className="dock-items" role="group" aria-label={tr("会话工具", "Conversation tools")}>
          <button
            type="button"
            className={cmdOpen ? "dock-item is-on" : "dock-item"}
            aria-label={cmdOpen ? tr("收起命令行", "Hide the terminal") : tr("打开命令行", "Open the terminal")}
            aria-pressed={cmdOpen}
            title={workspacePath ? tr(`命令行：${workspacePath}`, `Terminal: ${workspacePath}`) : noFolder}
            disabled={!workspacePath}
            onClick={onCmd}
          >
            <ConsoleIcon />
          </button>
          <button
            type="button"
            className={filesOpen ? "dock-item is-on" : "dock-item"}
            aria-label={filesOpen ? tr("关闭资源管理器", "Close files") : tr("打开资源管理器", "Open files")}
            aria-pressed={filesOpen}
            title={workspacePath ? tr(`资源管理器：${workspacePath}`, `Files: ${workspacePath}`) : noFolder}
            disabled={!workspacePath}
            onClick={onFiles}
          >
            <FolderIcon />
          </button>
          {workspacePath && (
            <div className="dock-item-wrap">
              <PreviewButton tool={tool} id={id} />
            </div>
          )}
        </div>
      )}
      <button
        type="button"
        className="dock-toggle"
        aria-expanded={open}
        aria-label={open ? tr("收起会话工具", "Hide conversation tools") : tr("展开会话工具：命令行、资源管理器、浏览器", "Show conversation tools: terminal, files, browser")}
        title={open ? tr("收起", "Hide") : tr("命令行、资源管理器、浏览器", "Terminal, files, browser")}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? (
          <CloseIcon />
        ) : (
          <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1.2" />
            <rect x="9" y="2.5" width="4.5" height="4.5" rx="1.2" />
            <rect x="2.5" y="9" width="4.5" height="4.5" rx="1.2" />
            <rect x="9" y="9" width="4.5" height="4.5" rx="1.2" />
          </svg>
        )}
        {!open && anyOpen && <span className="dock-dot" aria-hidden="true" />}
      </button>
    </div>
  );
}
