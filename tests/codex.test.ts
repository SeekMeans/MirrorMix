import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { indexSessions, readCatalog } from "../src/catalog/readCatalog";
import { codexDesktopSession } from "../src/catalog/codexDesktop";

const NL = String.fromCharCode(10);

describe("Codex list", () => {
  it("does not mistake indexed CLI history for a desktop sidebar conversation", () => {
    const home = mkdtempSync(path.join(tmpdir(), "codex-desktop-origin-"));
    const sessions = path.join(home, "sessions");
    mkdirSync(sessions);
    writeFileSync(path.join(home, ".codex-global-state.json"), "{}");
    writeFileSync(path.join(home, "session_index.jsonl"), JSON.stringify({ id: "cli", thread_name: "Indexed CLI title" }));
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require(["node", "sqlite"].join(":"));
    const db = new DatabaseSync(path.join(home, "state_5.sqlite"));
    db.exec("CREATE TABLE threads (id TEXT, title TEXT, name TEXT, source TEXT)");
    const add = db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?)");
    add.run("cli", "CLI first message", null, "cli");
    add.run("exec", "Exec first message", null, "exec");
    add.run("desktop", "First message", "Desktop title", "vscode");
    add.run("imported", "CLI first message", "Named in desktop", "cli");
    db.close();
    expect(codexDesktopSession(sessions, "cli")).toBeNull();
    expect(codexDesktopSession(sessions, "exec")).toBeNull();
    expect(codexDesktopSession(sessions, "desktop")).toEqual({ title: "Desktop title" });
    expect(codexDesktopSession(sessions, "imported")).toEqual({ title: "Named in desktop" });
  });

  it.each([false, true])("lists a resumed thread once (database available: %s)", async (withDatabase) => {
    const { utimesSync } = await import("node:fs");
    const home = mkdtempSync(path.join(tmpdir(), "aimiss-codex-resume-"));
    const sessions = path.join(home, "sessions");
    mkdirSync(sessions, { recursive: true });
    const older = path.join(sessions, "a-original.jsonl");
    const newer = path.join(sessions, "b-resumed.jsonl");
    for (const [file, message] of [[older, "original"], [newer, "resumed"]]) {
      writeFileSync(file, [
        JSON.stringify({ type: "session_meta", payload: { id: "same-thread", cwd: home } }),
        JSON.stringify({ type: "event_msg", payload: { type: "user_message", message } }),
      ].join(NL));
    }
    utimesSync(older, 100, 100);
    utimesSync(newer, 200, 200);
    if (withDatabase) {
      writeFileSync(path.join(home, ".codex-global-state.json"), "{}");
      const require = createRequire(import.meta.url);
      const { DatabaseSync } = require(["node", "sqlite"].join(":"));
      const db = new DatabaseSync(path.join(home, "state_5.sqlite"));
      db.exec("CREATE TABLE threads (id TEXT, rollout_path TEXT)");
      db.prepare("INSERT INTO threads VALUES (?, ?)").run("same-thread", older);
      db.close();
    }
    const roots = { claudeProjectsDir: "", claudeDataDir: "", codexSessionsDir: sessions };
    const indexed = indexSessions(roots).codex;
    expect(indexed).toHaveLength(1);
    expect(indexed[0].filePath).toBe(withDatabase ? older : newer);
    expect(readCatalog(roots).codex[0].sessions.map((session) => session.title)).toEqual([withDatabase ? "original" : "resumed"]);
  });

  it("resolves project IDs to all their roots and honors explicit local thread assignments", () => {
    const home = mkdtempSync(path.join(tmpdir(), "aimiss-codex-projects-"));
    const sessions = path.join(home, "sessions");
    const alpha = path.join(home, "alpha");
    const beta = path.join(home, "beta");
    const extra = path.join(home, "beta-extra");
    const missing = path.join(home, "removed-project");
    for (const dir of [sessions, alpha, beta, extra]) mkdirSync(dir, { recursive: true });
    const thread = (id: string, cwd: string) => writeFileSync(path.join(sessions, `${id}.jsonl`), [
      JSON.stringify({ type: "session_meta", payload: { id, cwd } }),
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: id } }),
    ].join(NL));
    thread("alpha-thread", alpha);
    thread("assigned-thread", path.join(alpha, "nested"));
    thread("extra-thread", extra);
    thread("projectless-thread", beta);
    thread("unassigned-nested", path.join(alpha, "other"));
    thread("remote-thread", path.join(home, "remote"));
    writeFileSync(path.join(home, ".codex-global-state.json"), JSON.stringify({
      "project-order": ["beta-id", "unknown-id", alpha, "alpha-id", "removed-id", "malformed-id"],
      "local-projects": {
        "alpha-id": { id: "alpha-id", rootPaths: [alpha] },
        "beta-id": { id: "beta-id", rootPaths: [beta, extra] },
        "removed-id": { id: "removed-id", rootPaths: [missing] },
        "malformed-id": { rootPaths: [null, 42, "not-a-path"] },
      },
      "electron-saved-workspace-roots": [extra, alpha, beta],
      "thread-project-assignments": {
        "ASSIGNED-THREAD": { projectKind: "local", projectId: "beta-id" },
        "projectless-thread": { projectKind: "local", projectId: "alpha-id" },
        "remote-thread": { projectKind: "remote", projectId: "beta-id" },
      },
      "projectless-thread-ids": ["projectless-thread"],
      "thread-workspace-root-hints": { "projectless-thread": home },
    }));
    const groups = readCatalog({ claudeProjectsDir: "", claudeDataDir: "", codexSessionsDir: sessions }).codex;
    expect(groups.map((group) => [group.path, group.missing, group.sessions.map((session) => session.id)])).toEqual([
      [beta, false, ["assigned-thread"]],
      [extra, false, ["extra-thread"]],
      [alpha, false, ["alpha-thread"]],
      [missing, true, []],
      [home, false, ["projectless-thread"]],
    ]);
    expect(groups.at(-1)?.label).toBe("任务");
  });

  it("lists projects from custom sidebar sections in the same flat project list", () => {
    const home = mkdtempSync(path.join(tmpdir(), "aimiss-codex-sections-"));
    const sessions = path.join(home, "sessions");
    const work = path.join(home, "work");
    const study = path.join(home, "study");
    const ordinary = path.join(home, "ordinary");
    const sectionOnly = path.join(home, "section-only");
    for (const dir of [sessions, work, study, ordinary, sectionOnly]) mkdirSync(dir);
    writeFileSync(path.join(sessions, "thread.jsonl"), [
      JSON.stringify({ type: "session_meta", payload: { id: "thread", cwd: path.join(work, "nested") } }),
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Under work" } }),
    ].join(NL));
    writeFileSync(path.join(home, ".codex-global-state.json"), JSON.stringify({
      "electron-renderer-content-owner": "current",
      "electron-owner-atoms:current": { "sidebar-custom-sections-v3": { workspace: {
        sections: [
          { id: "work", name: "工作", itemKeys: ["codex:project:work-root", "codex:project:section-only", "codex:thread:thread"] },
          { id: "study", name: "学习", itemKeys: ["codex:project:study-db", "codex:project:missing"] },
        ],
      } } },
      "electron-owner-atoms:other": { "sidebar-custom-sections-v3": { other: {
        sections: [{ id: "other", name: "其他帐号", itemKeys: ["codex:project:ordinary"] }],
      } } },
      "project-order": ["ordinary"],
      "local-projects": {
        "work-root": { name: "旧项目名", rootPaths: [work] },
        "section-only": { name: "仅在自定义分区", rootPaths: [sectionOnly] },
        ordinary: { name: "常规", rootPaths: [ordinary] },
      },
      "app-server-project-id-by-legacy-project-id-by-host": { host: { "work-root": "work-db" } },
      "thread-project-assignments": { thread: { projectKind: "local", projectId: "work-db" } },
    }));
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require(["node", "sqlite"].join(":"));
    const db = new DatabaseSync(path.join(home, "state_5.sqlite"));
    try {
      db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, position INTEGER); CREATE TABLE project_roots (project_id TEXT, path TEXT, position INTEGER)");
      db.prepare("INSERT INTO projects VALUES (?, ?, ?), (?, ?, ?)").run("work-db", "新项目名", 0, "study-db", "学习项目", 1);
      db.prepare("INSERT INTO project_roots VALUES (?, ?, ?), (?, ?, ?)").run("work-db", work, 0, "study-db", study, 0);
    } finally {
      db.close();
    }
    const groups = readCatalog({ claudeProjectsDir: "", claudeDataDir: "", codexSessionsDir: sessions }).codex;
    expect(groups.map(({ path, projectName, sessions }) => [path, projectName, sessions.map((session) => session.id)])).toEqual([
      [ordinary, "常规", []],
      [work, "新项目名", ["thread"]],
      [sectionOnly, "仅在自定义分区", []],
      [study, "学习项目", []],
    ]);
  });

  it("follows the desktop app: its names, its projects in its order, and nothing the app does not list", () => {
    const home = mkdtempSync(path.join(tmpdir(), "aimiss-codex-"));
    const sessions = path.join(home, "sessions", "2026", "11", "11");
    mkdirSync(sessions, { recursive: true });
    const alpha = path.join(home, "work", "alpha");
    const beta = path.join(home, "work", "beta");
    const empty = path.join(home, "work", "empty");
    const elsewhere = path.join(home, "work", "alpha", "nested");
    const chats = path.join(home, "chats");
    for (const dir of [alpha, beta, empty, elsewhere, chats]) mkdirSync(dir, { recursive: true });

    const thread = (id: string, cwd: string, firstWords: string) =>
      writeFileSync(
        path.join(sessions, `rollout-2026-11-11T00-00-00-${id}.jsonl`),
        [
          JSON.stringify({ type: "session_meta", payload: { id, cwd } }),
          JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: firstWords } }),
        ].join(NL),
      );
    const ids = {
      renamed: "00000000-0000-4000-8000-000000000001",
      older: "00000000-0000-4000-8000-000000000002",
      beta: "00000000-0000-4000-8000-000000000003",
      sub: "00000000-0000-4000-8000-000000000004",
      archived: "00000000-0000-4000-8000-000000000005",
      nested: "00000000-0000-4000-8000-000000000006",
      chat: "00000000-0000-4000-8000-000000000007",
    };
    thread(ids.renamed, alpha, "第一句话很长很长");
    thread(ids.older, alpha, "更早的一条");
    thread(ids.beta, beta, "beta 里的会话");
    thread(ids.sub, alpha, "子代理的任务");
    thread(ids.archived, alpha, "已归档的会话");
    thread(ids.nested, elsewhere, "子目录里的会话");
    thread(ids.chat, path.join(chats, "2026-11-11", "new-chat"), "不属于项目的对话");

    writeFileSync(
      path.join(home, ".codex-global-state.json"),
      JSON.stringify({
        "project-order": [beta, empty, alpha],
        "electron-saved-workspace-roots": [alpha, beta, empty],
        "projectless-thread-ids": [ids.chat],
        "thread-workspace-root-hints": { [ids.chat]: chats },
        "pinned-thread-ids": [ids.beta],
      }),
    );
    writeFileSync(
      path.join(home, "session_index.jsonl"),
      [
        JSON.stringify({ id: ids.renamed, thread_name: "自动起的名字" }),
        JSON.stringify({ id: ids.renamed, thread_name: "改过的名字" }),
      ].join(NL),
    );

    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require(["node", "sqlite"].join(":")) as {
      DatabaseSync: new (location: string) => {
        exec(sql: string): void;
        prepare(sql: string): { run(...args: unknown[]): unknown };
        close(): void;
      };
    };
    const db = new DatabaseSync(path.join(home, "state_5.sqlite"));
    db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, name TEXT, source TEXT, thread_source TEXT, archived INTEGER, recency_at INTEGER, updated_at INTEGER)");
    const insert = db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    insert.run(ids.renamed, "第一句话很长很长", null, "vscode", "user", 0, 200, 200);
    insert.run(ids.older, "库里的标题", null, "vscode", "user", 0, 100, 100);
    insert.run(ids.beta, "beta 里的会话", null, "vscode", "user", 0, 150, 150);
    insert.run(ids.sub, "", null, '{"subagent":{"thread_spawn":{}}}', "subagent", 0, 300, 300);
    insert.run(ids.archived, "已归档的会话", null, "vscode", "user", 1, 250, 250);
    insert.run(ids.nested, "子目录里的会话", null, "vscode", "user", 0, 120, 120);
    insert.run(ids.chat, "不属于项目的对话", null, "vscode", "user", 0, 110, 110);
    db.close();

    const groups = readCatalog({ claudeProjectsDir: path.join(home, "none"), codexSessionsDir: path.join(home, "sessions"), claudeDataDir: "" }).codex;
    expect(
      groups.map((group) => [group.label ?? path.basename(group.path), group.sessions.map((session) => session.title)]),
    ).toEqual([
      ["beta", ["beta 里的会话"]],
      ["empty", []],
      ["alpha", ["改过的名字", "库里的标题"]],
      ["任务", ["不属于项目的对话"]],
    ]);
    expect(groups[0].sessions[0].pinned).toBe(true);
  });
});

