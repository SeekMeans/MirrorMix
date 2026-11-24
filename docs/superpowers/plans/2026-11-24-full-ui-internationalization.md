# Full UI Internationalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every fixed, user-facing MirrorMix UI string switchable between Simplified Chinese and English, using browser-language defaults and a persisted choice in General Settings.

**Architecture:** Add an optional language field to the existing settings store and API. Initialize one i18next instance in the React client, then migrate fixed copy feature by feature into matching Chinese and English resource namespaces. Keep backend responses as stable error codes and translate them in the client.

**Tech Stack:** TypeScript, React 19, Vite, Vitest, i18next, react-i18next.

## Global Constraints

- Supported saved locale values are exactly `zh-CN` and `en`.
- Saved language overrides browser language; missing setting resolves via `navigator.language.startsWith("zh") ? "zh-CN" : "en"`.
- Translate all fixed user-facing text under `client/src/`; never translate AI/user content, paths, commands, file names, API values, or terminal output.
- Existing settings files without `language` remain valid.
- Do not include unrelated worktree changes in commits.

---

### Task 1: Add a persisted language preference

**Files:**
- Modify: `src/settings/toolSettings.ts`
- Modify: `client/src/api.ts`
- Modify: `tests/settings.test.ts`

**Interfaces:**
- Produces: `export type Language = "zh-CN" | "en"`.
- Produces: optional `language?: Language` in `ToolSettings` and `ToolPrefs`.
- Produces: `saveSettings(change: { tools: ToolId[] } | { pinned: string[] } | { language: Language }): Promise<ToolPrefs>`.

- [ ] **Step 1: Write the failing settings tests**

Add tests that PUT `{ language: "en" }`, expect it in the JSON response and `settings.read()`, PUT `{ language: "fr" }` and expect HTTP 400, and read a legacy file containing only `tools` and expect `language` to be undefined.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npm test -- tests/settings.test.ts`

Expected: FAIL because the settings store ignores `language`.

- [ ] **Step 3: Implement validated persistence**

Add:

```ts
export type Language = "zh-CN" | "en";
function cleanLanguage(value: unknown): Language | null {
  return value === "zh-CN" || value === "en" ? value : null;
}
```

Extend the settings read/write contract so an omitted language retains its old value, supplied valid language is saved, and a supplied invalid language throws `Error("bad_request")`. Extend the API types and settings-save union to match.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `npm test -- tests/settings.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/settings/toolSettings.ts client/src/api.ts tests/settings.test.ts
git commit -m "feat: persist interface language preference"
```

### Task 2: Add i18next, resources, and locale resolution

**Files:**
- Modify: `package.json`, `package-lock.json`, `client/src/main.tsx`
- Create: `client/src/i18n/index.ts`
- Create: `client/src/i18n/resources/en.ts`
- Create: `client/src/i18n/resources/zh-CN.ts`
- Create: `tests/i18n.test.ts`

**Interfaces:**
- Produces: `browserLanguage(value?: string): "zh-CN" | "en"`.
- Produces: `resolveLanguage(saved, detected)` and `setLanguage(language)`.
- Produces: initialized exported `i18n` with English fallback.

- [ ] **Step 1: Write failing locale tests**

Create `tests/i18n.test.ts`:

```ts
expect(browserLanguage("zh-CN")).toBe("zh-CN");
expect(browserLanguage("zh-TW")).toBe("zh-CN");
expect(browserLanguage("en-IN")).toBe("en");
expect(browserLanguage()).toBe("en");
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/i18n.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Install and configure runtime**

Run: `npm install i18next react-i18next`.

Create the i18n module with `fallbackLng: "en"`, `supportedLngs: ["zh-CN", "en"]`, `returnNull: false`, and resources imported from both modules. Initialize with `browserLanguage()`. Import `./i18n` before React renders in `main.tsx`.

Seed matching `common` namespaces with language labels, save failure, unknown error, and reusable actions.

- [ ] **Step 4: Run focused tests and build**

Run: `npm test -- tests/i18n.test.ts; npm run build`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add package.json package-lock.json client/src/i18n client/src/main.tsx tests/i18n.test.ts
git commit -m "feat: add i18next client foundation"
```

### Task 3: Connect saved language, General Settings, and shared display helpers

**Files:**
- Modify: `client/src/App.tsx`, `client/src/Settings.tsx`, `client/src/text.ts`, `client/src/theme.ts`, `client/src/modelName.ts`, `client/src/workflowSteps.ts`
- Modify: both files in `client/src/i18n/resources/`
- Modify: `tests/i18n.test.ts`

**Interfaces:**
- Consumes: `ToolPrefs.language`, `resolveLanguage`, `setLanguage`.
- Produces: locale-aware error labels, status labels, relative time, and language selector.

- [ ] **Step 1: Write failing precedence and error-map tests**

Test:

```ts
expect(resolveLanguage("en", "zh-CN")).toBe("en");
expect(resolveLanguage(undefined, "zh-CN")).toBe("zh-CN");
```

Change the active language and assert the existing `tool_offline` code has an English and a Chinese result.

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- tests/i18n.test.ts`

Expected: FAIL because precedence and translated helpers do not exist.

- [ ] **Step 3: Implement behavior**

After each settings refresh in `App.tsx`, apply `resolveLanguage(prefs.language, browserLanguage())` only if it differs from the active i18next language. Add a General Settings select with `zh-CN` and `en`: switch optimistically, save through `api.saveSettings({ language })`, retain the response, and restore the old language plus localized error on failure.

Replace fixed string maps and code branches in the listed helpers with translation keys. Add an `errors.*` translation entry for every existing `errorText` branch and use interpolation for time/count variables.

- [ ] **Step 4: Run focused verification**

