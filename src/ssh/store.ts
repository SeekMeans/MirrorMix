import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SecretBox } from "../settings/secrets";
import type {
  SshAuth,
  SshForward,
  SshGroup,
  SshHostInput,
  SshHostView,
  SshIdentityView,
  SshKeyView,
  SshKnownHost,
  SshSnippet,
  SshTask,
} from "../shared/ssh";

export class SshError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
  ) {
    super(code);
  }
}

interface StoredHost extends Omit<SshHostView, "hasPassword"> {
  password?: string;
}
interface StoredKey extends Omit<SshKeyView, "hasPassphrase"> {
  /** Sealed private key text, unless it is read from `file`. */
  privateKey?: string;
  passphrase?: string;
}
interface StoredIdentity extends Omit<SshIdentityView, "hasPassword"> {
  password?: string;
}

interface Saved {
  version: 1;
  groups: SshGroup[];
  hosts: StoredHost[];
  keys: StoredKey[];
  identities: StoredIdentity[];
  snippets: SshSnippet[];
  tasks: SshTask[];
  forwards: SshForward[];
  knownHosts: SshKnownHost[];
}

/** What reading a private key tells: its public half. Throws "bad_key" or "needs_passphrase". */
export interface KeyFacts {
  type: string;
  publicKey: string;
  fingerprint: string;
}

export interface KeyTools {
  inspect(privateKey: string, passphrase?: string): KeyFacts;
  generate(type: "ed25519" | "rsa" | "ecdsa", bits: number | undefined, passphrase: string | undefined, comment: string): { privateKey: string };
}

/** Everything needed to open one connection, secrets included. Only the server sees this. */
export interface SshTarget {
  hostId: string;
  label: string;
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  useAgent: boolean;
  keepAlive: number;
  startup?: SshSnippet;
  backspace: "del" | "bs";
  jump?: SshTarget;
}

const empty = (): Saved => ({ version: 1, groups: [], hosts: [], keys: [], identities: [], snippets: [], tasks: [], forwards: [], knownHosts: [] });

const clean = (value: unknown, max = 500): string => (typeof value === "string" ? value.trim().slice(0, max) : "");
const tagsOf = (value: unknown): string[] =>
  Array.isArray(value) ? [...new Set(value.map((tag) => clean(tag, 40)).filter(Boolean))].slice(0, 20) : [];
