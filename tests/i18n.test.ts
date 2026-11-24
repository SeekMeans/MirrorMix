import { describe, expect, it } from "vitest";
import { browserLanguage, resolveLanguage } from "../client/src/i18n";

describe("interface language", () => {
  it("uses Chinese for every zh browser locale", () => {
    expect(browserLanguage("zh-CN")).toBe("zh-CN");
    expect(browserLanguage("zh-TW")).toBe("zh-CN");
  });

  it("uses English for missing and non-Chinese locales", () => {
    expect(browserLanguage("")).toBe("en");
    expect(browserLanguage("en-IN")).toBe("en");
  });

  it("prefers an explicit setting over the browser locale", () => {
    expect(resolveLanguage("en", "zh-CN")).toBe("en");
    expect(resolveLanguage(undefined, "zh-CN")).toBe("zh-CN");
  });
});
