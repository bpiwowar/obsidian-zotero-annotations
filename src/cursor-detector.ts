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

/** A zotero:// link of the personal library: a paper (`select`) or a PDF, possibly at an annotation (`open-pdf`) */
export interface ZoteroLink {
  kind: "select" | "open-pdf";
  /** The item of a `select` link, the attachment of an `open-pdf` one */
  key: string;
  /** The whole URL, query (page, annotation, locator…) included */
  url: string;
}

export type ZoteroLinkCallback = (link: ZoteroLink | null) => void;

export interface ZoteroLinkHandlers {
  onChange: ZoteroLinkCallback;
  onDoubleClick: (link: ZoteroLink) => void;
}

/** A zotero:// link and its query, as written bare or in a Markdown link */
const LINK_SOURCE = "zotero:\\/\\/(select|open-pdf)\\/library\\/items\\/([A-Z0-9]{8})(?![A-Z0-9])(?:\\?[^)\\s]*)?";

/** A Markdown link to a zotero:// URL: [text](zotero://…), the text possibly with escaped brackets */
const MD_LINK_SOURCE = `\\[(?:[^\\]\\\\]|\\\\.)*\\]\\((${LINK_SOURCE})\\)`;

/**
 * The Zotero link at a document position (inside or adjacent to it), as a
 * bare URL or a Markdown link [text](zotero://...).
 */
function getZoteroLinkAtPos(state: EditorState, pos: number): ZoteroLink | null {
  if (pos < 0 || pos > state.doc.length) return null;
  const line = state.doc.lineAt(pos);
  const offset = pos - line.from;
  for (const [source, group] of [[MD_LINK_SOURCE, 1], [LINK_SOURCE, 0]] as const) {
    const re = new RegExp(source, "gi");
    let match: RegExpExecArray | null;
    while ((match = re.exec(line.text)) !== null) {
      if (offset >= match.index && offset <= match.index + match[0].length) {
        return {
          kind: match[group + 1].toLowerCase() as ZoteroLink["kind"],
          key: match[group + 2].toUpperCase(),
          url: match[group],
        };
      }
    }
  }
  return null;
}

/**
 * Creates a CodeMirror ViewPlugin that monitors cursor position and clicks.
 * Calls `onChange` whenever the detected Zotero link changes, and
 * `onDoubleClick` when the user double-clicks on a zotero:// link.
 */
export function createCursorDetectorPlugin(handlers: ZoteroLinkHandlers) {
  return ViewPlugin.fromClass(
    class {
      private lastUrl: string | null = null;

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
        const link = getZoteroLinkAtPos(state, state.selection.main.head);
        if ((link?.url ?? null) !== this.lastUrl) {
          this.lastUrl = link?.url ?? null;
          handlers.onChange(link);
        }
      }
    },
    {
      eventHandlers: {
        dblclick(event: MouseEvent, view: EditorView) {
          const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
          if (pos === null) return false;
          const link = getZoteroLinkAtPos(view.state, pos);
          if (!link) return false;
          event.preventDefault();
          event.stopPropagation();
          handlers.onDoubleClick(link);
          return true;
        },
      },
    }
  );
}
