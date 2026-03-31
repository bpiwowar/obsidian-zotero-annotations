# Zotero Annotations — Obsidian Plugin

## What this is

An Obsidian plugin that automatically shows Zotero PDF annotations in a sidebar when the cursor is on a `zotero://select/library/items/ITEMKEY` link. It talks to Zotero's local HTTP API (port 23119) — no native dependencies, no direct SQLite access.

## Project structure

```
src/
  main.ts              # Plugin entry point, glues everything together
  zotero-client.ts     # HTTP client for Zotero local API (localhost:23119)
  annotation-view.ts   # Sidebar ItemView — renders annotations, freeze/pin toggle
  cursor-detector.ts   # CodeMirror 6 ViewPlugin — detects cursor on zotero:// links
  styles.ts            # Inline CSS (injected at runtime, uses Obsidian CSS variables)
manifest.json          # Obsidian plugin manifest
esbuild.config.mjs     # Build script (esbuild)
```

## Build commands

```bash
npm install            # Install dependencies
npm run dev            # Build in dev mode (watch not yet wired — see below)
npm run build          # Production build (typecheck + minified bundle)
```

Output: `main.js` in project root.

## Development setup

1. Create/use a test Obsidian vault
2. Either symlink `main.js` and `manifest.json` into `<vault>/.obsidian/plugins/zotero-annotations/`, or change `outfile` in `esbuild.config.mjs` to point there directly
3. Install the `pjeby/hot-reload` community plugin and `touch .hotreload` in the plugin folder
4. Zotero must be running with "Allow other applications on this computer to communicate with Zotero" enabled (Settings → Advanced)
5. Debug with Ctrl+Shift+I (Cmd+Option+I on Mac) in Obsidian

## Architecture

### Data flow

1. **Cursor detection** (`cursor-detector.ts`): CM6 ViewPlugin watches cursor position. When it lands on a `zotero://select/library/items/XXXXXXXX` URI, fires a callback with the 8-char item key.
2. **Debounce** (`main.ts`): 300ms debounce to avoid spamming API while arrowing through text.
3. **API calls** (`zotero-client.ts`): Two sequential HTTP calls via Obsidian's `requestUrl`:
   - `GET /api/users/0/items/{itemKey}/children` → find PDF attachments
   - `GET /api/users/0/items/{attachmentKey}/children` → get annotation child items
4. **Rendering** (`annotation-view.ts`): Sidebar shows paper metadata, annotations grouped by page, each with highlighted text, comment, tags, and a clickable link to open the PDF at that page.
5. **Caching** (`main.ts`): In-memory `Map<itemKey, {info, annotations}>`. Cleared per-item via the "Refresh" command.

### Freeze/Pin

The sidebar has a Pin/Auto toggle. When pinned, cursor movements don't update the sidebar — the current annotations stay visible. Toggled via toolbar button or the "Pin/Unpin annotations sidebar" command.

### Zotero API details

- Base URL: `http://localhost:23119/api/users/0` (user 0 = personal library)
- In Zotero 7, annotations are child items of PDF attachment items with `itemType: "annotation"`
- Annotation fields used: `annotationType`, `annotationText`, `annotationComment`, `annotationColor`, `annotationPageLabel`, `annotationSortIndex`, `tags`
- PDF open link: `zotero://open-pdf/library/items/{attachmentKey}?page={pageLabel}`

### Obsidian APIs used

- `Plugin`, `ItemView`, `WorkspaceLeaf`, `setIcon`, `requestUrl` from `obsidian`
- `ViewPlugin`, `EditorView`, `ViewUpdate` from `@codemirror/view`
- `EditorState` from `@codemirror/state`
- Styles use Obsidian CSS variables (`--background-primary`, `--text-muted`, etc.) for theme compatibility

## Known limitations / TODOs

- **Watch mode**: `esbuild.config.mjs` doesn't support `--watch` yet — needs switching from `build()` to `context().watch()`
- **Group libraries**: Only personal library (`users/0`) is supported. Group libraries use `/groups/{groupId}/items/...`
- **Settings panel**: No settings UI yet. Candidates: custom Zotero port, debounce delay, sidebar auto-open behavior
- **`requestUrl` vs `fetch`**: Obsidian's `requestUrl` doesn't appear in DevTools Network tab. Consider using `fetch` behind a dev flag for easier debugging
- **Error recovery**: If Zotero is not running on first cursor hit, user must manually trigger refresh after starting Zotero
- **No annotation position data**: Page-level granularity only; no scroll-to-exact-position in the PDF viewer

## Code conventions

- TypeScript strict null checks enabled
- No external runtime dependencies — only Obsidian and CodeMirror (provided by Obsidian)
- Styles are inline in `styles.ts` to avoid a separate CSS build step
- All Zotero API types are locally defined (no `@zotero/types` dependency)

