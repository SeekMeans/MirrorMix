import { api, liveUrl, type SessionWindow, type ToolId } from "./api";

export type FeedLink = "connecting" | "live" | "polling" | "reconnecting";

/** HTTP keeps the desk usable when a browser or proxy cannot maintain its WebSocket. */
export function watchSession(tool: ToolId, id: string, frame: (value: SessionWindow) => void, link: (value: FeedLink) => void): () => void {
  let stopped = false;
  let socket: WebSocket | null = null;
  let retry = 0;
  let poll = 0;
  let reading = false;
  let attempts = 0;
  let hasLiveFrame = false;
  let hasSnapshot = false;
  const refresh = async () => {
    if (stopped || reading || hasLiveFrame) return;
    reading = true;
    try {
      const value = await api.latest(tool, id);
      if (!stopped && !hasLiveFrame) {
        frame(value);
        hasSnapshot = true;
        link("polling");
      }
    } catch {
      // A 401 returns to Login through the API client; network failures are retried.
    } finally { reading = false; }
  };
  const startPolling = () => {
    void refresh();
    if (!poll) poll = window.setInterval(() => { if (!document.hidden) void refresh(); }, 2000);
  };
  const reconnect = () => {
    if (stopped) return;
    hasLiveFrame = false;
    link(hasSnapshot ? "polling" : "reconnecting");
    startPolling();
    retry = window.setTimeout(connect, Math.min(30000, 400 * 2 ** Math.min(attempts++, 7)));
  };
  const connect = () => {
    try { socket = new WebSocket(liveUrl("live", tool, id)); }
    catch { reconnect(); return; }
    socket.onmessage = (event) => {
      if (stopped) return;
      let value: SessionWindow;
      try { value = JSON.parse(String(event.data)) as SessionWindow; } catch { return; }
      hasLiveFrame = true;
      hasSnapshot = true;
      attempts = 0;
      window.clearInterval(poll);
      poll = 0;
      frame(value);
      link("live");
    };
    socket.onclose = reconnect;
  };
  startPolling();
  connect();
  return () => {
    stopped = true;
    window.clearTimeout(retry);
    window.clearInterval(poll);
    socket?.close();
  };
}
