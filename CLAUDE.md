# Zotero Annotations — Obsidian Plugin

## What this is

An Obsidian plugin that automatically shows Zotero PDF annotations in a sidebar when the cursor is on a `zotero://select/library/items/ITEMKEY` link. It talks to Zotero's local HTTP API (port 23119) — no native dependencies, no direct SQLite access.

## Project structure

```
src/
  main.ts              # Plugin entry point, glues everything together
  zotero-client.ts     # HTTP client for Zotero local API (localhost:23119)
  annotation-cache.ts  # Offline copy of the sidebar data, in a block at the end of literature notes
  annotation-view.ts   # Sidebar ItemView — renders annotations, freeze/pin toggle
  cursor-detector.ts   # CodeMirror 6 ViewPlugin — detects cursor on zotero:// links
  mention-index.ts     # Vault-wide index of notes linking to a Zotero item (cached on disk)
  paper-outline.ts     # Lays a note's Zotero links out along its heading structure
  literature-notes.ts  # One synced note per paper: create, update regions, incremental sync
  note-html.ts         # Markdown → Zotero note HTML (write-back)
  node.ts              # Lazy, desktop-only loaders of Node modules (fs, os, crypto)
  note-format.ts       # Literature note text: file names (short title – KEY), header, zt-note regions / single-note layout
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

1. **Cursor detection** (`cursor-detector.ts`): CM6 ViewPlugin watches cursor position. When it lands on a `zotero://select|open-pdf/library/items/XXXXXXXX` URI (bare or in a Markdown link, query included), fires a callback with the link (`ZoteroLink`); `main.ts` maps an `open-pdf` attachment key to its paper (`paperOfLink`: Zotero, else the literature note's `zotero-pdf`). A double click opens the link itself in Zotero.
2. **Debounce** (`main.ts`): 300ms debounce to avoid spamming API while arrowing through text.
3. **API calls** (`zotero-client.ts`): Two sequential HTTP calls via Obsidian's `requestUrl`:
   - `GET /api/users/0/items/{itemKey}/children` → find PDF attachments
   - `GET /api/users/0/items/{attachmentKey}/children` → get annotation child items
4. **Rendering** (`annotation-view.ts`): Sidebar shows paper metadata, annotations grouped by page, each with highlighted text, comment, tags, and a clickable link to open the PDF at that page.
5. **Caching** (`main.ts`): In-memory `Map<itemKey, {info, annotations, version}>`. A cached paper is shown at once, then checked against Zotero's library version (asked at most every 10 s, `PAPER_CHECK_MS`) and reloaded — literature notes synced along — when the library changed. The periodic check (`syncInterval`, default 5 min) and window focus do the same for the paper on screen.

### Mentions ("Mentioned in" section)

`mention-index.ts` keeps a `Map<itemKey, Mention[]>` of every vault note containing a
`zotero://select|open-pdf/(library|groups/N)/items/KEY` URI, one entry per (key, line).
The sidebar shows them in a foldable section, grouped by note; clicking a line opens the
note at that line (`leaf.openFile(file, { eState: { line } })`).

Caching, since scanning a whole vault is the expensive part:

- The scan is **lazy** — it runs on the first lookup, not on plugin load — and its result stays in memory for the session.
- Vault `create`/`modify`/`delete`/`rename` events re-scan only the affected note (500 ms debounce), then notify the sidebar so an open section refreshes itself. Events before the first build are ignored (the lazy build reads current state anyway), which also makes Obsidian's startup burst of `create` events free.
- The index is mirrored to `<plugin dir>/mention-index.json` (per-file mtime + hits, `CACHE_VERSION`-stamped, debounced write). On restart, only notes whose mtime changed are re-read; notes without any Zotero link are still recorded, since their mtime is what lets them be skipped.
- "Rescan vault for Zotero mentions" command forces a full rebuild.

### Papers in the current note

