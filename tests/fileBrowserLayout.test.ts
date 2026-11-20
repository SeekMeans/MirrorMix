import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(fileURLToPath(new URL("../client/src/FileBrowser.tsx", import.meta.url)), "utf8");
const styles = readFileSync(fileURLToPath(new URL("../client/src/styles.css", import.meta.url)), "utf8");
const help = readFileSync(fileURLToPath(new URL("../client/src/Help.tsx", import.meta.url)), "utf8");

describe("resource browser desktop layout", () => {
  it("shows the workspace as one expandable tree beside the preview, with a draggable split", () => {
    // One pane on the left: the tree itself, not a separate folder pane next to a file list.
    expect(source).not.toContain("function TreeNode(");
    expect(source).not.toContain('className="files-tree"');
    expect(styles).not.toContain(".files-tree {");
    expect(source).toContain('className="files-list ftree"');
    expect(source).toContain('role="treeitem"');
    expect(source).toContain("aria-expanded");
    expect(source).toContain('className="files-splitter"');
    expect(source).toContain('className="file-preview');
  });

  it("describes the tree and the split in the help", () => {
    expect(help).toContain("左边是文件树，右边是预览");
    expect(help).toContain("在原地展开或收起");
    expect(help).not.toContain("后退、前进、上一级");
  });
});
