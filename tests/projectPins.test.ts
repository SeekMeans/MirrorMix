import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readCatalog } from "../src/catalog/readCatalog";
import { encodeClaudeProject } from "../src/process/launch";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require(["node", "sqlite"].join(":"));
const fixture = () => {
  const home = mkdtempSync(path.join(tmpdir(), "project-pins-"));
  const sessions = path.join(home, "sessions");
  mkdirSync(sessions);
  return { home, sessions, roots: { claudeProjectsDir: "", claudeDataDir: "", codexSessionsDir: sessions } };
};

describe("project-level pins", () => {
  it("reads Codex project IDs and old path pins, preserves multi-root projects and ignores invalid entries", () => {
    const { home, roots } = fixture();
    const alpha = path.join(home, "alpha"), beta = path.join(home, "beta"), extra = path.join(home, "extra"), ordinary = path.join(home, "ordinary");
    writeFileSync(path.join(home, ".codex-global-state.json"), JSON.stringify({
      "local-projects": { beta: { rootPaths: [beta, extra] } },
      "pinned-project-ids": ["beta", alpha, alpha.toUpperCase(), "unknown", 7, null],
      "project-order": [ordinary, "beta", alpha],
    }));
    const groups = readCatalog(roots).codex;
    expect(groups.map(group => [group.path, Boolean(group.pinned), group.sessions.length])).toEqual([
      [beta, true, 0], [extra, true, 0], [alpha, true, 0], [ordinary, false, 0],
    ]);
  });

  it("maps Codex thread pins to their assigned project even without a transcript, and refreshes after unpinning", () => {
    const { home, roots } = fixture();
    const alpha = path.join(home, "alpha"), beta = path.join(home, "beta");
    const globalFile = path.join(home, ".codex-global-state.json");
    const data = { "project-order": [alpha, beta], "pinned-thread-ids": ["PINNED"], "local-projects": { beta: { rootPaths: [beta] } }, "thread-project-assignments": { pinned: { projectKind: "local", projectId: "beta" } } };
    writeFileSync(globalFile, JSON.stringify(data));
    const db = new DatabaseSync(path.join(home, "state_5.sqlite"));
    try {
      db.exec("CREATE TABLE threads (id TEXT, cwd TEXT, archived INTEGER, source TEXT, is_pinned INTEGER)");
      const insert = db.prepare("INSERT INTO threads VALUES (?, ?, ?, 'vscode', ?)");
      insert.run("pinned", path.join(alpha, "nested"), 0, 0);
      insert.run("archived", alpha, 1, 1);
      expect(readCatalog(roots).codex.map(group => [group.path, Boolean(group.pinned)])).toEqual([[alpha, false], [beta, true]]);
      writeFileSync(globalFile, JSON.stringify({ ...data, "pinned-thread-ids": [] }));
      expect(readCatalog(roots).codex.every(group => !group.pinned)).toBe(true);
      db.prepare("UPDATE threads SET is_pinned = 1 WHERE id = ?").run("pinned");
      expect(readCatalog(roots).codex.find(group => group.path === beta)?.pinned).toBe(true);
    } finally { db.close(); }
  });

  it("promotes a Claude conversation's whole project, keeps its other conversations and handles unstar", () => {
    const { home, roots } = fixture();
    const projects = path.join(home, "claude-projects"), dataDir = path.join(home, "claude-data");
    const workspace = path.join(home, "one", "app"), other = path.join(home, "two", "app");
    mkdirSync(dataDir);
    for (const [cwd, ids] of [[workspace, ["starred", "plain"]], [other, ["other"]]] as const) {
      const dir = path.join(projects, encodeClaudeProject(cwd));
      mkdirSync(dir, { recursive: true });
      for (const id of ids) writeFileSync(path.join(dir, `${id}.jsonl`), JSON.stringify({ type: "user", cwd, message: { role: "user", content: id } }));
    }
    const starFile = path.join(dataDir, "local_star.json");
    writeFileSync(starFile, JSON.stringify({ isStarred: true, cliSessionId: "starred" }));
    const read = () => readCatalog({ ...roots, claudeProjectsDir: projects, claudeDataDir: dataDir }).claude;
    const groups = read();
    expect(groups.find(group => group.path === workspace)?.pinned).toBe(true);
    expect(groups.find(group => group.path === workspace)?.sessions.map(session => session.id).sort()).toEqual(["plain", "starred"]);
    expect(groups.find(group => group.path === other)?.pinned).not.toBe(true);
    writeFileSync(starFile, JSON.stringify({ isStarred: false, cliSessionId: "starred" }));
    expect(read().every(group => !group.pinned)).toBe(true);
  });
});
