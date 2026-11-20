import { useCallback, useState } from "react";

/** How the page looks: follow the system, or always light or dark. Kept per browser, so a phone and a computer can differ. */
export type Theme = "system" | "light" | "dark";

export const THEME_KEY = "mirrormix.theme";

export const THEME_LABEL: Record<Theme, string> = {
  system: "跟随系统",
  light: "浅色",
  dark: "深色",
};

/** The browser bar's colour on a phone: the list's background in each look. */
const BAR_COLOR = { light: "#e4ebee", dark: "#13171e" };

export function readTheme(): Theme {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    return saved === "light" || saved === "dark" ? saved : "system";
  } catch {
    return "system";
  }
}

/** Sets `data-theme` on <html>, which the stylesheet's colours follow. "system" removes it. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const own = meta.media.includes("dark") ? BAR_COLOR.dark : BAR_COLOR.light;
    meta.content = theme === "system" ? own : BAR_COLOR[theme];
  }
}

export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setTheme] = useState(readTheme);
  const choose = useCallback((next: Theme) => {
    setTheme(next);
    applyTheme(next);
    try {
      if (next === "system") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, next);
    } catch {
      /* private mode: the choice lasts for this visit */
    }
  }, []);
  return [theme, choose];
}
