import type { Supervisor } from "../process/supervisor";
import type { TranscriptMessage } from "../shared/types";
import type { AiRequest } from "./engine";

const squash = (value: string) => value.replace(/\s+/g, "").toLowerCase();

/**
 * The reply to `prompt` once it has finished, or null while it is still coming. The prompt's own message is found
 * by its words (a tool may add a little around it); everything after it is the reply. It is done when it has
 * text, no round is still open, and the session is not marked working.
 */
export function replyAfter(messages: TranscriptMessage[], prompt: string, working: boolean): string | null {
  const key = squash(prompt).slice(0, 80);
  let at = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user" && squash(message.text).includes(key)) {
      at = index;
      break;
    }
  }
  if (at < 0) return null;
  const after = messages.slice(at + 1);
  if (after.some((message) => message.role === "turn" && !message.endedAt)) return null;
  const said = after.filter((message) => message.role === "assistant" && message.text.trim());
  if (!said.length || working) return null;
  return said[said.length - 1].text.trim();
}

/** How a workflow's AI step talks to a session: the same way the page sends a message, then it watches the reply. */
export function supervisorAi(supervisor: Supervisor, options: { pollMs?: number; settleMs?: number } = {}) {
  const pollMs = options.pollMs ?? 1_500;
  // A reply can pause between tool calls; it counts as finished once it has stayed the same this long.
  const settleMs = options.settleMs ?? 4_000;
  return async (request: AiRequest): Promise<{ output: string; sessionId: string }> => {
    const { tool, prompt, signal } = request;
    let id: string;
    if (request.sessionId) {
      id = request.sessionId;
      try {
        supervisor.open(tool, id);
      } catch {
        /* a session that cannot be held open here may still take a message */
      }
    } else {
      id = (await supervisor.create(tool, request.workspace)).id;
    }
    request.onSession(id);
    await supervisor.send(tool, id, prompt);

    const started = Date.now();
    let last = "";
    let sameSince = Date.now();
    for (;;) {
      if (signal.aborted) {
        await supervisor.interrupt(tool, id).catch(() => undefined);
        throw new Error("已停止");
      }
      if (Date.now() - started > request.timeoutMs) throw new Error("等待回复超时");
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      let view;
      try {
        view = supervisor.getSession(tool, id);
      } catch {
        continue;
      }
      // A new session's stand-in name moves over to its real id once the tool has written its file.
      if (view.id !== id) {
        id = view.id;
        request.onSession(id);
      }
      const working = supervisor
        .catalog()
        [tool].some((group) => group.sessions.some((session) => session.id === id && session.working));
      const reply = replyAfter(view.messages, prompt, working);
      const shape = `${view.messages.length}:${reply ?? ""}`;
      if (shape !== last) {
        last = shape;
        sameSince = Date.now();
      }
      if (reply !== null && Date.now() - sameSince >= settleMs) return { output: reply, sessionId: id };
    }
  };
}
