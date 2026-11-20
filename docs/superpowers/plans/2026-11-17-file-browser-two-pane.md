# File Browser Two-Pane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the desktop resource browser's tree/list/preview layout with a list/preview layout and document the new navigation model.

**Architecture:** `FileBrowser` already owns directory navigation through its address bar and history state, so the tree UI can be removed without changing APIs or server routes. The list fills the released width while the existing preview pane and mobile sheet behavior remain unchanged. A source-level regression test is used because this repository has Vitest but no React DOM test renderer.

**Tech Stack:** React 19, TypeScript, CSS, Vitest, Vite.

## Global Constraints

- Change only the AIMiss web resource browser opened by the session-header folder icon.
- Desktop layout is exactly two panes: file list and file preview.
- Keep the top navigation controls, file operations, server API, and mobile behavior unchanged.
- Preserve existing uncommitted work outside the files listed in each task.

---

### Task 1: Remove the desktop folder-tree pane

**Files:**
- Modify: `client/src/FileBrowser.tsx:53-116, 314-373`
- Modify: `client/src/styles.css:1326-1350`
- Create: `tests/fileBrowserLayout.test.ts`

**Interfaces:**
- Consumes: `FileBrowser({ tool, id, cwd, mobile, onClose })` and its existing `dir`, back/forward history, and `go()` navigation callback.
- Produces: Desktop markup with a `.files-list` and `.file-preview`, but no `.files-tree` or `TreeNode` component; mobile markup remains conditional on `mobile`.

- [ ] **Step 1: Write the failing layout regression test**

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(fileURLToPath(new URL("../client/src/FileBrowser.tsx", import.meta.url)), "utf8");
const styles = readFileSync(fileURLToPath(new URL("../client/src/styles.css", import.meta.url)), "utf8");

describe("resource browser desktop layout", () => {
  it("uses file list and preview without a folder tree pane", () => {
    expect(source).not.toContain("function TreeNode(");
    expect(source).not.toContain('className="files-tree"');
    expect(source).toContain('className="files-list"');
    expect(source).toContain('className="file-preview"');
    expect(styles).not.toContain(".files-tree {");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/fileBrowserLayout.test.ts`

Expected: FAIL because `FileBrowser.tsx` still defines `TreeNode` and renders `.files-tree`.

- [ ] **Step 3: Implement the two-pane markup and styles**

Remove the entire `TreeNode` function and delete the desktop-only `<nav className="files-tree">…</nav>` block. Do not change `go`, `goBack`, `goForward`, the address bar, filter, list, preview, or mobile conditional rendering. Delete the `.files-tree`, `.tree-*`, and the 900px tree-hiding container rule from `client/src/styles.css`; retain `.files-main`, `.files-list`, and `.file-preview` so the list expands into the released space.

- [ ] **Step 4: Run the layout test to verify it passes**

Run: `npm test -- tests/fileBrowserLayout.test.ts`

Expected: PASS with one passing test.

- [ ] **Step 5: Run the browser production build**

Run: `npm run build`

Expected: Vite finishes with `built in` and no TypeScript errors.

- [ ] **Step 6: Commit the layout change**

```bash
git add client/src/FileBrowser.tsx client/src/styles.css tests/fileBrowserLayout.test.ts
git commit -m "feat: use two-pane file browser"
```

### Task 2: Update the resource-browser help text

**Files:**
- Modify: `client/src/Help.tsx:81-89`
- Modify: `tests/fileBrowserLayout.test.ts`

**Interfaces:**
- Consumes: The resource-browser help topic in `HelpContent`.
- Produces: Chinese help text that describes “文件列表和预览” and directs folder navigation to the top toolbar/path controls, with no statement that a left folder tree exists.

- [ ] **Step 1: Extend the failing regression test for help text**

Add this import and assertion to `tests/fileBrowserLayout.test.ts`:

```ts
const help = readFileSync(fileURLToPath(new URL("../client/src/Help.tsx", import.meta.url)), "utf8");

it("describes two-pane browsing and toolbar navigation", () => {
  expect(help).toContain("文件列表，右边是预览");
  expect(help).toContain("后退、前进、上一级或地址栏");
  expect(help).not.toContain("左边是文件夹树");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/fileBrowserLayout.test.ts`

Expected: FAIL because the current help says “左边是文件夹树，中间是文件列表，右边是预览”.

- [ ] **Step 3: Update only the resource-browser bullets**

Replace the first resource-browser bullet with: “点会话标题旁边的文件夹图标，浏览这个会话的文件夹：左边是文件列表，右边是预览。” Replace the navigation bullet with: “点文件夹进入，用后退、前进、上一级或地址栏里的路径跳转；右上角的输入框可以筛选当前文件夹。” Keep the download, preview, and mobile bullets unchanged.

- [ ] **Step 4: Run the regression test and production build**

Run: `npm test -- tests/fileBrowserLayout.test.ts && npm run build`

Expected: one passing Vitest test, followed by a successful Vite build.

- [ ] **Step 5: Commit the documentation change**

```bash
git add client/src/Help.tsx tests/fileBrowserLayout.test.ts
git commit -m "docs: describe two-pane resource browser"
```

## Self-Review

- Spec coverage: Task 1 removes the desktop folder tree, retains top navigation/list/preview, and preserves mobile behavior. Task 2 updates the help copy. No server API change is planned because existing directory navigation already uses `go()` and `api.files()`.
- Placeholder scan: the plan contains no unfinished placeholders, deferred steps, or undefined interface names.
- Type consistency: all changed UI remains inside the existing `FileBrowser` component and uses its existing props and state; no new exported type or API is introduced.
