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

export interface ZoteroLinkHandlers {
  onChange: ZoteroLinkCallback;
  onDoubleClick: (itemKey: string) => void;
}

/**
 * Regex to match a full markdown link whose URL is a zotero:// link:
 * [any text](zotero://select/library/items/ITEMKEY)
 */
const ZOTERO_MD_LINK_RE = /\[[^\]]*\]\(zotero:\/\/select\/library\/items\/([A-Z0-9]{8})\)/gi;

/**
 * Extracts a Zotero item key for a given document position (inside or adjacent
 * to a zotero:// link). Matches both bare zotero:// URLs and markdown links
 * [text](zotero://...).
 */
function getZoteroKeyAtPos(state: EditorState, pos: number): string | null {
  if (pos < 0 || pos > state.doc.length) return null;
  const line = state.doc.lineAt(pos);
  const lineText = line.text;
  const lineFrom = line.from;

  let match: RegExpExecArray | null;
  const mdRe = new RegExp(ZOTERO_MD_LINK_RE.source, "gi");
  while ((match = mdRe.exec(lineText)) !== null) {
    const linkStart = lineFrom + match.index;
    const linkEnd = linkStart + match[0].length;
    if (pos >= linkStart && pos <= linkEnd) {
      return match[1].toUpperCase();
    }
  }

  const bareRe = new RegExp(ZOTERO_LINK_RE.source, "gi");
  while ((match = bareRe.exec(lineText)) !== null) {
    const linkStart = lineFrom + match.index;
    const linkEnd = linkStart + match[0].length;
    if (pos >= linkStart && pos <= linkEnd) {
      return match[1].toUpperCase();
    }
  }

  return null;
}

/**
 * Creates a CodeMirror ViewPlugin that monitors cursor position and clicks.
 * Calls `onChange` whenever the detected Zotero item key changes, and
 * `onDoubleClick` when the user double-clicks on a zotero:// link.
 */
export function createCursorDetectorPlugin(handlers: ZoteroLinkHandlers) {
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
        const key = getZoteroKeyAtPos(state, state.selection.main.head);
        if (key !== this.lastKey) {
          this.lastKey = key;
          handlers.onChange(key);
        }
      }
    },
    {
      eventHandlers: {
        dblclick(event: MouseEvent, view: EditorView) {
          const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
          if (pos === null) return false;
          const key = getZoteroKeyAtPos(view.state, pos);
          if (!key) return false;
          event.preventDefault();
          event.stopPropagation();
          handlers.onDoubleClick(key);
          return true;
        },
      },
    }
  );
}