const portOf = (value: unknown, fallback: number): number => {
  const port = Number(value ?? fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new SshError("bad_port");
  return port;
};

export function createSshStore(file: string, box: SecretBox, keys: KeyTools) {
  let data: Saved;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<Saved>;
    data = { ...empty(), ...raw, version: 1 };
  } catch {
    data = empty();
  }

  const save = () => {
    mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(data, null, 2));
    renameSync(temp, file);
  };

  const hostView = ({ password, ...host }: StoredHost): SshHostView => ({ ...host, hasPassword: Boolean(password) });
  const keyView = ({ privateKey: _key, passphrase, ...key }: StoredKey): SshKeyView => ({ ...key, hasPassphrase: Boolean(passphrase) });
  const identityView = ({ password, ...identity }: StoredIdentity): SshIdentityView => ({ ...identity, hasPassword: Boolean(password) });

  const findHost = (id: string) => {
    const host = data.hosts.find((item) => item.id === id);
    if (!host) throw new SshError("unknown_host", 404);
    return host;
  };
  const findKey = (id: string) => {
    const key = data.keys.find((item) => item.id === id);
    if (!key) throw new SshError("unknown_key", 404);
    return key;
  };
  const optionalRef = <T extends { id: string }>(list: T[], value: unknown, code: string): string | undefined => {
    if (value == null || value === "") return undefined;
    if (typeof value !== "string" || !list.some((item) => item.id === value)) throw new SshError(code);
    return value;
  };

  /** Private key text, read from its file when it was imported from ~/.ssh. */
  const privateKeyOf = (key: StoredKey): string => {
    if (key.file) {
      try {
        return readFileSync(key.file, "utf8");
      } catch {
        throw new SshError("key_file_missing", 409);
      }
    }
    if (!key.privateKey) throw new SshError("unknown_key", 404);
    return box.unseal(key.privateKey);
  };

  return {
    state() {
      return {
        groups: data.groups,
        hosts: data.hosts.map(hostView),
        keys: data.keys.map(keyView),
        identities: data.identities.map(identityView),
        snippets: data.snippets,
        // Tasks saved before tags existed have none.
        tasks: data.tasks.map((task) => ({ ...task, tags: task.tags ?? [] })),
        forwards: data.forwards,
        knownHosts: data.knownHosts,
      };
    },

    // ---------- groups ----------
    saveGroup(input: { id?: string; name: unknown; parentId?: unknown }): SshGroup {
      const name = clean(input.name, 80);
      if (!name) throw new SshError("name_required");
      const parentId = optionalRef(data.groups, input.parentId, "unknown_group");
      if (input.id) {
        const group = data.groups.find((item) => item.id === input.id);
        if (!group) throw new SshError("unknown_group", 404);
        // A group cannot sit inside itself or one of its own subgroups.
        for (let up = parentId; up; up = data.groups.find((item) => item.id === up)?.parentId) {
          if (up === group.id) throw new SshError("group_loop");
        }
        group.name = name;
        group.parentId = parentId;
        save();
        return group;
      }
      const group: SshGroup = { id: randomUUID(), name, ...(parentId ? { parentId } : {}) };
      data.groups.push(group);
      save();
      return group;
    },
    /** Its hosts and subgroups move up to its parent. */
    deleteGroup(id: string) {
      const group = data.groups.find((item) => item.id === id);
      if (!group) throw new SshError("unknown_group", 404);
      for (const host of data.hosts) if (host.groupId === id) host.groupId = group.parentId;
      for (const child of data.groups) if (child.parentId === id) child.parentId = group.parentId;
      data.groups = data.groups.filter((item) => item.id !== id);
      save();
    },

    // ---------- hosts ----------
    saveHost(input: SshHostInput): SshHostView {
      const label = clean(input.label, 120) || clean(input.host, 255);
      const address = clean(input.host, 255);
      if (!address) throw new SshError("host_required");
      if (/\s/.test(address)) throw new SshError("bad_host");
      const auth: SshAuth = (["password", "key", "identity", "agent"] as const).includes(input.auth) ? input.auth : "password";
      const existing = input.id ? findHost(input.id) : null;
      const next: StoredHost = {
        id: existing?.id ?? randomUUID(),
        label,
        host: address,
        port: portOf(input.port, 22),
        username: clean(input.username, 120),
        tags: tagsOf(input.tags),
        auth,
        keepAlive: Math.max(0, Math.min(600, Math.round(Number(input.keepAlive ?? existing?.keepAlive ?? 30)) || 0)),
        createdAt: existing?.createdAt ?? Date.now(),
        ...(existing?.lastConnectedAt ? { lastConnectedAt: existing.lastConnectedAt } : {}),
      };
      const groupId = optionalRef(data.groups, input.groupId, "unknown_group");
      if (groupId) next.groupId = groupId;
      const color = clean(input.color, 20);
      if (color && /^#[0-9a-f]{6}$/i.test(color)) next.color = color;
      const keyId = optionalRef(data.keys, input.keyId, "unknown_key");
      if (keyId) next.keyId = keyId;
      const identityId = optionalRef(data.identities, input.identityId, "unknown_identity");
      if (identityId) next.identityId = identityId;
      const jumpHostId = optionalRef(data.hosts, input.jumpHostId, "unknown_jump_host");
      if (jumpHostId) {
        // A host cannot reach itself through a chain that comes back to it.
        for (let hop: string | undefined = jumpHostId; hop; hop = data.hosts.find((item) => item.id === hop)?.jumpHostId) {
          if (hop === next.id) throw new SshError("jump_loop");
        }
        next.jumpHostId = jumpHostId;
      }
      const startupSnippetId = optionalRef(data.snippets, input.startupSnippetId, "unknown_snippet");
      if (startupSnippetId) next.startupSnippetId = startupSnippetId;
      if (input.backspace === "bs") next.backspace = "bs";
      const charset = clean(input.charset, 30);
      if (charset) next.charset = charset;
      const notes = clean(input.notes, 2000);
      if (notes) next.notes = notes;
      if (auth === "key" && !next.keyId) throw new SshError("key_required");
      if (auth === "identity" && !next.identityId) throw new SshError("identity_required");
      // Password: a new one replaces, "" clears, absent keeps.
      if (typeof input.password === "string") {
        if (input.password) next.password = box.seal(input.password);
      } else if (existing?.password) next.password = existing.password;
      // An edit replaces the record whole, so fields cleared on the form are gone too.
      if (existing) data.hosts[data.hosts.indexOf(existing)] = next;
      else data.hosts.push(next);
      save();
      return hostView(next);
    },
    duplicateHost(id: string): SshHostView {
      const source = findHost(id);
      const copy: StoredHost = { ...source, id: randomUUID(), label: `${source.label} 副本`, createdAt: Date.now() };
      delete copy.lastConnectedAt;
      data.hosts.push(copy);
      save();
      return hostView(copy);
    },
    deleteHost(id: string) {
      findHost(id);
      data.hosts = data.hosts.filter((item) => item.id !== id);
      for (const host of data.hosts) if (host.jumpHostId === id) delete host.jumpHostId;
      data.forwards = data.forwards.filter((item) => item.hostId !== id);
      data.tasks = data.tasks.filter((item) => item.hostId !== id);
      save();
    },
    touchHost(id: string) {
      const host = data.hosts.find((item) => item.id === id);
      if (!host) return;
      host.lastConnectedAt = Date.now();
      save();
    },

    // ---------- keychain ----------
    importKey(input: { label: unknown; privateKey: unknown; passphrase?: unknown }): SshKeyView {
      const text = typeof input.privateKey === "string" ? input.privateKey.trim() + "\n" : "";
      if (!text.trim()) throw new SshError("key_required");
      const passphrase = typeof input.passphrase === "string" && input.passphrase ? input.passphrase : undefined;
      const facts = keys.inspect(text, passphrase);
      const key: StoredKey = {
        id: randomUUID(),
        label: clean(input.label, 120) || facts.type,
        ...facts,
        privateKey: box.seal(text),
        ...(passphrase ? { passphrase: box.seal(passphrase) } : {}),
        createdAt: Date.now(),
      };
      data.keys.push(key);
      save();
      return keyView(key);
    },
    /** Kept as a reference to the file, read again on each use. */
    importKeyFile(file: string, label: string, passphrase?: string): SshKeyView {
      const existing = data.keys.find((item) => item.file && path.resolve(item.file).toLowerCase() === path.resolve(file).toLowerCase());
      if (existing) return keyView(existing);
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        throw new SshError("key_file_missing", 404);
      }
      const facts = keys.inspect(text, passphrase);
      const key: StoredKey = {
        id: randomUUID(),
        label: clean(label, 120) || path.basename(file),
        ...facts,
        file,
        ...(passphrase ? { passphrase: box.seal(passphrase) } : {}),
        createdAt: Date.now(),
      };
      data.keys.push(key);
      save();
      return keyView(key);
    },
    generateKey(input: { label: unknown; type?: unknown; bits?: unknown; passphrase?: unknown }): SshKeyView {
      const type = input.type === "rsa" || input.type === "ecdsa" ? input.type : "ed25519";
      const bits = type === "rsa" ? (Number(input.bits) === 2048 ? 2048 : 4096) : type === "ecdsa" ? (Number(input.bits) === 384 ? 384 : 256) : undefined;
      const passphrase = typeof input.passphrase === "string" && input.passphrase ? input.passphrase : undefined;
      const label = clean(input.label, 120) || `${type} key`;
      const { privateKey } = keys.generate(type, bits, passphrase, label);
      const facts = keys.inspect(privateKey, passphrase);
      const key: StoredKey = {
        id: randomUUID(),
        label,
        ...facts,
        privateKey: box.seal(privateKey),
        ...(passphrase ? { passphrase: box.seal(passphrase) } : {}),
        createdAt: Date.now(),
      };
      data.keys.push(key);
      save();
      return keyView(key);
    },
    renameKey(id: string, label: unknown) {
      const key = findKey(id);
      key.label = clean(label, 120) || key.label;
      save();
      return keyView(key);
    },
    deleteKey(id: string) {
      findKey(id);
      if (data.hosts.some((host) => host.keyId === id) || data.identities.some((identity) => identity.keyId === id)) {
        throw new SshError("key_in_use", 409);
      }
      data.keys = data.keys.filter((item) => item.id !== id);
      save();
    },
    /** The private key itself, for "export". Only on an explicit request from the page. */
    exportPrivateKey(id: string): string {
      return privateKeyOf(findKey(id));
    },

    saveIdentity(input: { id?: string; label: unknown; username: unknown; password?: unknown; keyId?: unknown }): SshIdentityView {
      const username = clean(input.username, 120);
      if (!username) throw new SshError("username_required");
      const keyId = optionalRef(data.keys, input.keyId, "unknown_key");
      const existing = input.id ? data.identities.find((item) => item.id === input.id) : undefined;
      if (input.id && !existing) throw new SshError("unknown_identity", 404);
      const identity: StoredIdentity = existing ?? { id: randomUUID(), label: "", username };
      identity.label = clean(input.label, 120) || username;
      identity.username = username;
      if (keyId) identity.keyId = keyId;
      else delete identity.keyId;
      if (typeof input.password === "string") {
        if (input.password) identity.password = box.seal(input.password);
        else delete identity.password;
      }
      if (!existing) data.identities.push(identity);
      save();
      return identityView(identity);
    },
    deleteIdentity(id: string) {
      if (data.hosts.some((host) => host.identityId === id)) throw new SshError("identity_in_use", 409);
      data.identities = data.identities.filter((item) => item.id !== id);
      save();
    },

    // ---------- snippets ----------
    saveSnippet(input: { id?: string; label: unknown; command: unknown; run?: unknown; tags?: unknown; kind?: unknown }): SshSnippet {
      const command = typeof input.command === "string" ? input.command.replace(/\r\n/g, "\n").slice(0, 20_000) : "";
      if (!command.trim()) throw new SshError("command_required");
      const existing = input.id ? data.snippets.find((item) => item.id === input.id) : undefined;
      if (input.id && !existing) throw new SshError("unknown_snippet", 404);
      const snippet: SshSnippet = {
        id: existing?.id ?? randomUUID(),
        label: clean(input.label, 120) || command.split("\n")[0].slice(0, 60),
        command,
        run: input.run !== false,
        tags: tagsOf(input.tags),
        ...(input.kind === "linux" || input.kind === "windows" || input.kind === "python" ? { kind: input.kind } : {}),
        createdAt: existing?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
      };
      if (existing && !snippet.kind) delete existing.kind;
      if (existing) Object.assign(existing, snippet);
      else data.snippets.push(snippet);
      save();
      return snippet;
    },
    deleteSnippet(id: string) {
      if (data.tasks.some((task) => task.snippetId === id)) throw new SshError("snippet_in_use", 409);
      data.snippets = data.snippets.filter((item) => item.id !== id);
      for (const host of data.hosts) if (host.startupSnippetId === id) delete host.startupSnippetId;
      save();
    },
    snippet(id: string): SshSnippet {
      const snippet = data.snippets.find((item) => item.id === id);
      if (!snippet) throw new SshError("unknown_snippet", 404);
      return snippet;
    },

    // ---------- tasks ----------
    saveTask(input: { id?: unknown; name?: unknown; hostId?: unknown; dir?: unknown; snippetId?: unknown; tags?: unknown }): SshTask {
      const host = findHost(String(input.hostId ?? ""));
      const snippetId = String(input.snippetId ?? "");
      const snippet = data.snippets.find((item) => item.id === snippetId);
      if (!snippet) throw new SshError("snippet_required");
      const dir = clean(input.dir, 1000);
      if (/[\0\r\n]/.test(dir)) throw new SshError("bad_dir");
      const existing = input.id ? data.tasks.find((item) => item.id === input.id) : undefined;
      if (input.id && !existing) throw new SshError("unknown_task", 404);
      const now = Date.now();
      const task: SshTask = {
        id: existing?.id ?? randomUUID(),
        name: clean(input.name, 120) || `${snippet.label} @ ${host.label}`,
        hostId: host.id,
        dir,
        snippetId,
        tags: tagsOf(input.tags),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      if (existing) Object.assign(existing, task);
      else data.tasks.push(task);
      save();
      return task;
    },
    deleteTask(id: string) {
      data.tasks = data.tasks.filter((item) => item.id !== id);
      save();
    },
    task(id: string): SshTask {
      const task = data.tasks.find((item) => item.id === id);
      if (!task) throw new SshError("unknown_task", 404);
      return task;
    },

    // ---------- port forwarding ----------
    saveForward(input: Partial<SshForward>): SshForward {
      findHost(String(input.hostId ?? ""));
      const type = input.type === "remote" || input.type === "dynamic" ? input.type : "local";
      const existing = input.id ? data.forwards.find((item) => item.id === input.id) : undefined;
      if (input.id && !existing) throw new SshError("unknown_forward", 404);
      const forward: SshForward = {
        id: existing?.id ?? randomUUID(),
        label: clean(input.label, 120),
        hostId: String(input.hostId),
        type,
        bindHost: clean(input.bindHost, 255) || (type === "remote" ? "localhost" : "127.0.0.1"),
        bindPort: portOf(input.bindPort, 0),
        destHost: type === "dynamic" ? "" : clean(input.destHost, 255) || "localhost",
        destPort: type === "dynamic" ? 0 : portOf(input.destPort, 0),
        autoStart: input.autoStart === true,
      };
      if (!forward.label) forward.label = type === "dynamic" ? `SOCKS ${forward.bindPort}` : `${forward.bindPort} → ${forward.destHost}:${forward.destPort}`;
      if (existing) Object.assign(existing, forward);
      else data.forwards.push(forward);
      save();
      return forward;
    },
    deleteForward(id: string) {
      data.forwards = data.forwards.filter((item) => item.id !== id);
      save();
    },
    forward(id: string): SshForward {
      const forward = data.forwards.find((item) => item.id === id);
      if (!forward) throw new SshError("unknown_forward", 404);
      return forward;
    },

    // ---------- known hosts ----------
    knownHost(address: string): SshKnownHost | undefined {
      return data.knownHosts.find((item) => item.address === address);
    },
    trustHostKey(address: string, keyType: string, fingerprint: string) {
      data.knownHosts = data.knownHosts.filter((item) => item.address !== address);
      data.knownHosts.push({ address, keyType, fingerprint, addedAt: Date.now() });
      save();
    },
    forgetHostKey(address: string) {
      data.knownHosts = data.knownHosts.filter((item) => item.address !== address);
      save();
    },

    /** The connection details with secrets opened, following jump hosts. */
    target(id: string, seen: Set<string> = new Set()): SshTarget {
      if (seen.has(id)) throw new SshError("jump_loop");
      seen.add(id);
      const host = findHost(id);
      let username = host.username;
      let password = host.password ? box.unseal(host.password) : undefined;
      let keyRecord = host.auth === "key" && host.keyId ? findKey(host.keyId) : undefined;
      if (host.auth === "identity" && host.identityId) {
        const identity = data.identities.find((item) => item.id === host.identityId);
        if (!identity) throw new SshError("unknown_identity", 404);
        username = identity.username || username;
        password = identity.password ? box.unseal(identity.password) : undefined;
        keyRecord = identity.keyId ? findKey(identity.keyId) : undefined;
      }
      if (!username) throw new SshError("username_required");
      const startup = host.startupSnippetId ? data.snippets.find((item) => item.id === host.startupSnippetId) : undefined;
      return {
        hostId: host.id,
        label: host.label,
        host: host.host,
        port: host.port,
        username,
        ...(host.auth === "password" || host.auth === "identity" ? (password ? { password } : {}) : {}),
        ...(keyRecord
          ? { privateKey: privateKeyOf(keyRecord), ...(keyRecord.passphrase ? { passphrase: box.unseal(keyRecord.passphrase) } : {}) }
          : {}),
        useAgent: host.auth === "agent",
        keepAlive: host.keepAlive,
        backspace: host.backspace ?? "del",
        ...(startup ? { startup } : {}),
        ...(host.jumpHostId ? { jump: this.target(host.jumpHostId, seen) } : {}),
      };
    },

    /** Hosts from an OpenSSH config. Keys named by IdentityFile are added as file references. Returns what was added. */
    importConfig(text: string, home: string): { hosts: number; keys: number; skipped: string[] } {
      const blocks = parseSshConfig(text);
      let hostCount = 0;
      let keyCount = 0;
      const skipped: string[] = [];
      const added = new Map<string, string>();
      for (const block of blocks) {
        const address = block.hostName || block.alias;
        if (data.hosts.some((host) => host.label === block.alias || (host.host === address && host.port === (block.port ?? 22) && host.username === (block.user ?? "")))) {
          skipped.push(block.alias);
          continue;
        }
        let keyId: string | undefined;
        if (block.identityFile) {
          const file = block.identityFile.replace(/^~(?=[\\/])/, home);
          try {
            const key = this.importKeyFile(file, path.basename(file));
            keyId = key.id;
            keyCount += 1;
          } catch {
            /* an encrypted or missing key: the host is still added, with password sign-in */
          }
        }
        const view = this.saveHost({
          label: block.alias,
          host: address,
          port: block.port ?? 22,
          username: block.user ?? "",
          auth: keyId ? "key" : "password",
          ...(keyId ? { keyId } : {}),
          tags: ["ssh_config"],
        });
        added.set(block.alias, view.id);
        hostCount += 1;
      }
      // ProxyJump names another Host alias.
      for (const block of blocks) {
        const id = added.get(block.alias);
        const jump = block.proxyJump && (added.get(block.proxyJump) ?? data.hosts.find((host) => host.label === block.proxyJump)?.id);
        if (id && jump && jump !== id) {
          const host = data.hosts.find((item) => item.id === id);
          if (host) host.jumpHostId = jump;
        }
      }
      save();
      return { hosts: hostCount, keys: keyCount, skipped };
    },
  };
}

