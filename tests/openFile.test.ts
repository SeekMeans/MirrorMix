import { describe, expect, it } from "vitest";
import { fileOfLink, insideFolder, looksLikeFile } from "../client/src/openFile";

describe("files named in replies", () => {
  it("treats project links as files and leaves web links alone", () => {
    expect(fileOfLink("src/server/app.ts")).toBe("src/server/app.ts");
    expect(fileOfLink("client/src/App.tsx:42")).toBe("client/src/App.tsx");
    expect(fileOfLink("src/a%20b.ts#L10")).toBe("src/a b.ts");
    expect(fileOfLink("https://example.com/a.ts")).toBeNull();
    expect(fileOfLink("mailto:someone@example.com")).toBeNull();
    expect(fileOfLink("#section")).toBeNull();
  });

  it("recognises inline code that names a file in a folder", () => {
    expect(looksLikeFile("src/server/app.ts")).toBe(true);
    expect(looksLikeFile("client\\src\\App.tsx:12")).toBe(true);
    expect(looksLikeFile("app.ts")).toBe(false);
    expect(looksLikeFile("npm run dev")).toBe(false);
    expect(looksLikeFile("https://x.io/a.js")).toBe(false);
  });

  it("finds the path inside the session folder", () => {
    expect(insideFolder("E:\\Me\\AIMiss\\src\\server\\app.ts", "E:\\Me\\AIMiss")).toBe("src/server/app.ts");
    expect(insideFolder("e:/me/aimiss/client/src/App.tsx:3", "E:\\Me\\AIMiss")).toBe("client/src/App.tsx");
    expect(insideFolder("./src/../client/a.ts", "E:\\Me\\AIMiss")).toBe("client/a.ts");
    expect(insideFolder("D:\\other\\a.ts", "E:\\Me\\AIMiss")).toBeNull();
    expect(insideFolder("../outside.ts", "E:\\Me\\AIMiss")).toBeNull();
  });
});
