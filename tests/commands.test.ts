import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createCommandStore, prepareShortcut } from "../src/settings/commandStore";
import { DEFAULT_SHORTCUTS } from "../src/shared/shortcuts";
import { createApp, listenLocal } from "../src/server/app";
import { createSupervisor } from "../src/process/supervisor";

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "mirrormix-commands-"));
  const file = path.join(dir, "commands.json");
  return { dir, file, store: createCommandStore(file) };
}

describe("global command library", () => {
  it("initializes a three-field JSON file and reloads manual edits", () => {
    const { file, store } = fixture();
    const first = store.read();
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(DEFAULT_SHORTCUTS);
    expect(first.commands[0]).toMatchObject({ group: "git命令包", name: "提交并推送" });
    const updated = [{ group: "通用", name: "工作目录", command: "cd" }];
    writeFileSync(file, '\uFEFF' + JSON.stringify(updated));
    const second = createCommandStore(file).read();
    expect(second.commands).toEqual(updated);
    expect(second.revision).not.toBe(first.revision);
  });

  it("persists changes globally and rejects stale browser saves or execution", () => {
    const { file, store } = fixture();
    const before = store.read();
    const entry = { group: "通用", name: "目录", command: "cd" };
    const after = store.write([...before.commands, entry], before.revision);
    expect(createCommandStore(file).read().commands).toContainEqual(entry);
    expect(() => store.write([], before.revision)).toThrow("commands_changed");
    expect(() => store.prepare(entry.group, entry.name, "", before.revision)).toThrow("commands_changed");
    expect(store.prepare(entry.group, entry.name, undefined, after.revision)).toBe("cd");
  });

  it("preserves the file when its JSON or a submitted record is invalid", () => {
    const { file, store } = fixture();
    const first = store.read();
    expect(() => store.write([first.commands[0], first.commands[0]], first.revision)).toThrow("commands_duplicate");
    expect(() => store.write([{ group: "x", name: "x", command: "echo {{unknown}}" }], first.revision)).toThrow("commands_template");
    expect(() => store.write([{ group: "x", name: "x", command: "echo a\necho b" }], first.revision)).toThrow("commands_invalid");
    expect(store.read().revision).toBe(first.revision);
    writeFileSync(file, "invalid JSON");
    expect(() => store.read()).toThrow("commands_invalid");
    expect(readFileSync(file, "utf8")).toBe("invalid JSON");
  });

  it("defaults an empty message to new and never interpolates user text into shell code", () => {
    const template = DEFAULT_SHORTCUTS[0].command;
    expect(prepareShortcut(template, "")).toContain('"bmV3"');
    const message = '更新 "A&B" %PATH% !test! | echo injected';
    const prepared = prepareShortcut(template, message);
    expect(prepared).toContain(Buffer.from(message, "utf8").toString("base64"));
    expect(prepared).not.toContain(message);
    expect(prepared).toMatch(/&& git pull && git push$/);
    expect(() => prepareShortcut(template, "a\rb")).toThrow("commands_message");
    expect(prepareShortcut("git status", undefined)).toBe("git status");
  });

  it.skipIf(process.platform !== "win32")("round-trips special characters through CMD into a real local Git commit and stops after a failed commit", () => {
    const { dir } = fixture();
    const env = { ...process.env, GIT_AUTHOR_NAME: "Shortcut test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Shortcut test", GIT_COMMITTER_EMAIL: "test@example.invalid" };
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8", windowsHide: true });
    git("init", "--quiet");
    git("config", "commit.gpgsign", "false");
    writeFileSync(path.join(dir, "fixture.txt"), "fixture");
    git("add", ".");
    const message = '更新 "A&B" %PATH% !test! ^caret^ > injected.txt | more';
    const template = 'git status >nul && git commit -m "{{message}}" && echo done>done.txt';
    const run = (value: string) => spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", prepareShortcut(template, value)], { cwd: dir, env, encoding: "utf8", windowsHide: true, windowsVerbatimArguments: true });
    const committed = run(message);
    expect(committed.status, `${committed.stderr}\n${committed.stdout}`).toBe(0);
    expect(git("log", "-1", "--format=%B").trim()).toBe(message);
    expect(existsSync(path.join(dir, "injected.txt"))).toBe(false);
    expect(existsSync(path.join(dir, "done.txt"))).toBe(true);
    const failed = spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", prepareShortcut('git status >nul && git commit -m "{{message}}" && echo bad>should-not-run.txt', "")], { cwd: dir, env, windowsHide: true, windowsVerbatimArguments: true });
    expect(failed.status).not.toBe(0);
    expect(existsSync(path.join(dir, "should-not-run.txt"))).toBe(false);
  });
});

describe("command library API", () => {
  it("requires login and same-origin writes, and prepares without executing", async () => {
    const f = fixture();
    const supervisor = createSupervisor({ bins: { claudeExe: "", codexJs: "", nodeExe: "" }, roots: { claudeProjectsDir: "", claudeDataDir: "", codexSessionsDir: "" }, listProcesses: () => [], spawn: () => { throw new Error("must not spawn"); } });
    const server = createApp(supervisor, undefined, { verify: async () => true }, undefined, undefined, undefined, undefined, f.store);
    await listenLocal(server, 0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect((await fetch(`${base}/api/commands`)).status).toBe(401);
      const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ username: "fixture", password: "fixture" }) });
      const cookie = login.headers.get("set-cookie")!.split(";")[0];
      const headers = { "content-type": "application/json", origin: base, cookie };
      const response = await fetch(`${base}/api/commands`, { headers });
      expect(response.headers.get("cache-control")).toBe("no-store");
      const library = await response.json();
      const forged = await fetch(`${base}/api/commands`, { method: "PUT", headers: { ...headers, origin: "https://other.invalid" }, body: JSON.stringify({ commands: [], revision: library.revision }) });
      expect(forged.status).toBe(403);
      const prepared = await fetch(`${base}/api/commands/prepare`, { method: "POST", headers, body: JSON.stringify({ ...library.commands[0], revision: library.revision, message: "" }) });
      expect(prepared.status).toBe(200);
      expect((await prepared.json()).command).toContain('"bmV3"');
      expect(existsSync(path.join(f.dir, ".git"))).toBe(false);
      const entries = [{ group: "通用", name: "目录", command: "cd" }];
      expect((await fetch(`${base}/api/commands`, { method: "PUT", headers, body: JSON.stringify({ commands: entries, revision: library.revision }) })).status).toBe(200);
      expect(f.store.read().commands).toEqual(entries);
    } finally { supervisor.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
