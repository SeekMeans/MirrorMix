import { createHash } from "node:crypto";
// ssh2 is CommonJS: Node's ESM loader only offers its default export, so the parts are taken from that.
import ssh2, { type Client as SshClient, type ConnectConfig } from "ssh2";

const { Client, utils } = ssh2;
type Client = SshClient;
import type { SshHostKeyQuestion } from "../shared/ssh";
import { SshError, type KeyFacts, type KeyTools, type SshStore, type SshTarget } from "./store";

/** Thrown when the server's host key is not trusted yet, or differs from the trusted one. The page asks first. */
export class HostKeyError extends SshError {
  constructor(readonly question: SshHostKeyQuestion) {
    super(question.previous ? "host_key_changed" : "host_key_unknown", 409);
  }
}

/** "ssh-ed25519" from the key blob's first field. */
export function keyTypeOf(blob: Buffer): string {
  if (blob.length < 4) return "unknown";
  const length = blob.readUInt32BE(0);
  return blob.subarray(4, 4 + length).toString("ascii") || "unknown";
}

/** The same form `ssh-keygen -l` prints: SHA256:base64-without-padding. */
export function fingerprintOf(blob: Buffer): string {
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

export const sshKeyTools: KeyTools = {
  inspect(privateKey: string, passphrase?: string): KeyFacts {
    const parsed = utils.parseKey(privateKey, passphrase);
    if (parsed instanceof Error) {
      if (/passphrase|encrypted/i.test(parsed.message)) throw new SshError(passphrase ? "bad_passphrase" : "needs_passphrase");
      throw new SshError("bad_key");
    }
    const key = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!key.isPrivateKey()) throw new SshError("not_private_key");
    const blob = key.getPublicSSH();
    const comment = key.comment ? ` ${key.comment}` : "";
    return { type: key.type, publicKey: `${key.type} ${blob.toString("base64")}${comment}`, fingerprint: fingerprintOf(blob) };
  },
  generate(type, bits, passphrase, comment) {
    const options: Record<string, unknown> = { comment };
    if (bits) options.bits = bits;
    if (passphrase) Object.assign(options, { passphrase, cipher: "aes256-cbc" });
    const pair = (utils.generateKeyPairSync as (keyType: string, opts: Record<string, unknown>) => { private: string; public: string })(type, options);
    return { privateKey: pair.private };
  },
};

/** Windows' OpenSSH agent pipe; Pageant is used when that is not running. */
const AGENT = process.platform === "win32" ? "\\\\.\\pipe\\openssh-ssh-agent" : process.env.SSH_AUTH_SOCK;

const READY_MS = 20_000;

/** Opens an SSH connection to a saved host, through its jump hosts. Every hop's host key is checked. */
export async function connectTarget(target: SshTarget, store: Pick<SshStore, "knownHost">, sock?: NodeJS.ReadableStream & NodeJS.WritableStream): Promise<Client> {
  let through: Client | null = null;
  if (target.jump && !sock) {
    through = await connectTarget(target.jump, store);
    sock = await new Promise((resolve, reject) =>
      through!.forwardOut("127.0.0.1", 0, target.host, target.port, (error, stream) => (error ? reject(new SshError("jump_failed", 502)) : resolve(stream))),
    );
  }
  const address = `${target.host}:${target.port}`;
  const client = new Client();
  let refused: HostKeyError | null = null;
  const config: ConnectConfig = {
    host: target.host,
    port: target.port,
    username: target.username,
    readyTimeout: READY_MS,
    keepaliveInterval: target.keepAlive > 0 ? target.keepAlive * 1000 : 0,
    keepaliveCountMax: 3,
    tryKeyboard: Boolean(target.password),
    ...(sock ? { sock: sock as unknown as ConnectConfig["sock"] } : {}),
    ...(target.password ? { password: target.password } : {}),
    ...(target.privateKey ? { privateKey: target.privateKey } : {}),
    ...(target.passphrase ? { passphrase: target.passphrase } : {}),
    ...(target.useAgent ? { agent: AGENT || "pageant" } : {}),
    hostVerifier: (key: Buffer) => {
      const fingerprint = fingerprintOf(key);
      const keyType = keyTypeOf(key);
      const known = store.knownHost(address);
      if (known && known.fingerprint === fingerprint) return true;
      refused = new HostKeyError({ address, keyType, fingerprint, ...(known ? { previous: known.fingerprint } : {}) });
      return false;
    },
  };
  // An error after the connection is up (a reset, a dropped jump host) ends it through "close"; without a
  // listener Node would treat it as unhandled and stop MirrorMix.
  client.on("error", () => undefined);
  // Servers that only offer keyboard-interactive get the saved password as the answer.
  client.on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) => finish(prompts.map(() => target.password ?? "")));
  try {
    await new Promise<void>((resolve, reject) => {
      client.once("ready", () => resolve());
      client.once("error", (error: Error & { level?: string }) => {
        if (refused) return reject(refused);
        const text = error.message || "";
        if (error.level === "client-authentication" || /authentication/i.test(text)) return reject(new SshError("auth_failed", 422));
        if (/timed out/i.test(text)) return reject(new SshError("timeout", 504));
        if (/ENOTFOUND|EAI_AGAIN/i.test(text)) return reject(new SshError("host_not_found", 502));
        if (/ECONNREFUSED/i.test(text)) return reject(new SshError("connection_refused", 502));
        if (/agent/i.test(text)) return reject(new SshError("agent_failed", 502));
        reject(new SshError("connect_failed", 502));
      });
      client.connect(config);
    });
  } catch (error) {
    through?.end();
    throw error;
  }
  // The jump connection lives as long as this one.
  if (through) client.once("close", () => through!.end());
  return client;
}