Run: `npm test -- tests/i18n.test.ts tests/settings.test.ts; npm run build`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add client/src/App.tsx client/src/Settings.tsx client/src/text.ts client/src/theme.ts client/src/modelName.ts client/src/workflowSteps.ts client/src/i18n tests/i18n.test.ts
git commit -m "feat: add interface language selector"
```

### Task 4: Translate every primary and workbench UI surface

**Files:**
- Modify: `client/src/Login.tsx`, `App.tsx`, `Sidebar.tsx`, `Conversation.tsx`, `Transcript.tsx`, `PromptCard.tsx`, `ActionDock.tsx`, `TodayStats.tsx`, `ModelChip.tsx`, `CursorThread.tsx`
- Modify: `client/src/CmdBox.tsx`, `CommandTasks.tsx`, `FileBrowser.tsx`, `PreviewButton.tsx`, `ServiceMenu.tsx`, `ShortcutMenu.tsx`, `AddToBrowser.tsx`, `MarkdownMessage.tsx`, `Select.tsx`, `ToolIcon.tsx`
- Modify: both resource files and `tests/i18n.test.ts`

**Interfaces:**
- Consumes: `useTranslation`, `Trans`, and locale-aware helpers.
- Produces: translated authentication, sessions, chat, terminal, files, preview, service, and command UX.

- [ ] **Step 1: Write a failing resource-parity test**

Add a recursive `keysOf` helper in `tests/i18n.test.ts` and assert that `en` and `zh-CN` expose identical flattened keys for `login`, `app`, `sidebar`, `conversation`, `terminal`, `files`, `preview`, `services`, and `commands`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/i18n.test.ts`

Expected: FAIL because feature namespaces are incomplete.

- [ ] **Step 3: Migrate all fixed strings in the listed components**

Replace each fixed displayed text node, button, title, tooltip, accessible name, placeholder, confirmation, empty state, validation message, and status text with a named translation key. Use interpolation for runtime values. Keep transcript text, session titles, terminal output, commands, URLs, and file content intact.

- [ ] **Step 4: Run focused tests and build**

Run: `npm test -- tests/i18n.test.ts; npm run build`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add client/src/Login.tsx client/src/App.tsx client/src/Sidebar.tsx client/src/Conversation.tsx client/src/Transcript.tsx client/src/PromptCard.tsx client/src/ActionDock.tsx client/src/TodayStats.tsx client/src/ModelChip.tsx client/src/CursorThread.tsx client/src/CmdBox.tsx client/src/CommandTasks.tsx client/src/FileBrowser.tsx client/src/PreviewButton.tsx client/src/ServiceMenu.tsx client/src/ShortcutMenu.tsx client/src/AddToBrowser.tsx client/src/MarkdownMessage.tsx client/src/Select.tsx client/src/ToolIcon.tsx client/src/i18n tests/i18n.test.ts
git commit -m "feat: translate primary interface"
```

### Task 5: Translate secondary features, audit all copy, and release-verify

**Files:**
- Modify: `client/src/Plugins.tsx`, `SshPlugin.tsx`, `Models.tsx`, `Workflows.tsx`, `Remote.tsx`, `Help.tsx`, `runCommand.ts`, `openFile.ts`, `sessionFeed.ts`, `previewPicks.ts`
- Modify: any remaining copy-bearing file identified by audit
- Modify: `README.md`, `README.zh-CN.md`, both resource files, and `tests/i18n.test.ts`

**Interfaces:**
- Consumes: all i18n namespaces; `Trans` where Help needs React links or inline code.
- Produces: complete two-language interface and documented behavior.

- [ ] **Step 1: Extend the parity test and add fallback coverage**

Add parity assertions for `plugins`, `models`, `workflows`, `remote`, and `help`. Add a test that a missing Chinese key returns the English fallback value rather than its raw key.

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- tests/i18n.test.ts`

Expected: FAIL until all secondary namespaces and fallback configuration are complete.

- [ ] **Step 3: Migrate secondary UI and Help**

Translate every fixed UI literal in the listed components. For Help content with links or code, keep the JSX structure in the component and use `Trans` with named elements. Never translate secrets, hosts, values, commands, paths, or AI output.

- [ ] **Step 4: Audit the entire client**

Run:

```powershell
rg -n --glob '*.tsx' --glob '*.ts' "[\u4e00-\u9fff]" client/src
```

Inspect every result: migrate display copy, or document it as a technical/API/command/user-data exemption. Review English-only display literals too. Add localization behavior to both READMEs after Quick Start.

- [ ] **Step 5: Run full automated verification**

Run: `npm test; npm run build; git diff --check`

Expected: all PASS with no whitespace errors.

- [ ] **Step 6: Manually smoke-test both languages**

Run `npm run dev`. In both locales verify login, list/chat/composer status, General Settings persistence after reload, terminal/files/preview, plugins/models/workflows/remote/Help, and that changing language retains the selected session and unsent draft.

- [ ] **Step 7: Commit**

```powershell
git add client/src README.md README.zh-CN.md tests/i18n.test.ts
git commit -m "feat: complete bilingual interface"
```

## Plan Self-Review

- Spec coverage: Task 1 covers persistence and old settings. Tasks 2–3 cover i18next, browser fallback, saved preference precedence, language switching, errors, and shared labels. Tasks 4–5 cover every user-facing client domain, audit, docs, automated verification, and manual smoke checks.
- Placeholder scan: Each task has exact files, a failing test, implementation actions, commands, expected outcomes, and a commit.
- Type consistency: `Language` and `UiLanguage` use the same exact values; the optional saved field is propagated from settings store to API to App to selector.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-11-24-full-ui-internationalization.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh agent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using `executing-plans`, with review checkpoints.

Which approach?

