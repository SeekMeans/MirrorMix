import { readFileSync } from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { WebSocketServer } from "ws";
import type { SshHostInput } from "../shared/ssh";
import { HostKeyError } from "./connect";
import type { SshManager } from "./manager";
import { SshError, type SshStore } from "./store";

function send(response: http.ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function body<T = Record<string, unknown>>(request: http.IncomingMessage, maxBytes = 256_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        request.destroy();
        reject(new SshError("too_large", 413));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve((chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}) as T);
      } catch {
        reject(new SshError("bad_request"));
      }
    });
    request.on("error", () => reject(new SshError("bad_request")));
  });
}

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** Handles /api/ssh/*. Returns false for paths it does not know. The caller has already checked the sign-in. */
export async function handleSshRequest(
  ssh: { manager: SshManager; store: SshStore },
  request: http.IncomingMessage,
  response: http.ServerResponse,
  url: URL,
): Promise<boolean> {
  if (!url.pathname.startsWith("/api/ssh/")) return false;
  const { manager, store } = ssh;
  const route = url.pathname.slice("/api/ssh/".length);
  const method = request.method ?? "GET";
  const query = (name: string) => url.searchParams.get(name) ?? "";
  try {
    if (route === "state" && method === "GET") return send(response, 200, manager.state()), true;

    // groups
    if (route === "groups" && method === "POST") return send(response, 200, store.saveGroup(await body(request))), true;
    if (route === "groups" && method === "DELETE") return store.deleteGroup(query("id")), send(response, 200, { ok: true }), true;

    // hosts
    if (route === "hosts" && method === "POST") return send(response, 200, store.saveHost(await body<SshHostInput>(request))), true;
    if (route === "hosts/duplicate" && method === "POST") return send(response, 200, store.duplicateHost(text((await body(request)).id))), true;
    if (route === "hosts" && method === "DELETE") {
      manager.forgetHost(query("id"));
      store.deleteHost(query("id"));
      return send(response, 200, { ok: true }), true;
    }
    if (route === "hosts/test" && method === "POST") {
      await manager.test(text((await body(request)).id));
      return send(response, 200, { ok: true }), true;
    }
    if (route === "import-config" && method === "POST") {
      const file = path.join(os.homedir(), ".ssh", "config");
      let config: string;
      try {
        config = readFileSync(file, "utf8");
      } catch {
        throw new SshError("no_ssh_config", 404);
      }
      return send(response, 200, store.importConfig(config, os.homedir())), true;
    }

    // keychain
    if (route === "keys/import" && method === "POST") return send(response, 200, store.importKey(await body(request, 64_000))), true;
    if (route === "keys/generate" && method === "POST") return send(response, 200, store.generateKey(await body(request))), true;
    if (route === "keys/rename" && method === "POST") {
      const input = await body(request);
      return send(response, 200, store.renameKey(text(input.id), input.label)), true;
    }
    if (route === "keys" && method === "DELETE") return store.deleteKey(query("id")), send(response, 200, { ok: true }), true;
    if (route === "keys/private" && method === "GET") {
      // Only when the person asks to export it; downloaded as a file, never shown in the page.
      const key = store.state().keys.find((item) => item.id === query("id"));
      if (!key) throw new SshError("unknown_key", 404);
      const name = `${key.label.replace(/[^\w.-]+/g, "_") || "id"}`;
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="${name}"`,
        "cache-control": "no-store",
      });
      response.end(store.exportPrivateKey(key.id));
      return true;
    }
    if (route === "identities" && method === "POST") return send(response, 200, store.saveIdentity(await body(request))), true;
    if (route === "identities" && method === "DELETE") return store.deleteIdentity(query("id")), send(response, 200, { ok: true }), true;

    // snippets
    if (route === "snippets" && method === "POST") return send(response, 200, store.saveSnippet(await body(request))), true;
    if (route === "snippets" && method === "DELETE") return store.deleteSnippet(query("id")), send(response, 200, { ok: true }), true;

    // port forwarding
    if (route === "forwards" && method === "POST") return send(response, 200, store.saveForward(await body(request))), true;
    if (route === "forwards" && method === "DELETE") {
      manager.stopForward(query("id"));
      store.deleteForward(query("id"));
      return send(response, 200, { ok: true }), true;
    }
    if (route === "forwards/start" && method === "POST") return send(response, 200, await manager.startForward(text((await body(request)).id))), true;
    if (route === "forwards/stop" && method === "POST") return send(response, 200, manager.stopForward(text((await body(request)).id))), true;

    // known hosts
    if (route === "known" && method === "POST") {
      const input = await body(request);
      const address = text(input.address);
      const fingerprint = text(input.fingerprint);
      if (!address || !/^SHA256:[A-Za-z0-9+/]+$/.test(fingerprint)) throw new SshError("bad_request");
      store.trustHostKey(address, text(input.keyType) || "unknown", fingerprint);
      return send(response, 200, { ok: true }), true;
    }
    if (route === "known" && method === "DELETE") return store.forgetHostKey(query("address")), send(response, 200, { ok: true }), true;

    // terminal sessions
    if (route === "sessions" && method === "POST") return send(response, 200, await manager.openSession(text((await body(request)).hostId))), true;
    if (route === "sessions" && method === "DELETE") return manager.closeSession(query("tid")), send(response, 200, { ok: true }), true;
    if (route === "sessions/snippet" && method === "POST") {
      const input = await body(request);
      manager.runSnippet(text(input.tid), text(input.snippetId));
      return send(response, 200, { ok: true }), true;
    }

    // SFTP
    if (route === "sftp/home" && method === "GET") return send(response, 200, { path: await manager.sftp.home(query("host")) }), true;
    if (route === "sftp/list" && method === "GET") return send(response, 200, await manager.sftp.list(query("host"), query("path") || ".")), true;
    if (route === "sftp/download" && method === "GET") {
      const file = query("path");
      const { stream, size } = await manager.sftp.read(query("host"), file);
      const name = path.posix.basename(file) || "download";
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(size),
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        "cache-control": "no-store",
      });
      await pipeline(stream, response).catch(() => response.destroy());
      return true;
    }
    if (route === "sftp/upload" && method === "PUT") {
      const target = await manager.sftp.write(query("host"), query("path"));
      await pipeline(request, target);
      return send(response, 200, { ok: true }), true;
    }
    if (route === "sftp/mkdir" && method === "POST") {
      const input = await body(request);
      await manager.sftp.mkdir(text(input.host), text(input.path));
      return send(response, 200, { ok: true }), true;
    }
    if (route === "sftp/rename" && method === "POST") {
      const input = await body(request);
      await manager.sftp.rename(text(input.host), text(input.from), text(input.to));
      return send(response, 200, { ok: true }), true;
    }
    if (route === "sftp/remove" && method === "POST") {
      const input = await body(request);
      await manager.sftp.remove(text(input.host), text(input.path));
      return send(response, 200, { ok: true }), true;
    }
    if (route === "sftp/chmod" && method === "POST") {
      const input = await body(request);
      const mode = parseInt(text(input.mode), 8);
      if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) throw new SshError("bad_mode");
      await manager.sftp.chmod(text(input.host), text(input.path), mode);
      return send(response, 200, { ok: true }), true;
    }
    send(response, 404, { error: "not_found" });
    return true;
  } catch (error) {
    if (response.headersSent) {
      response.destroy();
      return true;
    }
    if (error instanceof HostKeyError) return send(response, error.status, { error: error.code, question: error.question }), true;
    if (error instanceof SshError) return send(response, error.status, { error: error.code }), true;
    console.warn(`[ssh] ${route}: ${error instanceof Error ? error.message : error}`);
    send(response, 500, { error: "failed" });
    return true;
  }
}

const sockets = new WebSocketServer({ noServer: true });

/** /api/ssh/term?tid=…: the screen of one SSH shell. The caller has checked origin and sign-in. */
export function handleSshUpgrade(
  manager: SshManager,
  url: URL,
  request: http.IncomingMessage,
  socket: import("node:stream").Duplex,
  head: Buffer,
) {
  const tid = url.searchParams.get("tid") ?? "";
  sockets.handleUpgrade(request, socket, head, (client) => {
    const link = manager.attach(tid, {
      send(data) {
        if (client.readyState === client.OPEN) client.send(data);
      },
      close() {
        client.close(4000, "exited");
      },
    });
    if (!link) {
      client.close(4404, "unknown_session");
      return;
    }
    client.on("message", (data) => {
      const message = String(data);
      if (message.startsWith("{")) {
        try {
          const parsed = JSON.parse(message) as { type?: string; cols?: number; rows?: number };
          if (parsed.type === "resize" && Number.isInteger(parsed.cols) && Number.isInteger(parsed.rows)) {
            link.resize(Math.max(10, Math.min(500, parsed.cols!)), Math.max(4, Math.min(300, parsed.rows!)));
            return;
          }
        } catch {
          /* typed text that starts with a brace */
        }
      }
      link.write(message);
    });
    client.on("close", () => link.detach());
  });
}
