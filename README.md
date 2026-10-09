# Zotero Annotations

An Obsidian plugin that automatically shows Zotero PDF annotations in a sidebar when your cursor is on a `zotero://select/library/items/ITEMKEY` link.

![The cursor on a Zotero link in a note: the sidebar shows the paper, its abstract, the notes mentioning it and its Zotero notes](screenshots/zotero-link.png)

*With the cursor on a Zotero link, the sidebar shows the paper: its abstract, the notes that mention it, and its Zotero notes and annotations.*

![A literature note (properties linking to Zotero and the PDF, a Zotero note with its quotes and citations) next to the sidebar showing the paper and its annotations, grouped by page](screenshots/literature-note.png)

*With a literature note open, the sidebar shows that paper's annotations, grouped by page. The note itself holds the paper's Zotero note, where quotes and citations link back to the PDF.*

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
- **Literature notes** (optional): one note per paper holding its Zotero notes, kept in sync with Zotero in both directions — see below
- **Drag and drop**: drag an annotation from the sidebar into a note to quote it with a link back to the PDF

## Requirements

- Obsidian desktop to talk to Zotero. On mobile (or when Zotero is not running), the sidebar shows the copy of the annotations kept in literature notes, and `zotero://` links open the paper's literature note — see below
- **Zotero 7+** running locally (Zotero 10+ to send literature note edits back to Zotero)
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
- **Offline copy**: a literature note ends with a `zotero-annotations` block holding what the sidebar shows (paper details and annotations, as JSON; image annotations are copied to the image folder). It is shown as a single line ("12 Zotero annotations, copy of …") and cannot be edited in Obsidian. When Zotero cannot be reached — on your phone, or with Zotero closed — the sidebar shows this copy, marked "Offline copy". It is updated with the note, when the annotations change in Zotero.

### On mobile

Zotero only runs on a computer, so on a phone or tablet the plugin works from the vault: the sidebar shows the offline copy of the paper's literature note (only papers with a literature note), the "Mentioned in" section and the Papers list work as on desktop, and tapping a `zotero://` link opens the paper's literature note (when there is none, the link opens as before). Nothing is sent to Zotero from mobile; edits made there are sent by the computer once the notes are synced to it.

## Network use and files outside the vault

- **Network**: the plugin only talks to Zotero running on your own computer, through its local API (`http://localhost:23119`). Nothing is sent to any remote server, and there is no telemetry.
- **GitHub**: when a note cannot be converted safely for Zotero, the plugin offers to open a pre-filled GitHub issue in your browser. That issue contains the note's text; it is only submitted if you click "Submit" on GitHub yourself.
- **Files outside the vault** (read-only, through Node's `fs`): Zotero's local API serves neither the images of area annotations nor the files of images embedded in notes, so the plugin reads them in Zotero's data directory (set in the plugin settings, `~/Zotero` by default): annotation images in `cache/library/`, note images in `storage/` (at the path the API gives). They are shown in the sidebar, and copied into the vault when you drag an annotation into a note, or for literature notes (images in their Zotero notes, and every image annotation for the offline copy). The plugin never writes outside the vault.
- **Vault notes**: to list the notes that mention a paper ("Mentioned in"), the plugin reads the Markdown notes of the vault, looking for `zotero://` links. The index is kept in the plugin's folder (`mention-index.json`) and never leaves your computer.

## Installation

### From Obsidian

**Settings → Community plugins → Browse**, search for "Zotero Annotations", install and enable it.

### Manual

1. Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/bpiwowar/obsidian-zotero-annotations/releases/latest)
2. Copy them to `<vault>/.obsidian/plugins/zotero-annotations/`
3. Enable the plugin in Obsidian: **Settings → Community plugins → Zotero Annotations**

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