describe("Codex CLI behind the desktop app's config", () => {
  const refusal =
    "Error loading config.toml: unknown variant `priority`, expected `fast` or `flex`\r\nin `service_tier`\u001b]0;C:\node.exe\u0007";

  it("reads the override the CLI needs out of its own error", async () => {
    const { codexConfigFix, exitNote } = await import("../src/process/launch");
    expect(codexConfigFix(refusal)).toEqual(["-c", 'service_tier="fast"']);
    expect(codexConfigFix("Welcome to Codex")).toBeNull();
    expect(codexConfigFix("Error: this CLI has no complete local package; install a packaged Codex CLI or use the standalone installer")).toEqual(["--no-daemon"]);
    expect(exitNote(refusal)).toBe("Error loading config.toml: unknown variant `priority`, expected `fast` or `flex` in `service_tier`");
  });

  it.each([
    [refusal, ["-c", 'service_tier="fast"'], "service_tier"],
    ["Error: this CLI has no complete local package; install a packaged Codex CLI or use the standalone installer", ["--no-daemon"], "no complete local package"],
  ] as const)("retries a CLI startup refusal: %s", async (errorOutput, fix, note) => {
    const { createSupervisor } = await import("../src/process/supervisor");
    const home = mkdtempSync(path.join(tmpdir(), "aimiss-codex-run-"));
    const sessions = path.join(home, "sessions");
    const cwd = path.join(home, "work");
    mkdirSync(sessions, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    const id = "00000000-0000-4000-8000-0000000000aa";
    writeFileSync(
      path.join(sessions, `rollout-2026-11-11T00-00-00-${id}.jsonl`),
      [
        JSON.stringify({ type: "session_meta", payload: { id, cwd } }),
        JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "你好" } }),
      ].join(NL),
    );
    const launches: string[][] = [];
    const exits: Array<() => void> = [];
    const outputs: Array<(data: string) => void> = [];
    const supervisor = createSupervisor({
      bins: { claudeExe: "claude.exe", nodeExe: "node.exe", codexJs: "codex.js" },
      roots: { claudeProjectsDir: path.join(home, "none"), codexSessionsDir: sessions, claudeDataDir: "" },
      listProcesses: () => [],
      spawn: (spec) => {
        launches.push(spec.args);
        return {
          pid: 100 + launches.length,
          write() {},
          resize() {},
          kill() {},
          onData: (callback) => void outputs.push(callback),
          onExit: (callback) => void exits.push(() => callback(1)),
        };
      },
    });

    expect(supervisor.open("codex", id).status).toBe("running");
    outputs[0](errorOutput);
    exits[0]();
    expect(launches).toEqual([
      ["codex.js", "resume", id],
      ["codex.js", ...fix, "resume", id],
    ]);
    expect(supervisor.getSession("codex", id).status).toBe("running");

    // A second refusal is not retried again; the page is told what the process said.
    outputs[1](errorOutput);
    exits[1]();
    const stopped = supervisor.getSession("codex", id);
    expect(launches).toHaveLength(2);
    expect(stopped.status).toBe("exited");
    expect(stopped.exitNote).toContain(note);
    supervisor.dispose();
  });
});
