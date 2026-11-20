/**
 * The SSH plugin's data, as the page sees it. Secrets (passwords, private keys, passphrases) never leave the
 * server: the page only learns whether one is set.
 */

export interface SshGroup {
  id: string;
  name: string;
  /** Nested groups, like Termius. Absent at the top. */
  parentId?: string;
}

export type SshAuth = "password" | "key" | "identity" | "agent";

export interface SshHostView {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  groupId?: string;
  tags: string[];
  /** Accent shown on the host's card. */
  color?: string;
  auth: SshAuth;
  /** A password is saved for this host. */
  hasPassword: boolean;
  keyId?: string;
  identityId?: string;
  /** Connect through this host first (ProxyJump). */
  jumpHostId?: string;
  /** Snippet run once the shell is up. */
  startupSnippetId?: string;
  /** Seconds between keep-alive packets; 0 turns them off. */
  keepAlive: number;
  /** Text sent to the terminal for Backspace: "\x7f" (most systems) or "\b". */
  backspace?: "del" | "bs";
  /** Characters set for the shell, such as UTF-8. */
  charset?: string;
  notes?: string;
  createdAt: number;
  lastConnectedAt?: number;
}

export interface SshKeyView {
  id: string;
  label: string;
  /** "ssh-ed25519", "ssh-rsa", … */
  type: string;
  /** OpenSSH public line, to copy into authorized_keys. */
  publicKey: string;
  /** SHA256 fingerprint of the public key. */
  fingerprint: string;
  hasPassphrase: boolean;
  /** Read from this file on each use instead of kept here (imported from ~/.ssh). */
  file?: string;
  createdAt: number;
}

export interface SshIdentityView {
  id: string;
  label: string;
  username: string;
  hasPassword: boolean;
  keyId?: string;
}

export interface SshSnippet {
  id: string;
  label: string;
  /** Sent to the shell as typed; a trailing newline runs it. */
  command: string;
  /** Press Enter after pasting it. */
  run: boolean;
  tags: string[];
}

export type SshForwardType = "local" | "remote" | "dynamic";

export interface SshForward {
  id: string;
  label: string;
  hostId: string;
  type: SshForwardType;
  /** Where the listening end is: this machine for local/dynamic, the server for remote. */
  bindHost: string;
  bindPort: number;
  /** Where the traffic goes. Unused for dynamic (SOCKS chooses). */
  destHost: string;
  destPort: number;
  /** Start with MirrorMix. */
  autoStart: boolean;
}

export interface SshForwardState {
  id: string;
  state: "off" | "starting" | "on" | "error";
  message?: string;
  connections: number;
}

export interface SshKnownHost {
  /** "host:port". */
  address: string;
  keyType: string;
  /** "SHA256:…". */
  fingerprint: string;
  addedAt: number;
}

export interface SshSessionInfo {
  /** Terminal id in the hub. */
  tid: string;
  hostId: string;
  label: string;
  createdAt: string;
}

export interface SshState {
  groups: SshGroup[];
  hosts: SshHostView[];
  keys: SshKeyView[];
  identities: SshIdentityView[];
  snippets: SshSnippet[];
  forwards: SshForward[];
  forwardStates: SshForwardState[];
  knownHosts: SshKnownHost[];
  sessions: SshSessionInfo[];
}

/** What the page sends to add or change a host. A password of "" clears it; absent keeps it. */
export interface SshHostInput {
  id?: string;
  label: string;
  host: string;
  port?: number;
  username?: string;
  groupId?: string | null;
  tags?: string[];
  color?: string | null;
  auth: SshAuth;
  password?: string;
  keyId?: string | null;
  identityId?: string | null;
  jumpHostId?: string | null;
  startupSnippetId?: string | null;
  keepAlive?: number;
  backspace?: "del" | "bs";
  charset?: string;
  notes?: string;
}

/** A host key the server showed that is not trusted yet (or changed). The page asks before going on. */
export interface SshHostKeyQuestion {
  address: string;
  keyType: string;
  fingerprint: string;
  /** Set when a different key was trusted before: possibly someone in between. */
  previous?: string;
}

export interface SftpEntry {
  name: string;
  dir: boolean;
  link: boolean;
  size: number;
  mtime: number;
  /** "rwxr-xr-x" style. */
  mode: string;
}
