import i18n from "i18next";
import { useSyncExternalStore } from "react";
import { initReactI18next } from "react-i18next";
import en from "./resources/en";
import zhCN from "./resources/zh-CN";

export type UiLanguage = "zh-CN" | "en";

/** Uses the browser only until the person chooses a language in Settings. */
export function browserLanguage(value = typeof navigator === "undefined" ? "" : navigator.language): UiLanguage {
  return value.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

export function resolveLanguage(saved: UiLanguage | undefined, detected: UiLanguage): UiLanguage {
  return saved ?? detected;
}

/** i18next may expose a regional match such as en-US; the UI has only two choices. */
export function activeLanguage(value: string | undefined): UiLanguage {
  return value?.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, "zh-CN": { translation: zhCN } },
  lng: browserLanguage(),
  fallbackLng: "en",
  supportedLngs: ["zh-CN", "en"],
  returnNull: false,
  interpolation: { escapeValue: false },
});

export async function setLanguage(language: UiLanguage): Promise<void> {
  await i18n.changeLanguage(language);
  if (typeof document !== "undefined") document.documentElement.lang = language;
}

/** The language the interface is in right now. */
export const currentLanguage = (): UiLanguage => activeLanguage(i18n.resolvedLanguage ?? i18n.language);

/**
 * Fixed interface copy, written in both languages where it is used: `tr("退出登录", "Sign out")`. Read at render time,
 * so a component shows the new language as soon as it renders again (see `useLanguage`).
 */
export function tr(zh: string, en: string): string {
  return currentLanguage() === "en" ? en : zh;
}

/** The locale for dates and numbers in the interface language. */
export const uiLocale = (): string => (currentLanguage() === "en" ? "en-US" : "zh-CN");

const subscribe = (changed: () => void) => {
  i18n.on("languageChanged", changed);
  return () => i18n.off("languageChanged", changed);
};

/** Renders the calling component again when the language changes, memoized ones included. */
export function useLanguage(): UiLanguage {
  return useSyncExternalStore(subscribe, currentLanguage, currentLanguage);
}

export { i18n };