export type SshStore = ReturnType<typeof createSshStore>;

export interface SshConfigBlock {
  alias: string;
  hostName?: string;
  user?: string;
  port?: number;
  identityFile?: string;
  proxyJump?: string;
}

/** The plain `Host` blocks of an OpenSSH config; wildcard patterns (`Host *`) are left out. */
export function parseSshConfig(text: string): SshConfigBlock[] {
  const blocks: SshConfigBlock[] = [];
  let current: SshConfigBlock[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const match = line.match(/^(\S+?)(?:\s*=\s*|\s+)(.+)$/);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim().replace(/^"(.*)"$/, "$1");
    if (key === "host") {
      current = value
        .split(/\s+/)
        .filter((alias) => !/[*?!]/.test(alias))
        .map((alias) => ({ alias }));
      blocks.push(...current);
      continue;
    }
    if (key === "match") {
      current = [];
      continue;
    }
    for (const block of current) {
      if (key === "hostname" && !block.hostName) block.hostName = value;
      else if (key === "user" && !block.user) block.user = value;
      else if (key === "port" && !block.port) block.port = Number(value) || undefined;
      else if (key === "identityfile" && !block.identityFile) block.identityFile = value;
      else if (key === "proxyjump" && !block.proxyJump) block.proxyJump = value.split(",")[0].trim();
    }
  }
  return blocks;
}
