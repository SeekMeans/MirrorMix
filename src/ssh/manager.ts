import net from "node:net";
import path from "node:path/posix";
import type { Readable, Writable } from "node:stream";
import type { Client, ClientChannel, SFTPWrapper } from "ssh2";
import type { SftpEntry, SshForwardState, SshSessionInfo } from "../shared/ssh";
import { createTerminalHub, type ShellProcess, type TerminalSink } from "../server/terminals";
import { SshError, type SshStore, type SshTarget } from "./store";

export type Connect = (target: SshTarget) => Promise<Client>;

const SFTP_IDLE_MS = 5 * 60_000;

/** One SSH shell, shaped like a local command line so the terminal hub can keep it alive for the page. */
function shellProcess(client: Client, stream: ClientChannel, backspace: "del" | "bs"): ShellProcess {
  const exits: Array<() => void> = [];
  let gone = false;
  const end = () => {
    if (gone) return;
    gone = true;
    try {
      client.end();
    } catch {
      /* already closed */
    }
    for (const exit of exits) exit();
  };
  stream.on("close", end);
  client.on("close", end);
  return {
    write(data) {
      stream.write(backspace === "bs" ? data.replace(/\x7f/g, "\b") : data);
    },
    resize(cols, rows) {
      stream.setWindow(rows, cols, 0, 0);
    },
    kill() {
      try {
        stream.end();
      } catch {
        /* already closed */
      }
      end();
    },
    onData(callback) {
      stream.on("data", (chunk: Buffer) => callback(chunk.toString("utf8")));
      stream.stderr.on("data", (chunk: Buffer) => callback(chunk.toString("utf8")));
    },
    onExit(callback) {
      exits.push(callback);
    },
  };
}

function modeText(mode: number): string {
  const kind = (mode & 0o170000) === 0o040000 ? "d" : (mode & 0o170000) === 0o120000 ? "l" : "-";
  const bits = ["r", "w", "x", "r", "w", "x", "r", "w", "x"].map((letter, index) => (mode & (1 << (8 - index)) ? letter : "-")).join("");
  return kind + bits;
}

/** Minimal SOCKS5 (no auth, CONNECT only): enough for a browser or curl pointed at a dynamic forward. */
function socksHandshake(socket: net.Socket): Promise<{ host: string; port: number }> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let stage = 0;
    const fail = (error: string) => {
      socket.removeListener("data", onData);
      reject(new Error(error));
    };
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 0) {
        if (buffer.length < 2) return;
        if (buffer[0] !== 5) return fail("not socks5");
        const methods = buffer[1];
        if (buffer.length < 2 + methods) return;
        buffer = buffer.subarray(2 + methods);
        socket.write(Buffer.from([5, 0]));
        stage = 1;
      }
      if (stage === 1) {
        if (buffer.length < 4) return;
        if (buffer[1] !== 1) {
          socket.end(Buffer.from([5, 7, 0, 1, 0, 0, 0, 0, 0, 0]));
          return fail("only CONNECT");
        }
        const kind = buffer[3];
        let host = "";
        let at = 4;
        if (kind === 1) {
          if (buffer.length < at + 6) return;
          host = [...buffer.subarray(at, at + 4)].join(".");
          at += 4;
        } else if (kind === 3) {
          if (buffer.length < at + 1) return;
          const length = buffer[at];
          if (buffer.length < at + 1 + length + 2) return;
          host = buffer.subarray(at + 1, at + 1 + length).toString("utf8");
          at += 1 + length;
        } else if (kind === 4) {
          if (buffer.length < at + 18) return;
          const words: string[] = [];
          for (let index = 0; index < 8; index += 1) words.push(buffer.readUInt16BE(at + index * 2).toString(16));
          host = words.join(":");
          at += 16;
        } else {
          return fail("bad address");
        }
        const port = buffer.readUInt16BE(at);
        socket.removeListener("data", onData);
        resolve({ host, port });
      }
    };
    socket.on("data", onData);
    socket.once("error", (error) => reject(error));
  });
}

interface ForwardRun {
  state: SshForwardState;
  client?: Client;
  server?: net.Server;
  stop: () => void;
}

