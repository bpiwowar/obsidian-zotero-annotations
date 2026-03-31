import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { EditorState } from "@codemirror/state";

/**
 * Regex to match zotero://select/library/items/ITEMKEY patterns.
 * The item key is an 8-char alphanumeric string.
 */
const ZOTERO_LINK_RE = /zotero:\/\/select\/library\/items\/([A-Z0-9]{8})/i;

/**
 * Extracts a Zotero item key from a URL string, if it matches.
 */
export function extractZoteroKey(url: string): string | null {
  const match = ZOTERO_LINK_RE.exec(url);
  return match ? match[1].toUpperCase() : null;
}

export type ZoteroLinkCallback = (itemKey: string | null) => void;

/**
 * Regex to match a full markdown link whose URL is a zotero:// link:
 * [any text](zotero://select/library/items/ITEMKEY)
 */
const ZOTERO_MD_LINK_RE = /\[[^\]]*\]\(zotero:\/\/select\/library\/items\/([A-Z0-9]{8})\)/gi;

/**
 * Extracts a Zotero item key if the cursor is currently positioned
 * inside (or adjacent to) a zotero:// link in the given editor state.
 * Matches both bare zotero:// URLs and markdown links [text](zotero://...).
 */
function getZoteroKeyAtCursor(state: EditorState): string | null {
  const cursor = state.selection.main.head;
  const line = state.doc.lineAt(cursor);
  const lineText = line.text;
  const lineFrom = line.from;

  // First try markdown links [text](zotero://...) — cursor anywhere in the full link
  let match: RegExpExecArray | null;
  const mdRe = new RegExp(ZOTERO_MD_LINK_RE.source, "gi");
  while ((match = mdRe.exec(lineText)) !== null) {
    const linkStart = lineFrom + match.index;
    const linkEnd = linkStart + match[0].length;
    if (cursor >= linkStart && cursor <= linkEnd) {
      return match[1].toUpperCase();
    }
  }

  // Fall back to bare zotero:// URLs (not inside markdown link syntax)
  const bareRe = new RegExp(ZOTERO_LINK_RE.source, "gi");
  while ((match = bareRe.exec(lineText)) !== null) {
    const linkStart = lineFrom + match.index;
    const linkEnd = linkStart + match[0].length;
    if (cursor >= linkStart && cursor <= linkEnd) {
      return match[1].toUpperCase();
    }
  }

  return null;
}

/**
 * Creates a CodeMirror ViewPlugin that monitors cursor position
 * and calls `onChange` whenever the detected Zotero item key changes.
 */
export function createCursorDetectorPlugin(onChange: ZoteroLinkCallback) {
  return ViewPlugin.fromClass(
    class {
      private lastKey: string | null = null;

      constructor(view: EditorView) {
        this.check(view.state);
      }

      update(update: ViewUpdate) {
        // Only check when selection changes or document changes
        if (update.selectionSet || update.docChanged) {
          this.check(update.state);
        }
      }

      private check(state: EditorState) {
        const key = getZoteroKeyAtCursor(state);
        if (key !== this.lastKey) {
          this.lastKey = key;
          onChange(key);
        }
      }
    }
  );
}
