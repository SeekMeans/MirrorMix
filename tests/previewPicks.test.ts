import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSupervisor } from "../src/process/supervisor";
import { createApp, listenLocal, type PreviewLink } from "../src/server/app";
import { htmlFileAt, htmlFilesIn, previewPortAllowed } from "../src/server/preview";
import { cleanPickedFile, createPreviewPickStore, validatePicks } from "../src/settings/previewPicks";
import { pickChoices, pickedPorts, picksToSave } from "../client/src/previewPicks";

const allowed = (port: number) => previewPortAllowed(port, [4789]);

describe("preview picks store", () => {
  it("accepts only relative HTML or Markdown paths inside the folder", () => {
    expect(cleanPickedFile("docs\\report.html")).toBe("docs/report.html");
    expect(cleanPickedFile("./a/./index.HTM")).toBe("a/index.HTM");
    expect(cleanPickedFile("notes.md")).toBe("notes.md");
    for (const bad of ["../x.html", "a/../../x.html", "C:/x.html", "/etc/x.html", "\\\\server\\x.html", "notes.txt", "../notes.md", "", 5, "a\nb.html"]) {
      expect(cleanPickedFile(bad)).toBeNull();
    }
  });

  it("validates ports with the preview rule, drops duplicates and keeps names", () => {
    expect(validatePicks({ files: ["a.html", "A.html"], ports: [{ port: 5173, name: "node" }, 3000, { port: 5173 }] }, allowed)).toEqual({
      files: ["a.html"],
      ports: [{ port: 3000 }, { port: 5173, name: "node" }],
    });
    expect(() => validatePicks({ files: [], ports: [4789] }, allowed)).toThrow("picks_bad_port");
    expect(() => validatePicks({ files: [], ports: [80] }, allowed)).toThrow("picks_bad_port");
    expect(() => validatePicks({ files: ["../x.html"], ports: [] }, allowed)).toThrow("picks_invalid");
    expect(() => validatePicks({ files: "a.html", ports: [] }, allowed)).toThrow("picks_invalid");
  });

  it("keeps one choice per folder key on disk, and nothing chosen reads as null", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "preview-picks-"));
    const file = path.join(dir, "nested", "preview-picks.json");
    const store = createPreviewPickStore(file, allowed);
    expect(store.get("c:/work/app")).toBeNull();
    store.set("c:/work/app", "C:\\Work\\App", { files: ["dist/index.html"], ports: [{ port: 5173, name: "node" }] });
    store.set("c:/work/docs", "C:\\Work\\Docs", { files: [], ports: [] });
    const reopened = createPreviewPickStore(file, allowed);
    expect(reopened.get("c:/work/app")).toMatchObject({ files: ["dist/index.html"], ports: [{ port: 5173, name: "node" }] });
    // Choosing nothing is a choice too: the menu must not ask again.
    expect(reopened.get("c:/work/docs")).toMatchObject({ files: [], ports: [] });
    expect(JSON.parse(readFileSync(file, "utf8")).projects["c:/work/app"].root).toBe("C:\\Work\\App");
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads a damaged file as empty instead of failing", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "preview-picks-"));
    const file = path.join(dir, "preview-picks.json");
    writeFileSync(file, "{not json");
    const store = createPreviewPickStore(file, allowed);
    expect(store.get("x")).toBeNull();
    expect(store.set("x", "X", { files: [], ports: [3000] }).ports).toEqual([{ port: 3000 }]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("preview pick lists in the menu", () => {
  const running = [
    { port: 3350, name: "node" },
    { port: 5173, name: "node" },
  ];

  it("keeps a picked port that stopped, marked not running, instead of dropping it", () => {
    const picks = { files: [], ports: [{ port: 5173, name: "node" }, { port: 8000, name: "python" }], updatedAt: "" };
    expect(pickedPorts(picks, running)).toEqual([
      { port: 5173, name: "node", running: true },
      { port: 8000, name: "python", running: false },
    ]);
    expect(pickedPorts(null, running)).toEqual([]);
  });

  it("offers everything running and in the folder, plus picked things that are gone", () => {
    const view = {
      root: "C:\\app",
      picks: { files: ["old.html", "new.html"], ports: [{ port: 8000, name: "python" }], updatedAt: "" },
      files: [{ path: "old.html", missing: true as const }, { path: "new.html", size: 1, modifiedAt: "2026-01-01T00:00:00.000Z" }],
    };
    const choices = pickChoices([{ path: "new.html", size: 1, modifiedAt: "2026-01-01T00:00:00.000Z" }], running, view);
    expect(choices.files.map((item) => [item.path, Boolean(item.missing)])).toEqual([
      ["new.html", false],
      ["old.html", true],
    ]);
    expect(choices.ports.map((item) => [item.port, item.running])).toEqual([
      [3350, true],
      [5173, true],
      [8000, false],
    ]);
    expect(picksToSave(new Set(["new.html"]), new Set([8000, 5173]), choices.ports)).toEqual({
      files: ["new.html"],
      ports: [{ port: 5173, name: "node" }, { port: 8000, name: "python" }],
    });
  });
});

describe("preview picks API", () => {
  it("shares the choice between sessions of one folder, keeps other folders apart, and reports moved files", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "preview-picks-api-"));
    const app = path.join(root, "app");
    const other = path.join(root, "other");
    const projects = path.join(root, "claude");
    for (const dir of [app, other, projects, path.join(app, "dist")]) mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(app, "dist", "index.html"), "<title>能源指纹</title>");
    writeFileSync(path.join(app, "report.html"), "<p>x</p>");
    const claudeFiles = path.join(projects, "fixture");
    mkdirSync(claudeFiles);
    for (const [id, cwd] of [["one", app], ["two", app], ["three", other]]) {
      writeFileSync(path.join(claudeFiles, `${id}.jsonl`), JSON.stringify({ type: "user", cwd, message: { role: "user", content: id } }));
    }
    const supervisor = createSupervisor({
      roots: { claudeProjectsDir: projects, codexSessionsDir: path.join(root, "codex"), claudeDataDir: "" },
      bins: { claudeExe: "", codexJs: "", nodeExe: "" },
      listProcesses: () => [],
      spawn: () => {
        throw new Error("not used");
      },
    });
    const preview: PreviewLink = {
      allowed,
      issue: () => "/__mirrormix/enter?ticket=x",
      ports: async () => [],
      htmlFiles: (folder) => htmlFilesIn(folder),
      htmlFile: (folder, relative) => htmlFileAt(folder, relative),
      origin: () => "http://127.0.0.1:1",
    };
    const store = createPreviewPickStore(path.join(root, "picks.json"), allowed);
    const server = createApp(supervisor, undefined, undefined, undefined, undefined, preview, undefined, undefined, store);
    await listenLocal(server, 0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const get = async (id: string) => (await fetch(`${base}/api/preview/picks?tool=claude&id=${id}`)).json();
    const put = (body: unknown, origin = base) =>
      fetch(`${base}/api/preview/picks`, { method: "PUT", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body) });
    try {
      expect((await get("one")).picks).toBeNull();

      const saved = await put({ tool: "claude", id: "one", files: ["dist/index.html", "report.html"], ports: [{ port: 5173, name: "node" }] });
      expect(saved.status).toBe(200);

      const shared = await get("two");
      expect(shared.picks).toMatchObject({ files: ["dist/index.html", "report.html"], ports: [{ port: 5173, name: "node" }] });
      expect(shared.files[0]).toMatchObject({ path: "dist/index.html", title: "能源指纹" });
      expect((await get("three")).picks).toBeNull();

      rmSync(path.join(app, "report.html"));
      expect((await get("one")).files[1]).toEqual({ path: "report.html", missing: true });

      expect((await put({ tool: "claude", id: "one", files: ["../secret.html"], ports: [] })).status).toBe(400);
      expect((await put({ tool: "claude", id: "one", files: [], ports: [4789] })).status).toBe(400);
      expect((await put({ tool: "claude", id: "one", files: [], ports: [] }, "https://other.invalid")).status).toBe(403);
      expect((await fetch(`${base}/api/preview/picks?tool=claude&id=missing`)).status).toBe(404);

      // Nothing ticked is kept as "nothing", not as "ask again".
      await put({ tool: "claude", id: "two", files: [], ports: [] });
      expect((await get("one")).picks).toMatchObject({ files: [], ports: [] });
    } finally {
      server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
