/**
 * Offline copy of what the sidebar shows for a paper, kept at the end of its
 * literature note so that it travels with the vault (to a phone, or for when
 * Zotero is not running):
 *
 *     ```zotero-annotations
 *     {"format":1,"cached":"2026-10-09T10:00:00.000Z","info":{…},"annotations":[
 *     {…one annotation per line…}
 *     ]}
 *     ```
 *
 * The plugin renders the block as a one-line summary and keeps it read-only
 * in the editor. The JSON never contains "zotero://" (written `zotero:\/\/`)
 * so that the mention index does not count it, nor backticks (`\u0060`),
 * which could close the block.
 */
import { EditorState, Extension } from "@codemirror/state";
import { ZoteroAnnotation, ZoteroItemInfo } from "./zotero-client";

/** Language of the fenced block */
export const CACHE_LANGUAGE = "zotero-annotations";

const CACHE_FORMAT = 1;

export interface AnnotationCache {
  format: number;
  /** When it was written (ISO date) */
  cached: string;
  /** The paper, without its notes (the literature note holds them) */
  info: ZoteroItemInfo;
  annotations: ZoteroAnnotation[];
}

const OPENING = "```" + CACHE_LANGUAGE + "\n";

/** Offset of the opening fence of a note's cache block, or -1 */
function cacheBlockStart(text: string): number {
  const { json, text: before } = splitCache(text);
  return json === null ? -1 : text.indexOf(OPENING, before.length);
}

/**
 * Keeps the cache block read-only in the editor: typing, deleting, pasting
 * or moving text in it is dropped. Changes made by the plugin (and by
 * anything that is not a user edit) go through. Text can still be typed right
 * before the block.
 */
export const readOnlyCache: Extension = EditorState.changeFilter.of((tr) => {
  if (!tr.docChanged || !["input", "delete", "move"].some((e) => tr.isUserEvent(e))) return true;
  const doc = tr.startState.doc;
  const start = cacheBlockStart(doc.toString());
  return start < 0 ? true : [start + 1, doc.length];
});

/** A note's text without its cache block (the last thing in the note), and the block's JSON (null when none) */
export function splitCache(text: string): { text: string; json: string | null } {
  const start = text.lastIndexOf(OPENING);
  if (start < 0 || (start > 0 && text[start - 1] !== "\n")) return { text, json: null };
  const m = /^([\s\S]*?)\n?```[ \t]*\s*$/.exec(text.slice(start + OPENING.length));
  if (!m) return { text, json: null };
  // Blank lines before the block go with it, the newline ending the text stays
  let end = start;
  while (end > 1 && text[end - 1] === "\n" && text[end - 2] === "\n") end--;
  return { text: text.slice(0, end), json: m[1] };
}

/** Reads the JSON of a cache block; null when unreadable or of another format */
export function parseCache(json: string): AnnotationCache | null {
  try {
    const cache = JSON.parse(json) as AnnotationCache | null;
    if (cache?.format !== CACHE_FORMAT || !cache.info || !Array.isArray(cache.annotations)) return null;
    return cache;
  } catch {
    return null;
  }
}

/** Keeps a JSON string safe inside the note (see above); JSON.parse reads it back unchanged */
function escapeJson(json: string): string {
  return json.replace(/`/g, "\\u0060").replace(/zotero:\/\//g, "zotero:\\/\\/");
}

/** The JSON of a cache block */
export function formatCache(info: ZoteroItemInfo, annotations: ZoteroAnnotation[], cached: Date = new Date()): string {
  const head = JSON.stringify({ format: CACHE_FORMAT, cached: cached.toISOString(), info: { ...info, notes: [] } });
  const lines = annotations.map((a) => JSON.stringify(a));
  return escapeJson(`${head.slice(0, -1)},"annotations":[\n${lines.join(",\n")}\n]}`);
}

/** Whether two cache JSONs hold the same data (their dates aside) */
export function sameCache(a: string, b: string): boolean {
  const pa = parseCache(a);
  const pb = parseCache(b);
  return (
    !!pa && !!pb && JSON.stringify([pa.info, pa.annotations]) === JSON.stringify([pb.info, pb.annotations])
  );
}

/** `text` with `json` as its cache block (replacing any), or without a block when `json` is null */
export function withCache(text: string, json: string | null): string {
  const body = splitCache(text).text;
  if (json === null) return body;
  const trimmed = body.replace(/\s+$/, "");
  return `${trimmed ? `${trimmed}\n\n` : ""}\`\`\`${CACHE_LANGUAGE}\n${json}\n\`\`\`\n`;
}
