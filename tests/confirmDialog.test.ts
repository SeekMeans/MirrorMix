import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";

let ConfirmDialog: typeof import("../client/src/ConfirmDialog").ConfirmDialog;

beforeAll(async () => {
  Object.assign(globalThis, { self: globalThis });
  ({ ConfirmDialog } = await import("../client/src/ConfirmDialog"));
});

const render = (props: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(
      ConfirmDialog,
      { title: "恢复默认设置？", confirmLabel: "恢复默认", busyLabel: "正在恢复", danger: true, onConfirm: () => undefined, onCancel: () => undefined, ...props },
      createElement("p", null, "外网访问会立即断开"),
    ),
  );

describe("in-page confirmation", () => {
  it("is an alert dialog with cancel first and the dangerous action marked", () => {
    const html = render();
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toMatch(/aria-labelledby="[^"]+"/);
    expect(html).toContain("外网访问会立即断开");
    expect(html.indexOf(">取消<")).toBeLessThan(html.indexOf(">恢复默认<"));
    expect(html).toContain("quiet-button is-danger");
  });

  it("shows progress and the reason it failed, and cannot be dismissed while working", () => {
    const busy = render({ busy: true });
    expect(busy).toContain("正在恢复");
    expect(busy.match(/disabled=""/g)).toHaveLength(2);
    expect(render({ error: "没有恢复成默认，请再试一次。" })).toContain('role="alert"');
  });

  it("replaces the browser's own confirm box for restoring the defaults", () => {
    const source = readFileSync(path.join(process.cwd(), "client", "src", "Settings.tsx"), "utf8");
    expect(source).not.toContain("window.confirm");
    expect(source).toContain("<ConfirmDialog");
  });
});
