import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Server, utils } from "ssh2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { plainBox } from "../src/settings/secrets";
import { connectTarget, fingerprintOf, HostKeyError, sshKeyTools } from "../src/ssh/connect";
import { createSshManager } from "../src/ssh/manager";
import { createSshStore, parseSshConfig } from "../src/ssh/store";

const tempStore = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aimiss-ssh-"));
  const file = path.join(dir, "ssh.json");
  return { dir, file, store: createSshStore(file, plainBox(), sshKeyTools) };
};

describe("SSH store", () => {
  it("keeps passwords and private keys sealed on disk and out of what the page sees", () => {
    const { file, store } = tempStore();
    const host = store.saveHost({ label: "web", host: "10.0.0.5", username: "root", auth: "password", password: "hunter2" });
    expect(host.hasPassword).toBe(true);
    expect(JSON.stringify(store.state())).not.toContain("hunter2");
    const key = store.generateKey({ label: "laptop", type: "ed25519" });
    expect(key.publicKey).toMatch(/^ssh-ed25519 AAAA/);
    expect(key.fingerprint).toMatch(/^SHA256:/);
    const disk = readFileSync(file, "utf8");
    expect(disk).not.toContain("hunter2");
    expect(disk).not.toContain("PRIVATE KEY");
    // Editing without a password keeps it; "" clears it.
    expect(store.saveHost({ id: host.id, label: "web", host: "10.0.0.5", username: "root", auth: "password" }).hasPassword).toBe(true);
    expect(store.target(host.id).password).toBe("hunter2");
    expect(store.saveHost({ id: host.id, label: "web", host: "10.0.0.5", username: "root", auth: "password", password: "" }).hasPassword).toBe(false);
  });

  it("follows jump hosts, refuses loops, and keeps keys that are in use", () => {
    const { store } = tempStore();
    const key = store.generateKey({ label: "k", type: "ed25519" });
    const bastion = store.saveHost({ label: "bastion", host: "b.example", username: "jump", auth: "key", keyId: key.id });
    const inner = store.saveHost({ label: "db", host: "10.1.0.9", username: "app", auth: "password", password: "pw", jumpHostId: bastion.id });
    const target = store.target(inner.id);
    expect(target.jump?.host).toBe("b.example");
    expect(target.jump?.privateKey).toContain("PRIVATE KEY");
    expect(() => store.saveHost({ id: bastion.id, label: "bastion", host: "b.example", username: "jump", auth: "key", keyId: key.id, jumpHostId: inner.id })).toThrow("jump_loop");
    expect(() => store.deleteKey(key.id)).toThrow("key_in_use");
    store.deleteHost(bastion.id);
    expect(store.state().hosts.find((host) => host.id === inner.id)?.jumpHostId).toBeUndefined();
  });

  it("uses an identity's user and password", () => {
    const { store } = tempStore();
    const identity = store.saveIdentity({ label: "ops", username: "ops", password: "s3cret" });
    expect(identity.hasPassword).toBe(true);
    const host = store.saveHost({ label: "x", host: "x.example", auth: "identity", identityId: identity.id });
    expect(store.target(host.id)).toMatchObject({ username: "ops", password: "s3cret" });
  });

  it("reads hosts from an OpenSSH config, with ProxyJump, and skips wildcard patterns", () => {
    expect(
      parseSshConfig(`
Host *
  ServerAliveInterval 30
Host bastion
  HostName 1.2.3.4
  User jump
  Port 2222
Host db db-alias
  HostName 10.0.0.9
  User app
  ProxyJump bastion
`),
    ).toEqual([
      { alias: "bastion", hostName: "1.2.3.4", user: "jump", port: 2222 },
      { alias: "db", hostName: "10.0.0.9", user: "app", proxyJump: "bastion" },
      { alias: "db-alias", hostName: "10.0.0.9", user: "app", proxyJump: "bastion" },
    ]);
    const { store, dir } = tempStore();
    const result = store.importConfig("Host bastion\n HostName 1.2.3.4\n User jump\nHost db\n HostName 10.0.0.9\n User app\n ProxyJump bastion\n", dir);
    expect(result.hosts).toBe(2);
    const hosts = store.state().hosts;
    const bastion = hosts.find((host) => host.label === "bastion")!;
    expect(hosts.find((host) => host.label === "db")?.jumpHostId).toBe(bastion.id);
    // Importing again adds nothing.
    expect(store.importConfig("Host bastion\n HostName 1.2.3.4\n User jump\n", dir).skipped).toEqual(["bastion"]);
  });

  it("validates what the page sends", () => {
    const { store } = tempStore();
    expect(() => store.saveHost({ label: "", host: "", auth: "password" })).toThrow("host_required");
    expect(() => store.saveHost({ label: "x", host: "a b", auth: "password" })).toThrow("bad_host");
    expect(() => store.saveHost({ label: "x", host: "x", port: 70000, auth: "password" })).toThrow("bad_port");
    expect(() => store.saveHost({ label: "x", host: "x", auth: "key" })).toThrow("key_required");
    expect(() => store.importKey({ label: "x", privateKey: "not a key" })).toThrow("bad_key");
  });
});

