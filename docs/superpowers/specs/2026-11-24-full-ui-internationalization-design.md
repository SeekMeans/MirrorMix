# Full UI Internationalization Design

## Goal

Make every fixed, user-facing MirrorMix interface string switchable between Simplified Chinese and English. The first visit follows the browser language; an explicit choice in Settings persists and takes precedence on future visits.

## Scope

The change covers all fixed copy in `client/src/`: login, session browsing and conversation, settings, terminals and previews, plugins, workflows, help pages, empty states, confirmation dialogs, validation copy, status copy, tooltips, and user-facing error messages.

It does not translate user-authored or external content: AI transcript text, session titles, workspace and file names, command output, model output, server-provided dynamic content, and data stored by other applications stay unchanged.

## Architecture

The client adds `i18next` and `react-i18next`. Application startup initializes a single i18next instance with two locales:

- `zh-CN` for Simplified Chinese
- `en` for English

Translations are organized by feature namespace so the resource files remain navigable: `common`, `app`, `settings`, `conversation`, `plugins`, `workflows`, `help`, and feature-specific namespaces where necessary. Components read fixed copy through `useTranslation()` or `Trans`; no component uses an inline `language === ...` branch for display text.

Plain strings with runtime values use i18next interpolation. React keeps ownership of markup, links, emphasis, and code samples; `Trans` is used only when translated prose needs those React elements. Translation resources do not contain arbitrary HTML or serialized JSX.

The initial language is resolved after the existing settings request:

1. If the server response has a valid saved language, use it.
2. Otherwise, if `navigator.language` begins with `zh`, use `zh-CN`.
3. Otherwise use `en`.

This keeps the first screen deterministic enough to render while allowing the persisted preference to become authoritative as soon as settings load. i18next falls back to English when a key is missing. Development builds log missing-key diagnostics; production must not render raw translation keys to the user.

## Settings and API

The existing settings data adds an optional language preference:

```ts
type Language = "zh-CN" | "en";

interface ToolSettings {
  tools: ToolId[];
  pinned: string[];
  language?: Language;
}
```

`GET /api/settings` includes the saved preference when present. `PUT /api/settings` accepts a partial update containing exactly one or more supported settings fields, including `language`. It accepts only `zh-CN` and `en`; any other supplied value is rejected as `bad_request`.

Existing `~/.mirrormix/settings.json` files without `language` remain valid. When an existing settings field is updated, the stored language is retained; when language alone is updated, tools and pins are retained.

Settings → General gains a two-option language control labeled in its current locale. Selecting a language changes i18next immediately, preserves all in-progress screen state, and saves the choice through the existing settings API. If saving fails, the UI restores the last successfully saved language and displays the localized settings-save error.

## Error and Label Translation

The server continues to expose machine-readable error codes. The client owns their display strings and maps them through translation keys. The existing centralized error text and tool-name helpers become locale-aware, so responses such as `bad_request`, session state labels, and tool labels are translated consistently.

All fixed labels in page components must be migrated in the same change. A source scan for user-facing Chinese or English literals in `client/src/` is used during review to find omissions, while allowing technical literals such as CSS class names, route strings, command names, API codes, and protocol constants.

## Compatibility

Changing language only updates presentation. It must not clear the selected session, draft message, open panel, modal, terminal WebSocket, polling state, or browser history entry. The backend remains compatible with old setting files and with clients that do not send a language property.

The README documents that the UI defaults to the browser language and can be changed in General Settings.

## Verification

Add focused tests for:

- language parsing and persistence in the settings store, including legacy setting files and invalid language rejection;
- browser-locale fallback (`zh*` to `zh-CN`, all other values to `en`);
- saved language taking precedence over browser locale;
- localized interpolation and error-code mapping;
- immediate language switching without recreating application state where unit-level coverage can observe it.

Before delivery, run the relevant focused tests, the complete `npm test` suite, and `npm run build`. Manually check both locales for the login page, primary session view, General Settings selector, plugin/settings pages, and Help content.
