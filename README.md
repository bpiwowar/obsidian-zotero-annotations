# Zotero Annotations

An Obsidian plugin that automatically shows Zotero PDF annotations in a sidebar when your cursor is on a `zotero://select/library/items/ITEMKEY` link.

## Features

- **Automatic sidebar**: Place your cursor on a Zotero link (or inside a markdown link `[text](zotero://...)`) and the sidebar opens with that paper's annotations
- **Click interception**: Clicking a `zotero://select/` link opens the sidebar instead of switching to Zotero
- **Paper metadata**: Title, authors, date, and collapsible abstract
- **Notes**: Zotero notes are displayed (expanded by default) with embedded images
- **Annotations**: Highlights, comments, and tags grouped by page, with colored sidebar matching the annotation color
- **Image annotations**: Area highlights are rendered from the Zotero cache
- **Pin/freeze**: Pin the sidebar to keep the current annotations while you navigate
- **PDF links**: Click a page number to open the PDF at that page in Zotero
- **Caching**: Annotations are cached in memory to avoid repeated API calls
- **Literature notes** (optional): one note per paper, with its annotations and Zotero notes, kept in sync with Zotero — see below

## Requirements

- **Zotero 7+** running locally (Zotero 10+ for writing notes back to Zotero, in a coming version)
- Zotero's local API enabled: **Settings → Advanced → "Allow other applications on this computer to communicate with Zotero"**

## Getting Zotero links

The plugin reacts to two kinds of links:

- a paper: `zotero://select/library/items/ITEMKEY`
- an annotation: `zotero://open-pdf/library/items/ATTACHMENTKEY?page=3&annotation=ANNOTATIONKEY`

Zotero has no built-in command to copy them, but the [Actions & Tags](https://github.com/windingwind/zotero-actions-tags) add-on does it with its community script [**Copy Zotero link**](https://github.com/windingwind/zotero-actions-tags/discussions/115):

1. Install Actions & Tags: download the `.xpi` from its [latest release](https://github.com/windingwind/zotero-actions-tags/releases/latest), then in Zotero **Tools → Add-ons → ⚙ → Install Add-on From File…**
2. In **Zotero Settings → Actions & Tags**, click **+** and create an action:
   - **Event**: None
   - **Operation**: Script
   - **Data**: the script from the [Copy Zotero link discussion](https://github.com/windingwind/zotero-actions-tags/discussions/115); set `linkType = "md"` at its top to get Markdown links (`[title](zotero://…)`), and `linkTextField = "citationKey"` if you prefer citation keys as link text
   - **Shortcut** (e.g. `Ctrl+Shift+L`) and **Menu Label** (e.g. "Copy Zotero link"), so it shows in the right-click menus
3. Select a paper in the library — or an annotation in the PDF reader's sidebar — run the action (shortcut or right-click menu), and paste into Obsidian.

With `linkAction = "auto"` (the default), papers get `zotero://select` links and PDFs/annotations get `zotero://open-pdf` links, which open the PDF at the annotation.

The same instructions are in the plugin's settings, under **Getting Zotero links**.

## Literature notes

Turn on **Settings → Zotero Annotations → Literature notes** to keep one note per paper in the vault. A literature note is identified by its `zotero-key` frontmatter property (as in [ZotLit](https://github.com/aidenlx/zotlit)) and looks like this:

```markdown
---
zotero-key: ABCD1234
title: …
citekey: …
zotero: zotero://select/library/items/ABCD1234
zotero-pdf: zotero://open-pdf/library/items/EFGH5678
pdf: file:///…/paper.pdf
zotero-note: NOTEKEY
---

The Zotero child note, as Markdown     ← refreshed from Zotero while you haven't edited it
```

When the paper has several Zotero notes, each one gets its own section instead (and `zotero-note` goes away):

```markdown
%%zt-note: NOTEKEY%%
A Zotero child note, as Markdown
%%/zt-note%%
```

- **Creating notes**: on demand (the **Note** button in the sidebar, or the "Open literature note…" command), when the cursor lands on a link to the paper, or for every paper linked from the vault — see the **Create notes** setting. The automatic modes only create notes for papers that have Zotero notes; an empty note is only made on demand.
- **Sync**: the plugin asks Zotero what changed since the last check (every minute by default, when Obsidian regains focus, and when a literature note is opened) and updates only the affected notes. It never reads Zotero's database directly — everything goes through the local API.
- **Annotations** are not copied into the note: the sidebar shows them, and follows the literature note you have open.
- **Names**: new notes are named "Short title – KEY" (e.g. "Don t Forget Your Embeddings – CEW9LK4V"); the title is cut at the first ":" and to 6 words (both configurable).
- **Refresh**: the sidebar's refresh button, the note's file menu ("Refresh from Zotero") or the "Refresh literature note from Zotero" command re-reads the paper from Zotero.
- **Properties**: title, citation key and links are properties, refreshed from Zotero: `zotero` selects the paper in Zotero (in its own literature note, clicking it opens Zotero rather than the sidebar), `zotero-pdf` opens the PDF in Zotero's reader, `pdf` opens the file itself. The body holds only your text and the Zotero notes.
- **Your edits are safe**: text outside the `zt-note` sections is never touched (a note holding a single Zotero note has no such text: the whole body is the note). A note or `zt-note` section you edited in Obsidian is not overwritten: it is sent to Zotero (when you leave the note, after 30 s without typing, or with "Send literature note edits to Zotero"; the first time, Zotero asks for permission — choose "Always allow"). If the note changed in Zotero too, you choose which version to keep. A new `%%zt-note%%` section (without key), or the text of a note for a paper without Zotero notes, becomes a new Zotero note. Images go along (PNG and JPEG; Zotero imports them when the note is opened in Zotero). Deleting a `zt-note` section (or emptying a single-note body) keeps it out of the note. Holding exactly one Zotero note and nothing else, a note drops its markers.
- **Images** inside Zotero notes are copied to the image folder.

## Installation

### Manual

1. Download or clone this repository
2. Run `npm install && npm run build`
3. Copy `main.js` and `manifest.json` to `<vault>/.obsidian/plugins/zotero-annotations/`
4. Enable the plugin in Obsidian: **Settings → Community plugins → Zotero Annotations**

### Development

1. Clone the repository
2. `npm install`
3. Create a `.obsidian-plugin-dir` file containing the path to your vault's plugin directory:
   ```
   /path/to/vault/.obsidian/plugins/zotero-annotations
   ```
4. `npm run watch` — rebuilds on every file change
5. Install the [Hot Reload](https://github.com/pjeby/hot-reload) plugin and run `touch .hotreload` in the vault's plugin directory for automatic reloading

You can also set the `OBSIDIAN_PLUGIN_DIR` environment variable instead of using the `.obsidian-plugin-dir` file.

## Commands

| Command | Description |
|---|---|
| Toggle Zotero Annotations sidebar | Show/hide the sidebar |
| Pin/Unpin annotations sidebar | Freeze the sidebar so cursor movements don't update it |
| Refresh current annotations | Clear the cache and re-fetch annotations for the current item |
| Open literature note of the paper in the sidebar | Opens the paper's literature note, creating it if needed |
| Refresh literature note from Zotero | Re-reads the active literature note's paper from Zotero |
| Sync literature notes with Zotero | Updates every literature note whose paper changed in Zotero |

## Known limitations

- Only personal libraries are supported (`users/0`). Group libraries use a different API path.
- Image annotations require access to the Zotero data directory (`~/Zotero/cache/library/`). If your Zotero data directory is in a non-default location, images won't load.

## License

MIT