// ---------- against a real SSH server running in this test ----------

const hostKey = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
let server: Server;
let port = 0;
let echoPort = 0;
let echo: net.Server;

beforeAll(async () => {
  echo = net.createServer((socket) => socket.pipe(socket));
  await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
  echoPort = (echo.address() as net.AddressInfo).port;
  server = new Server({ hostKeys: [hostKey] }, (client) => {
    // A client that refuses the host key drops the connection mid-handshake.
    client.on("error", () => undefined);
    client.on("authentication", (context) => {
      if (context.method === "password" && context.username === "tester" && context.password === "pw") return context.accept();
      context.reject(["password"]);
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("pty", (acceptPty) => acceptPty?.());
        session.on("window-change", (acceptWindow) => acceptWindow?.());
        session.on("shell", (acceptShell) => {
          const stream = acceptShell();
          stream.write("welcome\r\n");
          stream.on("data", (data: Buffer) => stream.write(`echo:${data.toString()}`));
        });
      });
      client.on("tcpip", (accept, _reject, info) => {
        const channel = accept();
        const socket = net.connect(info.destPort, info.destIP);
        channel.pipe(socket).pipe(channel);
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as net.AddressInfo).port;
});

afterAll(() => {
  server?.close();
  echo?.close();
});

const serverFingerprint = () => {
  const parsed = utils.parseKey(hostKey);
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (key instanceof Error) throw key;
  return fingerprintOf(key.getPublicSSH());
};

describe("SSH against a live server", () => {
  it("asks before trusting a new host key, then connects", async () => {
    const { store } = tempStore();
    const host = store.saveHost({ label: "local", host: "127.0.0.1", port, username: "tester", auth: "password", password: "pw" });
    const error = await connectTarget(store.target(host.id), store).catch((caught) => caught);
    expect(error).toBeInstanceOf(HostKeyError);
    expect(error.question).toMatchObject({ address: `127.0.0.1:${port}`, keyType: "ssh-rsa", fingerprint: serverFingerprint() });
    store.trustHostKey(error.question.address, error.question.keyType, error.question.fingerprint);
    const client = await connectTarget(store.target(host.id), store);
    client.end();
  });

  it("warns when the host key changed", async () => {
    const { store } = tempStore();
    const host = store.saveHost({ label: "local", host: "127.0.0.1", port, username: "tester", auth: "password", password: "pw" });
    store.trustHostKey(`127.0.0.1:${port}`, "ssh-rsa", "SHA256:somethingElse");
    const error = await connectTarget(store.target(host.id), store).catch((caught) => caught);
    expect(error.code).toBe("host_key_changed");
    expect(error.question.previous).toBe("SHA256:somethingElse");
  });

  it("says when the password is wrong", async () => {
    const { store } = tempStore();
    const host = store.saveHost({ label: "local", host: "127.0.0.1", port, username: "tester", auth: "password", password: "nope" });
    store.trustHostKey(`127.0.0.1:${port}`, "ssh-rsa", serverFingerprint());
    await expect(connectTarget(store.target(host.id), store)).rejects.toThrow("auth_failed");
  });

  it("opens a shell the page can attach to, types snippets into it, and runs the startup snippet", async () => {
    const { store } = tempStore();
    const snippet = store.saveSnippet({ label: "hi", command: "uptime" });
    const host = store.saveHost({ label: "local", host: "127.0.0.1", port, username: "tester", auth: "password", password: "pw", startupSnippetId: snippet.id });
    store.trustHostKey(`127.0.0.1:${port}`, "ssh-rsa", serverFingerprint());
    const manager = createSshManager(store, (target) => connectTarget(target, store));
    const session = await manager.openSession(host.id);
    expect(manager.state().sessions).toEqual([expect.objectContaining({ tid: session.tid, hostId: host.id, label: "local" })]);
    let screen = "";
    const link = manager.attach(session.tid, { send: (data) => void (screen += data), close() {} })!;
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(screen).toContain("welcome");
    expect(screen).toContain("echo:uptime\r");
    link.write("ls\r");
    manager.runSnippet(session.tid, snippet.id);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(screen).toContain("echo:ls\r");
    link.detach();
    manager.closeSession(session.tid);
    expect(manager.state().sessions).toEqual([]);
    expect(store.state().hosts[0].lastConnectedAt).toEqual(expect.any(Number));
    manager.dispose();
  });

  it("forwards a local port through the server", async () => {
    const { store } = tempStore();
    const host = store.saveHost({ label: "local", host: "127.0.0.1", port, username: "tester", auth: "password", password: "pw" });
    store.trustHostKey(`127.0.0.1:${port}`, "ssh-rsa", serverFingerprint());
    const free = await new Promise<number>((resolve) => {
      const probe = net.createServer().listen(0, "127.0.0.1", () => {
        const value = (probe.address() as net.AddressInfo).port;
        probe.close(() => resolve(value));
      });
    });
    const forward = store.saveForward({ hostId: host.id, type: "local", bindHost: "127.0.0.1", bindPort: free, destHost: "127.0.0.1", destPort: echoPort });
    const manager = createSshManager(store, (target) => connectTarget(target, store));
    expect(await manager.startForward(forward.id)).toMatchObject({ state: "on" });
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(free, "127.0.0.1", () => socket.write("ping"));
      socket.on("data", (data) => {
        resolve(data.toString());
        socket.end();
      });
      socket.on("error", reject);
    });
    expect(reply).toBe("ping");
    expect(manager.stopForward(forward.id)).toMatchObject({ state: "off" });
    manager.dispose();
  });
});

// Keep the fixture helpers honest: a key written to a file is read from it on each use.
describe("keys from ~/.ssh", () => {
  it("references the file instead of copying the key", () => {
    const { store, dir } = tempStore();
    const pair = utils.generateKeyPairSync("ed25519", { comment: "me@pc" });
    const file = path.join(dir, "id_ed25519");
    writeFileSync(file, pair.private);
    const key = store.importKeyFile(file, "id_ed25519");
    expect(key.file).toBe(file);
    expect(key.publicKey).toContain("me@pc");
    expect(readFileSync(path.join(dir, "ssh.json"), "utf8")).not.toContain("PRIVATE KEY");
    const host = store.saveHost({ label: "h", host: "h", username: "u", auth: "key", keyId: key.id });
    expect(store.target(host.id).privateKey).toBe(pair.private);
  });
});

describe("SFTP through the plugin", () => {
  it("lists, uploads, downloads, renames, changes permissions and deletes", async () => {
    const { mkdirSync, existsSync } = await import("node:fs");
    const { Readable } = await import("node:stream");
    const { startTestSshServer } = await import("./helpers/testSshServer");
    const { fingerprintOf: fp } = await import("../src/ssh/connect");
    const root = mkdtempSync(path.join(tmpdir(), "aimiss-sftp-root-"));
    mkdirSync(path.join(root, "home"));
    writeFileSync(path.join(root, "home", "notes.txt"), "hello sftp");
    const sshd = await startTestSshServer({ root });
    try {
      const { store } = tempStore();
      const host = store.saveHost({ label: "files", host: "127.0.0.1", port: sshd.port, username: "tester", auth: "password", password: "pw" });
      store.trustHostKey(`127.0.0.1:${sshd.port}`, "ssh-rsa", fp(sshd.publicKey));
      const manager = createSshManager(store, (target) => connectTarget(target, store));
      expect(await manager.sftp.home(host.id)).toBe("/");
      const listed = await manager.sftp.list(host.id, "/home");
      expect(listed.path).toBe("/home");
      expect(listed.entries).toEqual([expect.objectContaining({ name: "notes.txt", dir: false, size: 10, mode: expect.stringMatching(/^-r/) })]);

      const { stream } = await manager.sftp.read(host.id, "/home/notes.txt");
      let text = "";
      for await (const chunk of stream) text += chunk.toString();
      expect(text).toBe("hello sftp");

      const target = await manager.sftp.write(host.id, "/home/upload.bin");
      await new Promise<void>((resolve, reject) => Readable.from([Buffer.from("uploaded!")]).pipe(target).on("finish", resolve).on("close", resolve).on("error", reject));
      expect(readFileSync(path.join(root, "home", "upload.bin"), "utf8")).toBe("uploaded!");

      await manager.sftp.mkdir(host.id, "/home/sub");
      await manager.sftp.rename(host.id, "/home/upload.bin", "/home/sub/moved.bin");
      expect(existsSync(path.join(root, "home", "sub", "moved.bin"))).toBe(true);
      await manager.sftp.chmod(host.id, "/home/notes.txt", 0o644);
      await manager.sftp.remove(host.id, "/home/sub");
      expect(existsSync(path.join(root, "home", "sub"))).toBe(false);
      await expect(manager.sftp.list(host.id, "/nope")).rejects.toThrow("not_found");
      await expect(manager.sftp.remove(host.id, "/")).rejects.toThrow("bad_path");
      manager.dispose();
    } finally {
      sshd.close();
    }
  });
});
