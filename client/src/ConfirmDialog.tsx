import { useEffect, useId, useRef, type ReactNode } from "react";
import { Spinner } from "./icons";
import { tr } from "./i18n";

/**
 * Asks before doing something that cannot be taken back, in the page instead of the browser's own confirm box.
 * Cancel has the focus when it opens, so a stray Enter does nothing. Escape closes this dialog only, not a dialog
 * underneath (Settings), and the focus goes back to what had it before.
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  busyLabel,
  danger = false,
  busy = false,
  error = "",
  onConfirm,
  onCancel,
}: {
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  /** Shown on the confirm button while the action runs; the dialog stays open until it is done. */
  busyLabel?: string;
  danger?: boolean;
  busy?: boolean;
  /** Why it did not work, shown in the dialog so it can be tried again. */
  error?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const bodyId = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLElement>(null);

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    cancel.current?.focus();
    return () => before?.focus?.();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        if (!busy) onCancel();
        return;
      }
      // Keep Tab inside the dialog.
      if (event.key === "Tab" && card.current) {
        const items = Array.from(card.current.querySelectorAll<HTMLElement>("button:not(:disabled)"));
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [busy, onCancel]);

  return (
    <div
      className="confirm-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <section ref={card} className="confirm-card" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={children ? bodyId : undefined}>
        <h3 id={titleId}>{title}</h3>
        {children && (
          <div id={bodyId} className="confirm-body">
            {children}
          </div>
        )}
        {error && (
          <p className="confirm-error" role="alert">
            {error}
          </p>
        )}
        <div className="confirm-actions">
          <button ref={cancel} type="button" className="quiet-button" disabled={busy} onClick={onCancel}>
            {tr("取消", "Cancel")}
          </button>
          <button type="button" className={`quiet-button ${danger ? "is-danger" : "is-primary"}`} disabled={busy} onClick={onConfirm}>
            {busy && <Spinner />}
            {busy && busyLabel ? busyLabel : confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}
