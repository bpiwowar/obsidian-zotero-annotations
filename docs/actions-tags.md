# Actions & Tags examples

[Actions & Tags](https://github.com/windingwind/zotero-actions-tags) is a Zotero add-on that runs scripts from a shortcut or a right-click menu. The actions below put the `zotero://` links the plugin follows on the clipboard.

## Installing

1. Download the `.xpi` from the [latest release of Actions & Tags](https://github.com/windingwind/zotero-actions-tags/releases/latest), then in Zotero **Tools → Add-ons → ⚙ → Install Add-on From File…**
2. Either import the actions below at once: download [`actions-tags.yml`](actions-tags.yml), then in **Zotero Settings → Actions & Tags**, use the import button and pick the file;
3. or create them one by one: in **Zotero Settings → Actions & Tags**, click **+** and fill in the fields given with each action.

Then add a **Shortcut** to the actions you use most (imported actions have none).

## Copying Zotero links

One script, three actions: only the `format` setting at its top changes.

| Action | `format` | Copies |
|---|---|---|
| Copy Zotero link | `"uri"` | `zotero://select/library/items/KEY` |
| Copy Markdown link | `"md"` | `[Title (Doe et al., 2020)](zotero://select/library/items/KEY)` |
| Copy quote | `"quote"` | `[“quoted text”](zotero://open-pdf/…) [(Doe et al., 2020, p. 3)](zotero://select/…?locator=3) comment` |

What the link points to depends on what is selected:

- a paper (or one of its notes) → `zotero://select/library/items/KEY`, which selects it in the library;
- a PDF → `zotero://open-pdf/library/items/KEY`, which opens it in Zotero's reader;
- an annotation, in the PDF reader's sidebar → `zotero://open-pdf/library/items/KEY?page=3&annotation=ANNOTATIONKEY`, which opens the PDF at the annotation. With `"quote"`, the annotation is copied as the plugin's drag and drop inserts it: the quoted text, the citation, then the comment.

With the cursor on any of these links, the sidebar shows the paper's annotations (for a PDF link, those of the paper the PDF belongs to). Double-clicking a link opens it in Zotero.

Several items can be selected at once: their links are copied one per line.

Fields:

- **Event**: None
- **Operation**: Script
- **Data**: the script below
- **Menu Label**: e.g. "Copy Markdown link", so that it shows in the right-click menus of the library and of the reader's annotations

```js
/**
 * Copy Zotero links for the Zotero Annotations Obsidian plugin
 * @usage Select papers in the library, or annotations in the PDF reader, and run the action
 * @link https://github.com/bpiwowar/obsidian-zotero-annotations/blob/main/docs/actions-tags.md
 */

// What to copy:
//   "uri"   — the bare link: zotero://select/library/items/KEY
//   "md"    — a Markdown link: [Title (Doe et al., 2020)](zotero://…)
//   "quote" — for annotations, what the plugin's drag and drop inserts:
//             [“text”](zotero://open-pdf/…) [(Doe et al., 2020, p. 3)](zotero://select/…) comment
//             (other items get a Markdown link)
const format = "md";

// Run once for all the selected items, not once per item
if (item) return;
if (!items?.length) return "[Copy Zotero link] nothing selected";

/** "library" for the personal library, "groups/ID" for a group (the plugin only follows the former) */
function library(it) {
  const lib = Zotero.Libraries.get(it.libraryID);
  return lib.libraryType === "user" ? "library" : `groups/${lib.groupID}`;
}

/** "Doe", "Doe & Roe", "Doe et al.", followed by the year */
function citation(paper) {
  const names = paper.getCreators().map((c) => c.lastName || c.name).filter(Boolean);
  const who = names.length > 2 ? `${names[0]} et al.` : names.join(" & ");
  return [who, paper.getField("year")].filter(Boolean).join(", ");
}

/** Text that can go between the brackets of a Markdown link */
function label(text) {
  return text.replace(/\s+/g, " ").trim().replace(/([\\[\]])/g, "\\$1");
}

function markdownLink(paper, uri) {
  const cite = citation(paper);
  return `[${label(paper.getField("title") + (cite ? ` (${cite})` : ""))}](${uri})`;
}

async function copy(it) {
  if (it.isAnnotation()) {
    const attachment = it.parentItem;
    const paper = attachment.parentItem ?? attachment;
    const params = [];
    try {
      const { pageIndex } = JSON.parse(it.annotationPosition);
      if (typeof pageIndex === "number") params.push(`page=${pageIndex + 1}`);
    } catch (e) {
      Zotero.warn(e);
    }
    params.push(`annotation=${it.key}`);
    const uri = `zotero://open-pdf/${library(attachment)}/items/${attachment.key}?${params.join("&")}`;
    if (format === "uri") return uri;
    if (format === "md") return markdownLink(paper, uri);

    const parts = [];
    if (it.annotationText) parts.push(`[${label(`“${it.annotationText}”`)}](${uri})`);
    const page = it.annotationPageLabel;
    const cite = [citation(paper), page && `p. ${page}`].filter(Boolean).join(", ");
    const locator = page ? `?locator=${encodeURIComponent(page)}` : "";
    if (cite) parts.push(`[${label(`(${cite})`)}](zotero://select/${library(paper)}/items/${paper.key}${locator})`);
    if (it.annotationComment) parts.push(it.annotationComment.trim());
    return parts.join(" ");
  }

  // A PDF opens in the reader, anything else (paper, note, other attachment) selects its paper
  const paper = it.isRegularItem() ? it : (it.parentItem ?? it);
  const uri = it.isPDFAttachment()
    ? `zotero://open-pdf/${library(it)}/items/${it.key}`
    : `zotero://select/${library(paper)}/items/${paper.key}`;
  return format === "uri" ? uri : markdownLink(paper, uri);
}

const texts = [];
for (const it of items) texts.push(await copy(it));

const clipboard = new Zotero.ActionsTags.api.utils.ClipboardHelper();
clipboard.addText(texts.join(format === "quote" ? "\n\n" : "\n"), "text/unicode");
clipboard.copy();

return `[Copy Zotero link] ${texts.length} link(s) copied`;
```

Items of a group library get `zotero://…/groups/ID/items/KEY` links, which open in Zotero but are not followed by the plugin (it only reads the personal library).
