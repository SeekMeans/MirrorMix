import { describe, expect, it, vi } from "vitest";
import { createScreenMirror } from "../src/transcript/mirror";

describe("interactive terminal protocol", () => {
  it("answers cursor position requests so an unattended TUI can finish initializing", async () => {
    const mirror = createScreenMirror();
    const reply = vi.fn();
    mirror.replyWith(reply);
    mirror.write("\u001b[6n");
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith("\u001b[1;1R"));
  });
  it("exposes a blocked startup prompt and clears it after the regular composer returns", async () => {
    const mirror = createScreenMirror();
    mirror.write("Trust this folder?\r\n❯ 1. Yes\r\n  2. No");
    await vi.waitFor(() => expect(mirror.allowsInput()).toBe(false));
    expect(mirror.prompt()).toContain("Trust this folder?");
    mirror.write("\r\n❯ ");
    await vi.waitFor(() => expect(mirror.allowsInput()).toBe(true));
  });
});
