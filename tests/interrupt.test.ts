import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createSupervisor } from "../src/process/supervisor";
import type { LaunchRequest } from "../src/shared/types";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "interrupt-"));
  const codexSessionsDir = path.join(root, "sessions");
  const claudeProjectsDir = path.join(root, "projects");
  mkdirSync(codexSessionsDir);
  mkdirSync(path.join(claudeProjectsDir, "fixture"), { recursive: true });
  writeFileSync(
    path.join(codexSessionsDir, "thread.jsonl"),
    [
      { type: "session_meta", payload: { id: "codex-thread", cwd: root } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Codex title" }] } },
    ].map((row) => JSON.stringify(row)).join("\n"),
  );
  writeFileSync(
    path.join(claudeProjectsDir, "fixture", "claude-thread.jsonl"),
    JSON.stringify({ type: "user", sessionId: "claude-thread", cwd: root, message: { role: "user", content: "Claude title" } }),
  );
  return { roots: { codexSessionsDir, claudeProjectsDir, claudeDataDir: "" } };
}

describe("stopping a reply from the page", () => {
  it("presses Esc in MirrorMix's own terminal", async () => {
    const f = fixture();
    const writes: string[] = [];
    const spawn = vi.fn((_spec: LaunchRequest) => ({ pid: 1, write: (data: string) => void writes.push(data), resize() {}, kill() {}, onData() {}, onExit() {} }));
    const supervisor = createSupervisor({ roots: f.roots, bins: { claudeExe: "claude.exe", nodeExe: "node.exe", codexJs: "codex.js" }, spawn, listProcesses: () => [] });
    try {
      supervisor.open("codex", "codex-thread");
      await supervisor.interrupt("codex", "codex-thread");
      expect(writes.at(-1)).toBe("\u001b");
    } finally {
      supervisor.dispose();
    }
  });

  it("clicks Stop in the desktop window, and says so when nothing is running there", async () => {
    const f = fixture();
    const stopDesktop = vi.fn(async () => {});
    const supervisor = createSupervisor({
      roots: f.roots,
      bins: { claudeExe: "", nodeExe: "", codexJs: "" },
      desktopOnly: true,
      spawn: vi.fn(() => {
        throw new Error("CLI must never start");
      }),
      listProcesses: () => [],
      submitDesktop: async () => {},
      stopDesktop,
      desktopSession: () => ({ title: "Native Claude title" }),
    });
    try {
      supervisor.open("claude", "claude-thread");
      await supervisor.interrupt("claude", "claude-thread");
      expect(stopDesktop).toHaveBeenCalledWith("Native Claude title");
      stopDesktop.mockRejectedValueOnce(new Error("idle"));
      await expect(supervisor.interrupt("claude", "claude-thread")).rejects.toMatchObject({ status: 409, code: "not_running" });
    } finally {
      supervisor.dispose();
    }
  });
});
