import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createServiceRunner, createServiceStore, detectServices, serviceLine, validateServices, type ProcessOps } from "../src/server/projectServices";
import { createTerminalHub } from "../src/server/terminals";

const temp = () => mkdtempSync(path.join(tmpdir(), "project-services-"));

describe("project services", () => {
  it("keeps service folders inside the project and names unique", () => {
    const root = temp();
    expect(validateServices(root, [{ name: "后端", dir: ".\\server\\", command: "npm run dev" }])).toEqual([{ name: "后端", dir: "server", command: "npm run dev" }]);
    expect(() => validateServices(root, [{ name: "x", dir: "..\\other", command: "a" }])).toThrow("service_dir");
    expect(() => validateServices(root, [{ name: "x", dir: "C:\\Windows", command: "a" }])).toThrow("service_dir");
    expect(() => validateServices(root, [{ name: "x", dir: "a%PATH%", command: "a" }])).toThrow("service_dir");
    expect(() => validateServices(root, [{ name: "x", dir: "", command: "a" }, { name: "x", dir: "", command: "b" }])).toThrow("service_duplicate");
    expect(() => validateServices(root, [{ name: "x", dir: "", command: "a\nb" }])).toThrow("service_command");
  });

  it("saves one list per project", () => {
    const store = createServiceStore(path.join(temp(), "services.json"));
    const root = temp();
    store.set("a", root, [{ name: "前端", dir: "", command: "npm run dev" }]);
    expect(store.get("a")).toEqual([{ name: "前端", dir: "", command: "npm run dev" }]);
    expect(store.get("b")).toEqual([]);
    store.set("a", root, []);
    expect(store.get("a")).toEqual([]);
  });

  it("recognizes a frontend and a backend folder", () => {
    const root = temp();
    mkdirSync(path.join(root, "web"));
    writeFileSync(path.join(root, "web", "package.json"), JSON.stringify({ scripts: { dev: "vite" }, devDependencies: { vite: "6" } }));
    writeFileSync(path.join(root, "web", "pnpm-lock.yaml"), "");
    mkdirSync(path.join(root, "server"));
    writeFileSync(path.join(root, "server", "pom.xml"), "<project/>");
    mkdirSync(path.join(root, "node_modules"));
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { dev: "concurrently" } }));
    expect(detectServices(root)).toEqual([
      { name: "后端", dir: "server", command: "mvn spring-boot:run" },
      { name: "前端", dir: "web", command: "pnpm dev" },
    ]);
    const single = temp();
    writeFileSync(path.join(single, "package.json"), JSON.stringify({ scripts: { start: "node ." } }));
    expect(detectServices(single)).toEqual([{ name: path.basename(single).slice(0, 20), dir: "", command: "npm start" }]);
  });

  it("starts each service in its own tab, leaves a running one alone, and restarts only what it started", async () => {
    const root = temp();
    mkdirSync(path.join(root, "server"));
    const opened: string[] = [];
    const typed: string[][] = [];
    const hub = createTerminalHub((cwd) => {
      const index = opened.push(cwd) - 1;
      typed[index] = [];
      return { pid: 100 + index, write: (text) => { typed[index].push(text); }, resize() {}, kill() {}, onData() {}, onExit() {} };
    });
    hub.create("p", root); // the person's own tab 1 is never touched
    const store = createServiceStore(path.join(temp(), "services.json"));
    store.set("p", root, [{ name: "后端", dir: "server", command: "npm run dev" }, { name: "前端", dir: "", command: "npm run web" }]);
    const alive = new Map<number, number>(); // child pid → shell pid
    const killed: number[] = [];
    const processes: ProcessOps = {
      children: async (parents) => [...alive].filter(([, parent]) => parents.includes(parent)).map(([pid, parentPid]) => ({ pid, parentPid, name: "node.exe" })),
      killTree: async (pid) => { killed.push(pid); alive.delete(pid); return true; },
    };
    const runner = createServiceRunner(hub, store, processes, 1);

    const started = await runner.run("p", root, "start", []);
    expect(hub.list("p").map((tab) => tab.label)).toEqual(["1", "后端", "前端"]);
    expect(opened.slice(1)).toEqual([path.join(root, "server"), root]);
    expect(typed[1]).toEqual([serviceLine(root, { name: "后端", dir: "server", command: "npm run dev" })]);
    expect(typed[1][0]).toBe(`cd /d "${path.join(root, "server")}" && npm run dev\r`);
    expect(started.focus).toBe(hub.serviceTab("p", "后端")!.tid);

    alive.set(500, 101); // the backend is running in its tab
    alive.set(501, 100); // something the person runs in tab 1
    expect((await runner.list("p")).map((item) => item.running)).toEqual([true, false]);
    await runner.run("p", root, "start", ["后端"]);
    expect(typed[1]).toHaveLength(1);

    await runner.run("p", root, "restart", ["后端"]);
    expect(killed).toEqual([500]);
    expect(typed[1]).toHaveLength(2);
    expect(alive.has(501)).toBe(true);

    alive.set(502, 102);
    await runner.run("p", root, "stop", []);
    expect(killed).toEqual([500, 502]);
    expect(typed[2]).toHaveLength(1);
    hub.dispose();
  });
});
