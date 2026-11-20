import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import ssh2, { type Server as SshServer } from "ssh2";

const { Server, utils } = ssh2;
const { OPEN_MODE, STATUS_CODE } = utils.sftp;

/**
 * A small SSH server for tests: password sign-in, a shell that echoes, direct-tcpip forwarding, and SFTP served
 * from a folder on disk. Not a real server; enough to drive the SSH plugin end to end.
 */
export async function startTestSshServer(options: { root: string; username?: string; password?: string; shell?: (stream: NodeJS.ReadWriteStream & { write(text: string): boolean }) => void }) {
  const username = options.username ?? "tester";
  const password = options.password ?? "pw";
  const hostKey = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
  const server: SshServer = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on("error", () => undefined);
    client.on("authentication", (context) => {
      if (context.method === "password" && context.username === username && context.password === password) return context.accept();
      context.reject(["password"]);
    });
    client.on("ready", () => {
      client.on("tcpip", (accept, _reject, info) => {
        const channel = accept();
        const socket = net.connect(info.destPort, info.destIP);
        socket.on("error", () => channel.end());
        channel.pipe(socket).pipe(channel);
      });
      client.on("session", (acceptSession) => {
        const session = acceptSession();
        session.on("pty", (accept) => accept?.());
        session.on("window-change", (accept) => accept?.());
        session.on("shell", (accept) => {
          const stream = accept();
          if (options.shell) return options.shell(stream as never);
          stream.write("welcome\r\n");
          stream.on("data", (data: Buffer) => stream.write(`echo:${data.toString()}`));
        });
        session.on("sftp", (accept) => serveSftp(accept(), options.root));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  const parsed = utils.parseKey(hostKey);
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (key instanceof Error) throw key;
  return { server, port, publicKey: key.getPublicSSH() as Buffer, close: () => server.close() };
}

// ssh2's server-side SFTP object; its typings do not cover the request events used here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sftp = any;

function attrsOf(stat: fs.Stats) {
  return {
    mode: stat.mode,
    uid: 0,
    gid: 0,
    size: stat.size,
    atime: Math.floor(stat.atimeMs / 1000),
    mtime: Math.floor(stat.mtimeMs / 1000),
  };
}

/** SFTP requests answered from `root`; remote "/" is `root`. */
function serveSftp(sftp: Sftp, root: string) {
  const local = (remote: string) => {
    const clean = path.posix.normalize("/" + remote.replace(/\\/g, "/"));
    return { remote: clean, file: path.join(root, ...clean.split("/").filter(Boolean)) };
  };
  const handles = new Map<number, { fd?: number; dir?: string; listed?: boolean }>();
  let next = 1;
  const handle = (value: { fd?: number; dir?: string }) => {
    const id = next++;
    handles.set(id, value);
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(id, 0);
    return buffer;
  };
  const read = (buffer: Buffer) => handles.get(buffer.readUInt32BE(0));
  const fail = (reqid: number, error: NodeJS.ErrnoException) =>
    sftp.status(reqid, error.code === "ENOENT" ? STATUS_CODE.NO_SUCH_FILE : error.code === "EACCES" ? STATUS_CODE.PERMISSION_DENIED : STATUS_CODE.FAILURE);

  sftp.on("REALPATH", (reqid: number, remote: string) => {
    const { remote: clean } = local(remote === "." ? "/" : remote);
    sftp.name(reqid, [{ filename: clean, longname: clean, attrs: {} }]);
  });
  for (const op of ["STAT", "LSTAT"]) {
    sftp.on(op, (reqid: number, remote: string) => {
      try {
        sftp.attrs(reqid, attrsOf((op === "STAT" ? fs.statSync : fs.lstatSync)(local(remote).file)));
      } catch (error) {
        fail(reqid, error as NodeJS.ErrnoException);
      }
    });
  }
  sftp.on("OPENDIR", (reqid: number, remote: string) => {
    const { file } = local(remote);
    try {
      if (!fs.statSync(file).isDirectory()) return sftp.status(reqid, STATUS_CODE.FAILURE);
      sftp.handle(reqid, handle({ dir: file }));
    } catch (error) {
      fail(reqid, error as NodeJS.ErrnoException);
    }
  });
  sftp.on("READDIR", (reqid: number, buffer: Buffer) => {
    const entry = read(buffer);
    if (!entry?.dir) return sftp.status(reqid, STATUS_CODE.FAILURE);
    if (entry.listed) return sftp.status(reqid, STATUS_CODE.EOF);
    entry.listed = true;
    const names = fs.readdirSync(entry.dir).map((name) => {
      const stat = fs.lstatSync(path.join(entry.dir!, name));
      return { filename: name, longname: name, attrs: attrsOf(stat) };
    });
    sftp.name(reqid, names);
  });
  sftp.on("OPEN", (reqid: number, remote: string, flags: number) => {
    const { file } = local(remote);
    const mode = flags & OPEN_MODE.WRITE ? (flags & OPEN_MODE.APPEND ? "a" : "w") : "r";
    try {
      sftp.handle(reqid, handle({ fd: fs.openSync(file, mode) }));
    } catch (error) {
      fail(reqid, error as NodeJS.ErrnoException);
    }
  });
  sftp.on("READ", (reqid: number, buffer: Buffer, offset: number, length: number) => {
    const entry = read(buffer);
    if (entry?.fd == null) return sftp.status(reqid, STATUS_CODE.FAILURE);
    const data = Buffer.alloc(length);
    const count = fs.readSync(entry.fd, data, 0, length, offset);
    if (count === 0) return sftp.status(reqid, STATUS_CODE.EOF);
    sftp.data(reqid, data.subarray(0, count));
  });
  sftp.on("WRITE", (reqid: number, buffer: Buffer, offset: number, data: Buffer) => {
    const entry = read(buffer);
    if (entry?.fd == null) return sftp.status(reqid, STATUS_CODE.FAILURE);
    fs.writeSync(entry.fd, data, 0, data.length, offset);
    sftp.status(reqid, STATUS_CODE.OK);
  });
  sftp.on("FSTAT", (reqid: number, buffer: Buffer) => {
    const entry = read(buffer);
    if (entry?.fd == null) return sftp.status(reqid, STATUS_CODE.FAILURE);
    sftp.attrs(reqid, attrsOf(fs.fstatSync(entry.fd)));
  });
  sftp.on("CLOSE", (reqid: number, buffer: Buffer) => {
    const entry = read(buffer);
    if (entry?.fd != null) fs.closeSync(entry.fd);
    handles.delete(buffer.readUInt32BE(0));
    sftp.status(reqid, STATUS_CODE.OK);
  });
  const simple = (op: string, run: (...args: string[]) => void) =>
    sftp.on(op, (reqid: number, ...args: string[]) => {
      try {
        run(...args);
        sftp.status(reqid, STATUS_CODE.OK);
      } catch (error) {
        fail(reqid, error as NodeJS.ErrnoException);
      }
    });
  simple("MKDIR", (remote) => fs.mkdirSync(local(remote).file));
  simple("RMDIR", (remote) => fs.rmdirSync(local(remote).file));
  simple("REMOVE", (remote) => fs.unlinkSync(local(remote).file));
  simple("RENAME", (from, to) => fs.renameSync(local(from).file, local(to).file));
  sftp.on("SETSTAT", (reqid: number, remote: string, attrs: { mode?: number }) => {
    try {
      if (attrs.mode != null) fs.chmodSync(local(remote).file, attrs.mode);
      sftp.status(reqid, STATUS_CODE.OK);
    } catch (error) {
      fail(reqid, error as NodeJS.ErrnoException);
    }
  });
}
