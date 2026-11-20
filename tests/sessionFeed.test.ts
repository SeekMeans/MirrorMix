import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type SessionWindow } from "../client/src/api";
import { watchSession } from "../client/src/sessionFeed";

class Socket {
  static instances: Socket[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) { Socket.instances.push(this); }
  close() { this.onclose?.(); }
  snapshot(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
}
const snapshot: SessionWindow = {
  id: "thread", tool: "codex", title: "chat", workspacePath: "C:\\work", status: "running", sendEnabled: true,
  attached: "process", messages: [], total: 0, offset: 0,
};
let stop: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  Socket.instances = [];
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("location", { protocol: "http:", host: "127.0.0.1:4789" });
  vi.stubGlobal("document", { hidden: false });
  vi.stubGlobal("window", { setInterval, clearInterval, setTimeout, clearTimeout });
  vi.spyOn(api, "latest").mockResolvedValue(snapshot);
});
afterEach(() => {
  stop?.(); stop = undefined;
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

describe("session transport", () => {
  it("loads a usable snapshot and keeps polling when WebSocket repeatedly disconnects", async () => {
    const frame = vi.fn(), link = vi.fn();
    stop = watchSession("codex", "thread", frame, link);
    await vi.advanceTimersByTimeAsync(0);
    expect(frame).toHaveBeenCalledWith(snapshot);
    expect(link).toHaveBeenLastCalledWith("polling");
    Socket.instances[0].close();
    await vi.advanceTimersByTimeAsync(2000);
    expect(api.latest).toHaveBeenCalledTimes(3);
    expect(link).toHaveBeenLastCalledWith("polling");
    expect(Socket.instances.length).toBe(2);
  });

  it("stops polling on a live frame and restarts it after disconnection", async () => {
    const frame = vi.fn(), link = vi.fn();
    stop = watchSession("codex", "thread", frame, link);
    await vi.advanceTimersByTimeAsync(0);
    Socket.instances[0].snapshot(snapshot);
    await vi.advanceTimersByTimeAsync(5000);
    expect(api.latest).toHaveBeenCalledTimes(1);
    expect(link).toHaveBeenLastCalledWith("live");
    Socket.instances[0].close();
    await vi.advanceTimersByTimeAsync(2000);
    expect(api.latest).toHaveBeenCalledTimes(3);
    expect(link).toHaveBeenLastCalledWith("polling");
  });

  it("does not let a late HTTP result overwrite a live frame", async () => {
    let resolve!: (value: SessionWindow) => void;
    vi.mocked(api.latest).mockImplementation(() => new Promise((done) => { resolve = done; }));
    const frame = vi.fn();
    stop = watchSession("codex", "thread", frame, vi.fn());
    const live = { ...snapshot, title: "newer live result" };
    Socket.instances[0].snapshot(live);
    resolve(snapshot);
    await vi.advanceTimersByTimeAsync(0);
    expect(frame.mock.calls).toEqual([[live]]);
  });

  it("keeps polling after malformed socket data and cancels all activity on disposal", async () => {
    const frame = vi.fn();
    stop = watchSession("codex", "thread", frame, vi.fn());
    Socket.instances[0].onmessage?.({ data: "not JSON" });
    await vi.advanceTimersByTimeAsync(2000);
    expect(api.latest).toHaveBeenCalledTimes(2);
    stop();
    frame.mockClear();
    Socket.instances[0].snapshot(snapshot);
    await vi.advanceTimersByTimeAsync(10000);
    expect(frame).not.toHaveBeenCalled();
    expect(api.latest).toHaveBeenCalledTimes(2);
  });
});
