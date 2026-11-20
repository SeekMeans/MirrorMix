import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createPreview, fileInFolder, htmlFilesIn, localRedirect, readListening } from "../src/server/preview";
import { frpcConfig, previewSubdomain } from "../src/remote/tunnel";

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

describe("preview relay", () => {
  it("lets a browser in once with a ticket, then relays to the local page as a local visit", async () => {
    const seen: Array<{ host?: string; cookie?: string; url?: string }> = [];
    const page = http.createServer((request, response) => {
      seen.push({ host: request.headers.host, cookie: request.headers.cookie, url: request.url });
      if (request.url === "/go") {
        response.writeHead(302, { location: `http://localhost:${pagePort}/done` });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("dev page");
    });
    const pagePort = await listen(page);
    const preview = createPreview({ port: 0, blocked: [4789] });
    const previewPort = await listen(preview.server);
    const base = `http://127.0.0.1:${previewPort}`;

    expect((await fetch(`${base}/`)).status).toBe(401);

    const enter = preview.issue(pagePort);
    const entered = await fetch(`${base}${enter}`, { redirect: "manual" });
    expect(entered.status).toBe(302);
    const cookie = (entered.headers.get("set-cookie") ?? "").split(";")[0];
    expect(cookie).toMatch(/^mm_preview=/);
    // A ticket works only once.
    expect((await fetch(`${base}${enter}`, { redirect: "manual" })).status).toBe(403);

    const shown = await fetch(`${base}/src/main.tsx`, { headers: { cookie: `${cookie}; theme=dark` } });
    expect(await shown.text()).toBe("dev page");
    expect(seen.at(-1)).toEqual({ host: `localhost:${pagePort}`, cookie: "theme=dark", url: "/src/main.tsx" });

    const moved = await fetch(`${base}/go`, { headers: { cookie }, redirect: "manual" });
    expect(moved.headers.get("location")).toBe("/done");

    page.close();
    preview.server.close();
  });

  it("says so when nothing is running on that port", async () => {
    const preview = createPreview({ port: 0, blocked: [] });
    const previewPort = await listen(preview.server);
    const spare = http.createServer();
    const sparePort = await listen(spare);
    spare.close();
    const entered = await fetch(`http://127.0.0.1:${previewPort}${preview.issue(sparePort)}`, { redirect: "manual" });
    const cookie = (entered.headers.get("set-cookie") ?? "").split(";")[0];
    const answer = await fetch(`http://127.0.0.1:${previewPort}/`, { headers: { cookie } });
    expect(answer.status).toBe(502);
    expect(await answer.text()).toContain(`${sparePort}`);
    preview.server.close();
  });

  it("offers dev servers, not every program listening on the PC", () => {
    const output = ["5173\tnode", "4789\tnode", "14013\tWeixin", "6301\tpython", "80\tnginx", "52000\tnode", "5173\tnode", ""].join("\r\n");
    expect(readListening(output, [4789, 4790])).toEqual([
      { port: 5173, name: "node" },
      { port: 6301, name: "python" },
    ]);
  });

  it("keeps redirects on the preview address", () => {
    expect(localRedirect("http://127.0.0.1:5173/login?x=1", 5173)).toBe("/login?x=1");
    expect(localRedirect("http://localhost:5173", 5173)).toBe("/");
    expect(localRedirect("http://localhost:3000/x", 5173)).toBe("http://localhost:3000/x");
    expect(localRedirect("https://example.com/", 5173)).toBe("https://example.com/");
  });
});

describe("preview through the tunnel", () => {
  it("publishes the preview listener on <subdomain>-preview", () => {
    const config = { enabled: true, subdomain: "home", server: "seekmeans.cn", serverPort: 5000, domain: "mm.seekmeans.cn" };
    const text = frpcConfig(config, 4789, "t", 4790);
    expect(text).toContain('subdomain = "home-preview"');
    expect(text).toContain("localPort = 4790");
    expect(frpcConfig(config, 4789, "t")).not.toContain("preview");
    expect(previewSubdomain("a".repeat(56))).toBeNull();
  });
});

describe("previewing generated HTML files", () => {
  const folder = () => {
    const root = mkdtempSync(path.join(tmpdir(), "aimiss-html-"));
    mkdirSync(path.join(root, "report", "img"), { recursive: true });
    mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
    writeFileSync(path.join(root, "report", "index.html"), '<link rel="stylesheet" href="style.css"><img src="img/a.svg">');
    writeFileSync(path.join(root, "report", "style.css"), "body{color:red}");
    writeFileSync(path.join(root, "report", "img", "a.svg"), "<svg/>");
    writeFileSync(path.join(root, "old.html"), "<p>old</p>");
    writeFileSync(path.join(root, "node_modules", "pkg", "readme.html"), "<p>package</p>");
    utimesSync(path.join(root, "old.html"), new Date("2026-01-01"), new Date("2026-01-01"));
    return root;
  };

  it("lists the HTML files, newest first, leaving out installed packages", () => {
    const root = folder();
    expect(htmlFilesIn(root).map((item) => item.path)).toEqual(["report/index.html", "old.html"]);
  });

  it("reads page titles for identically named entry files and decodes their text", () => {
    const root = folder();
    mkdirSync(path.join(root, "other"));
    writeFileSync(path.join(root, "report", "index.html"), '<!-- <title>注释</title> --><script>const example = "<title>脚本</title>";</script><TITLE> 工业安全\n诊断 &amp; &#x80FD;&#28304; </TITLE>');
    writeFileSync(path.join(root, "other", "index.html"), '<title> CO₂ 平台 </title>');
    const files = htmlFilesIn(root);
    expect(files.find((item) => item.path === "report/index.html")?.title).toBe("工业安全 诊断 & 能源");
    expect(files.find((item) => item.path === "other/index.html")?.title).toBe("CO₂ 平台");
    expect(files.find((item) => item.path === "old.html")?.title).toBeUndefined();
  });

  it("leaves blank or out-of-range titles for the directory-name fallback", () => {
    const root = folder();
    writeFileSync(path.join(root, "old.html"), '<title> \n </title>');
    writeFileSync(path.join(root, "report", "index.html"), ' '.repeat(64 * 1024) + '<title>Too far</title>');
    expect(htmlFilesIn(root).every((item) => item.title === undefined)).toBe(true);
  });

  it("serves only files inside the folder", () => {
    const root = folder();
    expect(fileInFolder(path.join(root, "report"), "/style.css")).toBe(path.join(root, "report", "style.css"));
    expect(fileInFolder(path.join(root, "report"), "/")).toBe(path.join(root, "report", "index.html"));
    expect(fileInFolder(path.join(root, "report"), "/../old.html")).toBeNull();
    expect(fileInFolder(path.join(root, "report"), "/%2e%2e/old.html")).toBeNull();
    expect(fileInFolder(path.join(root, "report"), "/..%5Cold.html")).toBeNull();
    expect(fileInFolder(path.join(root, "report"), "/missing.html")).toBeNull();
  });

  it("opens the file and what it links to, with the right types", async () => {
    const root = folder();
    const preview = createPreview({ port: 0, blocked: [] });
    const previewPort = await listen(preview.server);
    const base = `http://127.0.0.1:${previewPort}`;
    const entered = await fetch(`${base}${preview.issue({ root, entry: "report/index.html" })}`, { redirect: "manual" });
    expect(entered.headers.get("location")).toBe("/report/index.html");
    const cookie = (entered.headers.get("set-cookie") ?? "").split(";")[0];
    const html = await fetch(`${base}/report/index.html`, { headers: { cookie } });
    expect(html.headers.get("content-type")).toContain("text/html");
    expect(await html.text()).toContain("style.css");
    const css = await fetch(`${base}/report/style.css`, { headers: { cookie } });
    expect(css.headers.get("content-type")).toContain("text/css");
    const svg = await fetch(`${base}/report/img/a.svg`, { headers: { cookie } });
    expect(svg.headers.get("content-type")).toBe("image/svg+xml");
    expect((await fetch(`${base}/report/style.css`)).status).toBe(401);
    preview.server.close();
  });
});
