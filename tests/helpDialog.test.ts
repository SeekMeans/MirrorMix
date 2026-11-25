import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { setLanguage } from "../client/src/i18n";

let HelpDialog: typeof import("../client/src/HelpDialog").HelpDialog;

beforeAll(async () => {
  Object.assign(globalThis, { self: globalThis });
  ({ HelpDialog } = await import("../client/src/HelpDialog"));
  await setLanguage("en");
});

const renderHelp = (variant: "dialog" | "page") => renderToStaticMarkup(
  createElement(HelpDialog, { variant, onClose: () => undefined }),
);

describe("help dialog", () => {
  it("uses the settings dialog shell and lists the two support sections", () => {
    const html = renderHelp("dialog");
    expect(html).toContain('class="modal-backdrop"');
    expect(html).toContain('class="settings" role="dialog" aria-modal="true"');
    expect(html).toContain("Security information</button>");
    expect(html).toContain("Problem feedback</button>");
  });

  it("shows the same two sections as entries on a phone", () => {
    const html = renderHelp("page");
    expect(html).toContain('class="settings-page"');
    expect(html).toContain("Security information");
    expect(html).toContain("Problem feedback");
  });
});
