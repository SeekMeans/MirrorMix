import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type http from "node:http";
import { describe, expect, it } from "vitest";
import { insideFolder, listFolder, sendFolderFile } from "../src/server/files";

function workspace() {
  const root = mkdtempSync(path.join(tmpdir(), "aimiss-files-"));
  const work = path.join(root, "work");
  mkdirSync(path.join(work, "src", "deep"), { recursive: true });
  writeFileSync(path.join(work, "README.md"), "# 说明");
  writeFileSync(path.join(work, "b.txt"), "b");
  writeFileSync(path.join(work, "page.html"), "<script>alert(1)</script>");
  writeFileSync(path.join(work, "src", "main.ts"), "export {};");
  writeFileSync(path.join(root, "secret.txt"), "outside");
  return { root, work };
}

/** A stand-in for the response, keeping what was written to it. */
function fakeResponse() {
  const sink = new PassThrough();
  const sent: { status?: number; headers?: Record<string, string>; body: string } = { body: "" };
  sink.on("data", (chunk) => (sent.body += String(chunk)));
  const response = Object.assign(sink, {
    writeHead(status: number, headers: Record<string, string>) {
      sent.status = status;
      sent.headers = headers;
      return response;
    },
  });
  return { response: response as unknown as http.ServerResponse, sent, done: new Promise((resolve) => sink.on("finish", resolve)) };
}

describe("the file browser's view of a workspace", () => {
  it("lists folders first, then files, by name", () => {
    const { work } = workspace();
    const listing = listFolder(work, "");
    expect(listing?.dir).toBe("");
    expect(listing?.entries.map((entry) => [entry.name, entry.dir])).toEqual([
      ["src", true],
      ["b.txt", false],
      ["page.html", false],
      ["README.md", false],
    ]);
    expect(listFolder(work, "src")?.entries.map((entry) => entry.name)).toEqual(["deep", "main.ts"]);
  });

  it("never reaches outside the workspace", () => {
    const { work } = workspace();
    expect(insideFolder(work, "../secret.txt")).toBeNull();
    expect(insideFolder(work, "src/../../secret.txt")).toBeNull();
    expect(listFolder(work, "..")).toEqual(listFolder(work, ""));
    expect(insideFolder(work, "C:/Windows/win.ini")).toBeNull();
    expect(insideFolder(work, "nope\0.txt")).toBeNull();
    expect(listFolder(work, "README.md")).toBeNull();
  });

  it("leaves out a link that points outside", () => {
    const { root, work } = workspace();
    try {
      symlinkSync(path.join(root, "secret.txt"), path.join(work, "leak.txt"));
    } catch {
      return; // creating links needs rights this machine may not give; the containment check above still holds
    }
    expect(listFolder(work, "")?.entries.some((entry) => entry.name === "leak.txt")).toBe(false);
    expect(insideFolder(work, "leak.txt")).toBeNull();
  });

  it("serves a file in a sandbox, so a page in the workspace cannot run on MirrorMix's address", async () => {
    const { work } = workspace();
    const { response, sent, done } = fakeResponse();
    expect(sendFolderFile(work, "page.html", false, response)).toBe(true);
    await done;
    expect(sent.status).toBe(200);
    expect(sent.headers?.["content-security-policy"]).toContain("sandbox");
    expect(sent.headers?.["x-content-type-options"]).toBe("nosniff");
    expect(sent.body).toContain("<script>");

    const download = fakeResponse();
    expect(sendFolderFile(work, "src/main.ts", true, download.response)).toBe(true);
    await download.done;
    expect(download.sent.headers?.["content-disposition"]).toBe("attachment; filename*=UTF-8''main.ts");
    expect(sendFolderFile(work, "../secret.txt", false, fakeResponse().response)).toBe(false);
    expect(sendFolderFile(work, "src", false, fakeResponse().response)).toBe(false);
  });
});
