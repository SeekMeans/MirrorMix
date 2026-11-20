import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withAttachments } from "../client/src/Conversation";
import { MAX_UPLOAD_BYTES, safeFileName, saveUpload, UploadError } from "../src/server/uploads";

/** Runs saveUpload behind a real HTTP request, the way the page sends a file. */
async function post(root: string, name: string, body: Buffer | string): Promise<{ status: number; json: any }> {
  const server = http.createServer(async (request, response) => {
    try {
      const saved = await saveUpload(root, name, request);
      response.writeHead(200).end(JSON.stringify(saved));
    } catch (error) {
      const status = error instanceof UploadError ? error.status : 500;
      response.writeHead(status).end(JSON.stringify({ error: error instanceof UploadError ? error.code : "failed" }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, { method: "POST", body: typeof body === "string" ? body : new Uint8Array(body) });
    return { status: response.status, json: await response.json() };
  } finally {
    server.close();
  }
}

describe("files and pictures added to a message", () => {
  it("keeps a usable name: no folders, no characters Windows refuses", () => {
    expect(safeFileName("..\\..\\secret.txt")).toBe("secret.txt");
    expect(safeFileName("a<b>:c?.png")).toBe("a_b__c_.png");
    expect(safeFileName("con.txt")).toBe("file-con.txt");
    expect(safeFileName("")).toBe("file");
    expect(safeFileName(`${"长".repeat(200)}.md`)).toBe(`${"长".repeat(80)}.md`);
  });

  it("saves the file under a dated folder and says where", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "aimiss-uploads-"));
    const { status, json } = await post(root, "截图.png", Buffer.from([137, 80, 78, 71]));
    expect(status).toBe(200);
    expect(json).toMatchObject({ name: "截图.png", size: 4, image: true });
    expect(path.dirname(path.dirname(json.path))).toBe(root);
    expect(path.basename(json.path)).toMatch(/^[0-9a-f]{8}-截图\.png$/);
    expect(readFileSync(json.path)).toEqual(Buffer.from([137, 80, 78, 71]));
  });

  it("refuses an empty file and one over the limit, and keeps neither", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "aimiss-uploads-"));
    expect((await post(root, "empty.txt", "")).json).toEqual({ error: "empty_file" });
    const big = await post(root, "big.bin", Buffer.alloc(MAX_UPLOAD_BYTES + 1));
    expect(big).toEqual({ status: 413, json: { error: "too_large" } });
    const left = existsSync(root) ? readdirSync(root).flatMap((day) => readdirSync(path.join(root, day))) : [];
    expect(left).toEqual([]);
  });

  it("names each attachment by its full path after the words", () => {
    expect(withAttachments("看看这个报错", [{ path: "C:\\up\\a.png", image: true }, { path: "C:\\up\\log.txt", image: false }])).toBe(
      "看看这个报错\n\n附件：\n[图片] C:\\up\\a.png\n[文件] C:\\up\\log.txt",
    );
    expect(withAttachments("  ", [{ path: "C:\\up\\a.png", image: true }])).toBe("请查看附件：\n[图片] C:\\up\\a.png");
    expect(withAttachments("只有字", [])).toBe("只有字");
  });
});
