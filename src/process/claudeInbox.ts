import net from "node:net";

export interface ClaudeInbox {
  pipe: string;
  token: string;
}

export function claudeInboxFrames(token: string, text: string): string {
  return `${JSON.stringify({ type: "auth", token })}\n${JSON.stringify({
    type: "user",
    message: { role: "user", content: text },
  })}\n`;
}

export function isClaudePipe(pipe: string): boolean {
  return /^\\\\\.[\\/]pipe[\\/][^<>:"|?*\r\n]+$/.test(pipe) && !pipe.includes("..");
}

export function injectClaudeInbox(inbox: ClaudeInbox, text: string): Promise<void> {
  if (!isClaudePipe(inbox.pipe) || !inbox.token) return Promise.reject(new Error("inbox_unavailable"));
  return new Promise((resolve, reject) => {
    const socket = net.connect(inbox.pipe);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("inbox_timeout"));
    }, 4000);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      socket.removeAllListeners();
      if (error) {
        socket.destroy();
        reject(error);
        return;
      }
      socket.end();
      resolve();
    };
    socket.on("error", (error) => finish(error));
    socket.on("connect", () => {
      socket.write(claudeInboxFrames(inbox.token, text), (error) => finish(error ?? undefined));
    });
  });
}
