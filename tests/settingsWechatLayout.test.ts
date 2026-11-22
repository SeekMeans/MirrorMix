import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const styles = readFileSync(fileURLToPath(new URL("../client/src/styles.css", import.meta.url)), "utf8");

describe("mobile settings menu layout", () => {
  it("uses the workbench page background for the settings header", () => {
    expect(styles).toMatch(/\.settings-page \.settings-head \{\r?\n  padding: calc\(16px \+ env\(safe-area-inset-top\)\) 18px 14px;\r?\n  background: var\(--page\);/);
  });

  it("uses full-width menu groups separated by the page background", () => {
    expect(styles).toContain(".is-mobile .settings-page:not(.is-sub) > .settings-body { display: grid; align-content: start; gap: 14px; padding-left: 0; padding-right: 0; }");
    expect(styles).toContain(".is-mobile .settings-page:not(.is-sub) > .settings-body > .pref-group { border: 0; border-radius: 0; }");
    expect(styles).toMatch(/\.is-mobile \.settings-page:not\(\.is-sub\) > \.settings-body > \.me-card \{\r?\n  margin: calc\(-12px - env\(safe-area-inset-top\)\) 0 0;/);
  });
});