The sidebar toolbar has a **Papers** button (also the "List Zotero papers in current
note" command). It reads the `zotero://` links of the note being edited — through
`MentionIndex.getHitsInFile`, which reads that one note rather than triggering the
vault-wide scan — resolves each key with `fetchItemSummary` (one request per item,
cached in memory; an attachment key from an `open-pdf` link is resolved to its parent
item), and hands the result to `buildPaperOutline`.

`buildPaperOutline` places every link under the last heading above it (headings come
from `metadataCache.getFileCache(file).headings`), nests the sections by heading level,
and prunes branches with no paper, so the sidebar mirrors the note's outline. Clicking a
heading or a line number jumps there in the note; clicking a paper loads its annotations
(the Back button returns to the list). While the list is on screen the view stops
following the cursor, exactly as when it is pinned (`AnnotationView.ignoresCursor`).

### Literature notes

`literature-notes.ts` keeps one note per paper (frontmatter `zotero-key`, as ZotLit). The header
(title, Zotero and file links) is written once at creation; annotations are not copied (the
sidebar shows them and follows the open literature note); each `%%zt-note: KEY%%` region mirrors a Zotero child note (markers only when needed: a body
that is exactly one Zotero note has none, its key in the `zotero-note` property — `noteLayout`) and is
refreshed only while its hash matches what was last written (local edits are kept; shift-click
on the sidebar refresh overwrites them). Quotes and citations become `zotero://` links that carry
everything needed to rebuild them for write-back (page, label, highlight rects, cited locator). Edits go back to Zotero
(`push`): a region whose text no longer has its recorded hash is converted by `note-html.ts`
(`markdownToHtml`, the inverse of `noteToMarkdown`: quote links → `span.highlight`, `(…)` citation
links → `span.citation`, image alt links → `img[data-annotation]`; images that are attachments of
the note keep `data-attachment-key`, others go as PNG/JPEG data URLs that Zotero's note editor imports
when the note is opened) and PATCHed with `If-Unmodified-Since-Version`, inside the wrapper `div` of
the note it replaces. Whether Zotero changed a note is decided by the hash of its HTML (`RegionState.html`;
Zotero bumps versions without changes); changed on both sides → `choose` modal (interactive push) or a
one-time notice. Keyless regions, and the body of a paper without Zotero notes, become new Zotero notes.
Pushes run on leaving the note, 30 s after the last edit, before each sync, and by command; a failed push
is simply retried (the region hashes are the queue). Regions deleted in Obsidian are not deleted in Zotero.
State
(per-item region versions/hashes, descendant keys, server ID, library version) lives in
`<plugin dir>/literature-notes.json`. Sync asks `items?since=<libraryVersion>&format=versions`
and maps changed keys to tracked papers through their descendants (two parent hops for new
children). The local API never reports deletions (no `/deleted`), and versions are only valid
for one `Zotero-Server-ID`. Write access (`ZoteroWriter`, Zotero 10+) needs a key from
`/local/authorize`; embedded-image uploads are refused by Zotero.
Bulk commands: "Refresh all" (`refreshAll`, a full `doSync` over every tracked note, edited regions kept),
"Send all" (`pushAll`, interactive) and "Sync all" (send, then refresh); the incremental sync is "Sync changed".

### Drag and drop

Annotation cards are draggable: the drop inserts `annotationMarkdown` (note-format.ts), the
Markdown Zotero's "add to note" would give once converted like literature notes —
`[“quote”](zotero://open-pdf/…?page=…&annotation=…&rects=…) [(Doe, 2020, p. 3)](zotero://select/…?locator=3) comment`.
An image annotation also carries `ANNOTATION_DRAG_TYPE` data: main.ts's `editor-drop` handler copies Zotero's
rendering (`<Zotero>/cache/library/KEY.png`) into the image folder as `KEY.png` (the annotation key, as literature
notes name them) and inserts `![library/items/ATT?page=…&annotation=KEY…|300](Zotero/images/KEY.png) [(Doe, 2020, p. 3)](…)`:
the alt text of the image holds the annotation link minus `zotero://open-pdf/` (a full URL shows as a link) (`annotationImage`; literature notes write annotation images
of Zotero notes the same way, with Zotero's width). The card's `<img>` is `draggable=false` so its
base64 data URL never drops.

### Mobile

Node modules (`fs`, `os`, `crypto`) are loaded lazily through `node.ts`, behind a `Platform.isDesktop`
guard, so the bundle loads on mobile. There, `onload` skips everything that needs Zotero (literature note
commands and events, drop, sync; the settings tab hides the settings about them). Links behave as on desktop (`interceptLinksToSidebar`):
a `zotero://select` link shows the paper in the sidebar, its "Note" button opens the literature note.
The sidebar, cursor detection, mentions and paper list work from the offline copy (below).
`app.emulateMobile(true)` in the console runs this path on desktop.

### Offline copy

`annotation-cache.ts`: a literature note ends with a ```` ```zotero-annotations ```` block, the JSON of what the
sidebar shows (`ZoteroItemInfo` without notes + `ZoteroAnnotation[]`, one annotation per line; `zotero://` and
backticks escaped so the mention index and the fence are safe). `refresh`/`create` write it (`cacheJson`, which
also copies image annotations to the image folder as `KEY.png`; rewritten only when the data changed,
`sameCache`); `noteLayout` ends the body before it (`contentEnd`), so region hashes and pushes never see it.
A code block processor shows it as one line, `readOnlyCache` (CM6 change filter) drops user edits in it.
`loadAnnotations` falls back to it (`cachedPaper`) when Zotero is not reachable, the view marks it "Offline copy";
`resolveSummary` too; images come from the vault copy (`view.imageSource`).

### Freeze/Pin

The sidebar has a Pin/Auto toggle. When pinned, cursor movements don't update the sidebar — the current annotations stay visible. Toggled via toolbar button or the "Pin/Unpin annotations sidebar" command.

### Zotero API details

- Base URL: `http://localhost:23119/api/users/0` (user 0 = personal library)
- In Zotero 7, annotations are child items of PDF attachment items with `itemType: "annotation"`
- Annotation fields used: `annotationType`, `annotationText`, `annotationComment`, `annotationColor`, `annotationPageLabel`, `annotationSortIndex`, `tags`
- Related items live in `data.relations["dc:relation"]` as URIs (`http://zotero.org/users/{userId}/items/{KEY}`); the item key is parsed out of the URI and each related item is fetched individually for its title/creators/year
- PDF open link: `zotero://open-pdf/library/items/{attachmentKey}?page={pageIndex+1}&annotation={annotationKey}` — Zotero's `page` counts from 1, it is not the page label; unknown query parameters are ignored (literature notes use them to keep quote positions, see `annotationLink`)

### Obsidian APIs used

- `Plugin`, `ItemView`, `WorkspaceLeaf`, `setIcon`, `requestUrl` from `obsidian`
- `ViewPlugin`, `EditorView`, `ViewUpdate` from `@codemirror/view`
- `EditorState` from `@codemirror/state`
- Styles use Obsidian CSS variables (`--background-primary`, `--text-muted`, etc.) for theme compatibility

## Known limitations / TODOs

- **Watch mode**: `esbuild.config.mjs` doesn't support `--watch` yet — needs switching from `build()` to `context().watch()`
- **Group libraries**: Only personal library (`users/0`) is supported. Group libraries use `/groups/{groupId}/items/...`
- **`requestUrl` vs `fetch`**: Obsidian's `requestUrl` doesn't appear in DevTools Network tab. Consider using `fetch` behind a dev flag for easier debugging
- **Error recovery**: If Zotero is not running on first cursor hit, user must manually trigger refresh after starting Zotero
- **No annotation position data**: Page-level granularity only; no scroll-to-exact-position in the PDF viewer

## Code conventions

- TypeScript strict null checks enabled
- No external runtime dependencies — only Obsidian and CodeMirror (provided by Obsidian)
- Styles are inline in `styles.ts` to avoid a separate CSS build step
- All Zotero API types are locally defined (no `@zotero/types` dependency)

