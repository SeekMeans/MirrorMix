import i18n, { type i18n as I18n } from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./resources/en";
import zhCN from "./resources/zh-CN";

export type UiLanguage = "zh-CN" | "en";

/** Uses the browser only until the person chooses a language in Settings. */
export function browserLanguage(value = typeof navigator === "undefined" ? "" : navigator.language): UiLanguage {
  return value.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, "zh-CN": { translation: zhCN } },
  lng: browserLanguage(),
  fallbackLng: "en",
  supportedLngs: ["zh-CN", "en"],
  returnNull: false,
  interpolation: { escapeValue: false },
});

export async function setLanguage(language: UiLanguage): Promise<I18n> {
  return i18n.changeLanguage(language);
}

export { i18n };
