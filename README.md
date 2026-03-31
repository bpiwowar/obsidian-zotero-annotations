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

## Requirements

- **Zotero 7+** running locally
- Zotero's local API enabled: **Settings → Advanced → "Allow other applications on this computer to communicate with Zotero"**

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

## Known limitations

- Only personal libraries are supported (`users/0`). Group libraries use a different API path.
- Image annotations require access to the Zotero data directory (`~/Zotero/cache/library/`). If your Zotero data directory is in a non-default location, images won't load.
- No settings UI yet.

## License

MIT
