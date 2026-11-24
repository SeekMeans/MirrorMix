import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const conversation = readFileSync(path.join(process.cwd(), "client", "src", "Conversation.tsx"), "utf8");
const app = readFileSync(path.join(process.cwd(), "client", "src", "App.tsx"), "utf8");

describe("Cursor composer delivery", () => {
  // Clearing on Send now applies to every tool, Cursor included; clearOnSend is still accepted from the page.
  it("clears the draft before waiting for the desktop app, and restores it when delivery fails", () => {
    expect(conversation).toContain("clearOnSend?: boolean;");
    const submit = conversation.slice(conversation.indexOf("const submit = async () => {"));
    const cleared = submit.indexOf('change("");');
    const awaited = submit.indexOf("await onSend(message)");
    expect(cleared).toBeGreaterThan(-1);
    expect(awaited).toBeGreaterThan(cleared);
    expect(submit).toContain("change(text);");
    expect(app).toContain('clearOnSend={target.tool === "cursor"}');
  });

  it("shows Cursor's response placeholder while a delivery or reply is in progress", () => {
    expect(conversation).toContain("respondingPlaceholder?: string;");
    expect(conversation).toContain("placeholder={(sending || busy) && respondingPlaceholder ? respondingPlaceholder : placeholder}");
    expect(app).toContain('respondingPlaceholder={target.tool === "cursor" ? tr("消息响应中", "Replying") : undefined}');
  });
});
