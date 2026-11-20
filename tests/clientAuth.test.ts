import { afterEach, describe, expect, it, vi } from "vitest";
import { api, AUTH_EXPIRED } from "../client/src/api";

afterEach(() => vi.unstubAllGlobals());

describe("expired browser authentication", () => {
  it.each(["catalog", "settings", "page", "open", "saveSettings", "latest"] as const)("notifies the login gate when %s returns 401", async (method) => {
    const target = new EventTarget();
    const expired = vi.fn();
    target.addEventListener(AUTH_EXPIRED, expired);
    vi.stubGlobal("window", target);
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":"unauthenticated"}', { status: 401 })));
    const request = method === "page" ? api.page("codex", "id", 60, 60)
      : method === "latest" ? api.latest("codex", "id")
      : method === "open" ? api.open("codex", "id")
      : method === "saveSettings" ? api.saveSettings({ tools: ["codex"] }) : api[method]();
    await expect(request).rejects.toBeInstanceOf(Error);
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it("preserves other server errors without logging the user out", async () => {
    const target = new EventTarget();
    const expired = vi.fn();
    target.addEventListener(AUTH_EXPIRED, expired);
    vi.stubGlobal("window", target);
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":"tool_offline"}', { status: 409 })));
    await expect(api.open("codex", "id")).rejects.toMatchObject({ code: "tool_offline", status: 409 });
    expect(expired).not.toHaveBeenCalled();
  });
});
