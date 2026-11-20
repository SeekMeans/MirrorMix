import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, type ToolId } from "./api";
import { Spinner } from "./icons";

/** "+" over a list: add to the floating browser's file list. */
export const ListAddIcon = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
    <path d="M2.5 4h7M2.5 8h5M2.5 12h4M12 8.5v5M9.5 11h5" />
  </svg>
);

/**
 * Asks before adding an HTML file of the session folder to the list the floating tools' browser button shows,
 * which every session in the folder shares.
 */
export function AddToBrowserDialog({ tool, id, path, name, onClose }: { tool: ToolId; id: string; path: string; name: string; onClose: () => void }) {
  const [state, setState] = useState<"checking" | "ready" | "already" | "saving" | "added" | "failed">("checking");
  const confirm = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  /** Paths as stored use forward slashes. */
  const file = path.replace(/\\/g, "/");

  useEffect(() => {
    let live = true;
    api
      .previewPicks(tool, id)
      .then((view) => live && setState(view.picks?.files.includes(file) ? "already" : "ready"))
      .catch(() => live && setState("ready"));
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      live = false;
      window.removeEventListener("keydown", onKey);
    };
  }, [tool, id, file]);

  useEffect(() => {
    if (state === "ready") confirm.current?.focus();
  }, [state]);

  const add = async () => {
    setState("saving");
    try {
      // Read again right before saving, so files or services added meanwhile are kept.
      const view = await api.previewPicks(tool, id);
      const files = view.picks?.files ?? [];
      if (!files.includes(file)) await api.savePreviewPicks(tool, id, { files: [...files, file], ports: view.picks?.ports ?? [] });
      setState("added");
      window.setTimeout(() => closeRef.current(), 900);
    } catch {
      setState("failed");
    }
  };

  // Rendered at the top of the page: the file browser panel animates in, and a transform there would trap it.
  return createPortal(
    <div
      className="modal-backdrop add-browser-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="add-browser" role="dialog" aria-modal="true" aria-labelledby="add-browser-title">
        <h2 id="add-browser-title">加入浏览器列表</h2>
        <p>
          把 <strong title={file}>{name}</strong> 加到悬浮操作里“浏览器”的文件列表。以后点浏览器图标，就能直接在新标签页打开它。
        </p>
        <p className="add-browser-note">列表按项目文件夹保存，这个文件夹下的会话共用。</p>
        {state === "already" && <p className="add-browser-status">它已经在列表里了。</p>}
        {state === "added" && <p className="add-browser-status is-ok">已加入。</p>}
        {state === "failed" && <p className="add-browser-status is-bad">没有加入。确认 MirrorMix 还在运行后再试。</p>}
        <div className="add-browser-actions">
          <button type="button" className="quiet-button" onClick={onClose}>
            {state === "already" || state === "added" ? "关闭" : "取消"}
          </button>
          {state !== "already" && state !== "added" && (
            <button
              type="button"
              className="quiet-button is-primary"
              ref={confirm}
              disabled={state === "checking" || state === "saving"}
              onClick={() => void add()}
            >
              {(state === "checking" || state === "saving") && <Spinner />}
              加入
            </button>
          )}
        </div>
      </section>
    </div>,
    document.body,
  );
}
