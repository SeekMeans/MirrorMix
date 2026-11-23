import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { SearchIcon } from "./icons";

export interface SelectOption {
  value: string;
  label: string;
  /** A second, quieter line: an address, a path, the first line of a command. */
  hint?: string;
  /** Shown before the label: an avatar, a tool mark, a small badge. */
  icon?: ReactNode;
  /** Shown on the right of the row in the list only: tags, a count. */
  side?: ReactNode;
  /** More words the search box matches besides the label and hint. */
  keywords?: string;
  /** A heading the option sits under; options with the same group are kept together in the order given. */
  group?: string;
  disabled?: boolean;
}

/** Search appears once a list is longer than this. */
const SEARCH_FROM = 8;
const GAP = 6;
const PHONE = "(max-width: 640px)";

/**
 * MirrorMix's dropdown, in place of the browser's own: the trigger reads like the chosen option (icon, label, and
 * with `rich` its hint), the list shows what each choice is, long lists get a search box, and on a phone the list
 * comes up from the bottom of the screen. Keyboard: arrows, Home/End, Enter, Escape.
 */
export function Select({
  value,
  options,
  onChange,
  placeholder = "请选择",
  ariaLabel,
  rich = false,
  searchHint = "搜索",
  empty = "没有可选的项",
  className = "",
  disabled = false,
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  /** A taller trigger that also shows the chosen option's hint. */
  rich?: boolean;
  searchHint?: string;
  /** What the list says when there is nothing to choose. */
  empty?: string;
  className?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<{ left: number; top?: number; bottom?: number; width: number; maxHeight: number; sheet: boolean } | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const pop = useRef<HTMLDivElement | null>(null);
  const search = useRef<HTMLInputElement | null>(null);
  const listId = useId();
  const chosen = options.find((option) => option.value === value);
  const searchable = options.length > SEARCH_FROM;
  const needle = query.trim().toLowerCase();
  const shown = useMemo(
    () =>
      needle
        ? options.filter((option) => [option.label, option.hint ?? "", option.keywords ?? "", option.group ?? ""].some((text) => text.toLowerCase().includes(needle)))
        : options,
    [options, needle],
  );

  const measure = useCallback(() => {
    const box = trigger.current?.getBoundingClientRect();
    if (!box) return;
    if (window.matchMedia(PHONE).matches) {
      setPlace({ left: 0, bottom: 0, width: window.innerWidth, maxHeight: Math.round(window.innerHeight * 0.7), sheet: true });
      return;
    }
    const width = Math.max(box.width, 240);
    const left = Math.min(box.left, window.innerWidth - width - 8);
    const below = window.innerHeight - box.bottom - GAP - 8;
    const above = box.top - GAP - 8;
    // Opens downward unless there is clearly more room above.
    if (below >= 220 || below >= above) setPlace({ left, top: box.bottom + GAP, width, maxHeight: Math.min(360, below), sheet: false });
    else setPlace({ left, bottom: window.innerHeight - box.top + GAP, width, maxHeight: Math.min(360, above), sheet: false });
  }, []);

  const show = () => {
    if (disabled) return;
    setQuery("");
    setActive(Math.max(0, options.findIndex((option) => option.value === value)));
    measure();
    setOpen(true);
  };
  const hide = (focusBack = true) => {
    setOpen(false);
    if (focusBack) trigger.current?.focus();
  };
  const pick = (option: SelectOption | undefined) => {
    if (!option || option.disabled) return;
    if (option.value !== value) onChange(option.value);
    hide();
  };

  useLayoutEffect(() => {
    if (!open) return;
    (searchable ? search.current : pop.current)?.focus({ preventScroll: true });
    pop.current?.querySelector(".is-chosen")?.scrollIntoView({ block: "nearest" });
  }, [open, searchable]);

  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!pop.current?.contains(target) && !trigger.current?.contains(target)) hide(false);
    };
    // Scrolling the page under an open list would leave it floating; scrolling the list itself is fine.
    const scrolled = (event: Event) => {
      if (!pop.current?.contains(event.target as Node)) hide(false);
    };
    const resized = () => measure();
    document.addEventListener("pointerdown", away, true);
    window.addEventListener("scroll", scrolled, true);
    window.addEventListener("resize", resized);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      window.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("resize", resized);
    };
  }, [open, measure]);

  // Keeps the highlighted row in view while moving with the keys.
  useEffect(() => {
    if (open) pop.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const move = (by: number) => {
    if (!shown.length) return;
    let next = active;
    for (let step = 0; step < shown.length; step += 1) {
      next = (next + by + shown.length) % shown.length;
      if (!shown[next].disabled) break;
    }
    setActive(next);
  };

  const onListKey = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") move(1);
    else if (event.key === "ArrowUp") move(-1);
    else if (event.key === "Home") setActive(0);
    else if (event.key === "End") setActive(shown.length - 1);
    else if (event.key === "Enter") pick(shown[active]);
    else if (event.key === "Escape") hide();
    else if (event.key === "Tab") hide(false);
    else return;
    event.preventDefault();
    // The dialog or drawer around the dropdown must not close with it.
    event.stopPropagation();
  };

  let lastGroup: string | undefined;
  const list = (
    <div
      ref={pop}
      className={`mm-select-pop${place?.sheet ? " is-sheet" : ""}`}
      style={place ? { left: place.left, top: place.top, bottom: place.bottom, width: place.width, maxHeight: place.sheet ? undefined : place.maxHeight } : undefined}
      tabIndex={-1}
      onKeyDown={onListKey}
    >
      {place?.sheet && (
        <div className="mm-select-sheet-head">
          <strong>{ariaLabel ?? placeholder}</strong>
          <button type="button" className="mm-select-sheet-done" onClick={() => hide()}>
            完成
          </button>
        </div>
      )}
      {searchable && (
        <label className="mm-select-search">
          <SearchIcon />
          <input
            ref={search}
            value={query}
            placeholder={searchHint}
            aria-controls={listId}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
          />
        </label>
      )}
      <ul id={listId} className="mm-select-list" role="listbox" aria-label={ariaLabel} style={place?.sheet ? { maxHeight: place.maxHeight } : undefined}>
        {shown.map((option, index) => {
          const heading = option.group && option.group !== lastGroup ? option.group : undefined;
          lastGroup = option.group;
          return (
            <li key={option.value} role="presentation">
              {heading && <span className="mm-select-group">{heading}</span>}
              <button
                type="button"
                role="option"
                aria-selected={option.value === value}
                disabled={option.disabled}
                data-index={index}
                className={`mm-select-option${index === active ? " is-active" : ""}${option.value === value ? " is-chosen" : ""}`}
                onPointerMove={() => index !== active && setActive(index)}
                onClick={() => pick(option)}
              >
                {option.icon && <span className="mm-select-icon">{option.icon}</span>}
                <span className="mm-select-text">
                  <span className="mm-select-label">{option.label}</span>
                  {option.hint && <span className="mm-select-hint">{option.hint}</span>}
                </span>
                {option.side && <span className="mm-select-side">{option.side}</span>}
                <span className="mm-select-tick" aria-hidden="true">
                  {option.value === value ? "✓" : ""}
                </span>
              </button>
            </li>
          );
        })}
        {shown.length === 0 && <li className="mm-select-none">{needle ? "没有匹配的结果" : empty}</li>}
      </ul>
    </div>
  );

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`mm-select${rich ? " is-rich" : ""}${open ? " is-open" : ""}${chosen ? "" : " is-empty"} ${className}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel ? `${ariaLabel}：${chosen?.label ?? placeholder}` : undefined}
        disabled={disabled}
        onClick={() => (open ? hide() : show())}
        onKeyDown={(event) => {
          if (open) return onListKey(event);
          if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            show();
          }
        }}
      >
        {chosen?.icon && <span className="mm-select-icon">{chosen.icon}</span>}
        <span className="mm-select-text">
          <span className="mm-select-label">{chosen?.label ?? placeholder}</span>
          {rich && chosen?.hint && <span className="mm-select-hint">{chosen.hint}</span>}
        </span>
        <svg className="mm-select-caret" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
          <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open &&
        createPortal(
          <>
            {place?.sheet && <div className="mm-select-scrim" onPointerDown={() => hide(false)} />}
            {list}
          </>,
          document.body,
        )}
    </>
  );
}