export function createSshManager(store: SshStore, connect: Connect) {
  // ---------- terminals ----------
  /** Shells connected and waiting for the hub to take them (the hub opens terminals synchronously). */
  const ready = new Map<string, ShellProcess>();
  const hub = createTerminalHub((token) => {
    const shell = ready.get(token);
    ready.delete(token);
    if (!shell) throw new Error("not connected");
    return shell;
  });
  const sessions = new Map<string, SshSessionInfo>();
  const hostKey = (hostId: string) => `ssh:${hostId}`;

  const openSession = async (hostId: string): Promise<SshSessionInfo> => {
    const target = store.target(hostId);
    const client = await connect(target);
    const stream = await new Promise<ClientChannel>((resolve, reject) =>
      client.shell({ term: "xterm-256color", cols: 100, rows: 30 }, (error, channel) => (error ? reject(error) : resolve(channel))),
    ).catch((error) => {
      client.end();
      throw error instanceof SshError ? error : new SshError("shell_failed", 502);
    });
    const shell = shellProcess(client, stream, target.backspace);
    const token = `ssh-${hostId}-${Date.now()}-${Math.random()}`;
    ready.set(token, shell);
    let info;
    try {
      info = hub.create(hostKey(hostId), token);
    } catch (error) {
      ready.delete(token);
      shell.kill();
      throw new SshError("too_many_sessions", 409);
    }
    const session: SshSessionInfo = { tid: info.tid, hostId, label: target.label, createdAt: info.createdAt };
    sessions.set(info.tid, session);
    shell.onExit(() => sessions.delete(info.tid));
    store.touchHost(hostId);
    if (target.startup) {
      const { command, run } = target.startup;
      setTimeout(() => shell.write(run ? `${command.replace(/\n+$/, "")}\r` : command), 600);
    }
    return session;
  };

  const sessionFor = (tid: string) => {
    const session = sessions.get(tid);
    if (!session) throw new SshError("unknown_session", 404);
    return session;
  };

  // ---------- SFTP ----------
  const sftpPool = new Map<string, { client: Client; sftp: SFTPWrapper; timer: NodeJS.Timeout; opening?: Promise<SFTPWrapper> }>();
  const opening = new Map<string, Promise<SFTPWrapper>>();
  const dropSftp = (hostId: string) => {
    const entry = sftpPool.get(hostId);
    if (!entry) return;
    clearTimeout(entry.timer);
    sftpPool.delete(hostId);
    try {
      entry.client.end();
    } catch {
      /* already closed */
    }
  };
  const sftpFor = (hostId: string): Promise<SFTPWrapper> => {
    const entry = sftpPool.get(hostId);
    if (entry) {
      entry.timer.refresh();
      return Promise.resolve(entry.sftp);
    }
    const pending = opening.get(hostId);
    if (pending) return pending;
    const next = (async () => {
      const client = await connect(store.target(hostId));
      const sftp = await new Promise<SFTPWrapper>((resolve, reject) => client.sftp((error, wrapper) => (error ? reject(new SshError("sftp_failed", 502)) : resolve(wrapper))));
      const timer = setTimeout(() => dropSftp(hostId), SFTP_IDLE_MS);
      timer.unref?.();
      sftpPool.set(hostId, { client, sftp, timer });
      client.on("close", () => sftpPool.get(hostId)?.client === client && (clearTimeout(timer), sftpPool.delete(hostId)));
      return sftp;
    })().finally(() => opening.delete(hostId));
    opening.set(hostId, next);
    return next;
  };
  const call = <T>(run: (done: (error: Error | null | undefined, value?: T) => void) => void): Promise<T> =>
    new Promise((resolve, reject) =>
      run((error, value) => {
        if (!error) return resolve(value as T);
        const code = (error as Error & { code?: number }).code;
        reject(new SshError(code === 2 ? "not_found" : code === 3 ? "permission_denied" : code === 4 ? "sftp_failure" : "sftp_failed", code === 2 ? 404 : code === 3 ? 403 : 500));
      }),
    );
  const remotePath = (value: unknown): string => {
    const text = typeof value === "string" ? value : "";
    if (!text || text.includes("\0")) throw new SshError("bad_path");
    return text;
  };

  const sftp = {
    async home(hostId: string): Promise<string> {
      const wrapper = await sftpFor(hostId);
      return call<string>((done) => wrapper.realpath(".", done));
    },
    async list(hostId: string, dir: string): Promise<{ path: string; entries: SftpEntry[] }> {
      const wrapper = await sftpFor(hostId);
      const real = await call<string>((done) => wrapper.realpath(remotePath(dir), done));
      const rows = await call<Array<{ filename: string; attrs: { mode: number; size: number; mtime: number } }>>((done) => wrapper.readdir(real, done));
      const entries = rows
        .filter((row) => row.filename !== "." && row.filename !== "..")
        .map((row) => {
          const kind = row.attrs.mode & 0o170000;
          return {
            name: row.filename,
            dir: kind === 0o040000,
            link: kind === 0o120000,
            size: row.attrs.size,
            mtime: row.attrs.mtime * 1000,
            mode: modeText(row.attrs.mode),
          };
        });
      // A link to a folder opens like a folder.
      await Promise.all(
        entries
          .filter((entry) => entry.link)
          .map(async (entry) => {
            try {
              const stat = await call<{ mode: number }>((done) => wrapper.stat(path.join(real, entry.name), done));
              entry.dir = (stat.mode & 0o170000) === 0o040000;
            } catch {
              /* a broken link stays a file */
            }
          }),
      );
      entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
      return { path: real, entries };
    },
    async read(hostId: string, file: string): Promise<{ stream: Readable; size: number }> {
      const wrapper = await sftpFor(hostId);
      const stat = await call<{ size: number; mode: number }>((done) => wrapper.stat(remotePath(file), done));
      if ((stat.mode & 0o170000) === 0o040000) throw new SshError("is_directory");
      return { stream: wrapper.createReadStream(file), size: stat.size };
    },
    async write(hostId: string, file: string): Promise<Writable> {
      const wrapper = await sftpFor(hostId);
      return wrapper.createWriteStream(remotePath(file));
    },
    async mkdir(hostId: string, dir: string) {
      const wrapper = await sftpFor(hostId);
      await call<void>((done) => wrapper.mkdir(remotePath(dir), done));
    },
    async rename(hostId: string, from: string, to: string) {
      const wrapper = await sftpFor(hostId);
      await call<void>((done) => wrapper.rename(remotePath(from), remotePath(to), done));
    },
    async chmod(hostId: string, file: string, mode: number) {
      const wrapper = await sftpFor(hostId);
      await call<void>((done) => wrapper.chmod(remotePath(file), mode, done));
    },
    /** Files, and folders with everything in them. */
    async remove(hostId: string, target: string) {
      const wrapper = await sftpFor(hostId);
      const walk = async (item: string): Promise<void> => {
        const stat = await call<{ mode: number }>((done) => wrapper.lstat(item, done));
        if ((stat.mode & 0o170000) !== 0o040000) {
          await call<void>((done) => wrapper.unlink(item, done));
          return;
        }
        const rows = await call<Array<{ filename: string }>>((done) => wrapper.readdir(item, done));
        for (const row of rows) if (row.filename !== "." && row.filename !== "..") await walk(path.join(item, row.filename));
        await call<void>((done) => wrapper.rmdir(item, done));
      };
      const item = remotePath(target);
      if (item === "/" || item === ".") throw new SshError("bad_path");
      await walk(item);
    },
  };

  // ---------- port forwarding ----------
  const forwards = new Map<string, ForwardRun>();
  const stateOf = (id: string): SshForwardState => forwards.get(id)?.state ?? { id, state: "off", connections: 0 };

  const pipe = (a: net.Socket, b: NodeJS.ReadWriteStream, run: ForwardRun) => {
    run.state.connections += 1;
    let closed = false;
    const done = () => {
      if (closed) return;
      closed = true;
      run.state.connections = Math.max(0, run.state.connections - 1);
      a.destroy();
      (b as unknown as { destroy?: () => void; end: () => void }).destroy?.() ?? b.end();
    };
    a.pipe(b as unknown as Writable).pipe(a);
    a.on("close", done).on("error", done);
    b.on("close", done).on("error", done);
  };

  const startForward = async (id: string): Promise<SshForwardState> => {
    const current = forwards.get(id);
    if (current && (current.state.state === "on" || current.state.state === "starting")) return current.state;
    const forward = store.forward(id);
    const run: ForwardRun = { state: { id, state: "starting", connections: 0 }, stop: () => undefined };
    forwards.set(id, run);
    const failed = (message: string) => {
      run.stop();
      run.state = { id, state: "error", message, connections: 0 };
    };
    try {
      const client = await connect(store.target(forward.hostId));
      run.client = client;
      client.on("close", () => {
        if (run.state.state === "on") run.state = { id, state: "error", message: "连接断开了", connections: 0 };
        run.server?.close();
      });
      run.stop = () => {
        run.server?.close();
        try {
          client.end();
        } catch {
          /* already closed */
        }
      };
      if (forward.type === "remote") {
        await new Promise<void>((resolve, reject) => client.forwardIn(forward.bindHost, forward.bindPort, (error) => (error ? reject(error) : resolve())));
        client.on("tcp connection", (_info, accept) => {
          const channel = accept();
          const socket = net.connect(forward.destPort, forward.destHost);
          pipe(socket, channel, run);
        });
      } else {
        const server = net.createServer((socket) => {
          socket.on("error", () => socket.destroy());
          const open = (host: string, port: number, reply?: () => void) =>
            client.forwardOut(socket.remoteAddress ?? "127.0.0.1", socket.remotePort ?? 0, host, port, (error, channel) => {
              if (error) {
                if (reply) socket.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]));
                else socket.destroy();
                return;
              }
              reply?.();
              pipe(socket, channel, run);
            });
          if (forward.type === "local") open(forward.destHost, forward.destPort);
          else
            socksHandshake(socket).then(
              ({ host, port }) => open(host, port, () => socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))),
              () => socket.destroy(),
            );
        });
        run.server = server;
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(forward.bindPort, forward.bindHost, () => resolve());
        });
      }
      run.state = { id, state: "on", connections: 0 };
    } catch (error) {
      const code = error instanceof SshError ? error.code : (error as NodeJS.ErrnoException)?.code ?? "failed";
      failed(code === "EADDRINUSE" ? "端口已被占用" : code === "EACCES" ? "没有权限监听这个端口" : code);
    }
    return run.state;
  };

  const stopForward = (id: string): SshForwardState => {
    const run = forwards.get(id);
    run?.stop();
    forwards.delete(id);
    return stateOf(id);
  };

  // Forwards marked to start with MirrorMix.
  const autoStart = setTimeout(() => {
    for (const forward of store.state().forwards) if (forward.autoStart) void startForward(forward.id);
  }, 3000);
  autoStart.unref?.();

  return {
    state() {
      const saved = store.state();
      return {
        ...saved,
        forwardStates: saved.forwards.map((forward) => stateOf(forward.id)),
        sessions: [...sessions.values()],
      };
    },
    openSession,
    closeSession(tid: string) {
      const session = sessionFor(tid);
      hub.close(hostKey(session.hostId), tid);
      sessions.delete(tid);
    },
    attach(tid: string, sink: TerminalSink) {
      const session = sessions.get(tid);
      return session ? hub.attach(hostKey(session.hostId), tid, sink) : null;
    },
    /** Types a snippet into an open shell. */
    runSnippet(tid: string, snippetId: string) {
      const session = sessionFor(tid);
      const snippet = store.snippet(snippetId);
      const link = hub.attach(hostKey(session.hostId), tid, { send() {}, close() {} });
      if (!link) throw new SshError("unknown_session", 404);
      link.write(snippet.run ? `${snippet.command.replace(/\n+$/, "")}\r` : snippet.command);
      link.detach();
    },
    /** Connects and leaves again: checks the address, the sign-in and the host key. */
    async test(hostId: string) {
      const client = await connect(store.target(hostId));
      client.end();
    },
    sftp,
    startForward,
    stopForward,
    forgetHost(hostId: string) {
      for (const session of [...sessions.values()]) if (session.hostId === hostId) this.closeSession(session.tid);
      for (const forward of store.state().forwards) if (forward.hostId === hostId) stopForward(forward.id);
      dropSftp(hostId);
    },
    dispose() {
      clearTimeout(autoStart);
      hub.dispose();
      for (const id of [...forwards.keys()]) stopForward(id);
      for (const hostId of [...sftpPool.keys()]) dropSftp(hostId);
    },
  };
}

export type SshManager = ReturnType<typeof createSshManager>;
