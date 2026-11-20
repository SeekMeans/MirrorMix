import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * How long a sign-in lasts without use. Using the page moves the end out again (see `renew`), so someone working
 * stays signed in, and a page left alone signs out an hour after its last use. The cookie carries the same lifetime.
 */
export const LOGIN_LIFETIME_MS = 60 * 60_000;

/** Renewed at most this often, so polling does not rewrite the file on every request. */
export const LOGIN_RENEW_STEP_MS = 60_000;

/** Input this recent counts as using the page; an open tab that only polls does not keep the sign-in alive. */
export const ACTIVE_WINDOW_MS = 10 * 60_000;

interface Entry {
  username: string;
  expiresAt: number;
}

export interface LoginSessions {
  has(token: string): boolean;
  add(token: string, username: string): void;
  delete(token: string): void;
  /** Pushes a valid sign-in's end out to a full lifetime from now. True when it moved (send the cookie again). */
  renew(token: string): boolean;
}

/** Only a hash of each token is kept, so the file alone cannot sign anyone in. */
function hash(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

/**
 * Sign-ins that survive a server restart (`npm run dev` restarts on every edit). Without a file they live in memory only.
 */
export function createLoginSessions(file?: string, now: () => number = Date.now): LoginSessions {
  const entries = new Map<string, Entry>();
  let capped = false;
  if (file) {
    try {
      const saved = JSON.parse(readFileSync(file, "utf8")) as Record<string, Entry>;
      for (const [key, entry] of Object.entries(saved)) {
        if (entry && typeof entry.username === "string" && typeof entry.expiresAt === "number" && entry.expiresAt > now()) {
          // Sign-ins saved under a longer lifetime get no more than the current one.
          const limit = now() + LOGIN_LIFETIME_MS;
          if (entry.expiresAt > limit) capped = true;
          entries.set(key, { username: entry.username, expiresAt: Math.min(entry.expiresAt, limit) });
        }
      }
    } catch {
      /* no file yet, or unreadable: start signed out */
    }
  }
  const save = () => {
    if (!file) return;
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      const temp = `${file}.tmp`;
      writeFileSync(temp, JSON.stringify(Object.fromEntries(entries)), { mode: 0o600 });
      renameSync(temp, file);
    } catch (error) {
      console.warn(`[login] could not save sign-ins: ${(error as Error).message}`);
    }
  };
  if (capped) save();
  const prune = () => {
    let changed = false;
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= now()) {
        entries.delete(key);
        changed = true;
      }
    }
    return changed;
  };
  return {
    has(token) {
      const entry = entries.get(hash(token));
      if (!entry) return false;
      if (entry.expiresAt > now()) return true;
      entries.delete(hash(token));
      save();
      return false;
    },
    add(token, username) {
      prune();
      entries.set(hash(token), { username, expiresAt: now() + LOGIN_LIFETIME_MS });
      save();
    },
    delete(token) {
      if (entries.delete(hash(token)) || prune()) save();
    },
    renew(token) {
      const entry = entries.get(hash(token));
      if (!entry || entry.expiresAt <= now()) return false;
      const next = now() + LOGIN_LIFETIME_MS;
      if (next - entry.expiresAt < LOGIN_RENEW_STEP_MS) return false;
      entry.expiresAt = next;
      save();
      return true;
    },
  };
}
