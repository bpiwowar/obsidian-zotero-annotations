/**
 * Text of literature notes: file names, links, and the regions that mirror
 * Zotero child notes.
 */
import { getFrontMatterInfo, parseYaml } from "obsidian";
import { ZoteroAnnotation, ZoteroApiItem } from "./zotero-client";

/** How note names shorten titles */
export interface ShortTitleOptions {
  /** Most words kept */
  maxWords: number;
  /** The title is cut at the first of these characters (e.g. ":") */
  cutAt: string;
}

/**
 * A short, file-name friendly version of a title:
 * "Don't Forget Your Embeddings: Robust…" → "Don t Forget Your Embeddings".
 * Punctuation becomes spaces; the case is kept.
 */
export function shortTitle(title: string, { maxWords, cutAt }: ShortTitleOptions): string {
  const toWords = (text: string) =>
    text
      .replace(/[^\p{L}\p{N}-]+/gu, " ")
      .split(" ")
      .filter((w) => w && w !== "-");
  let text = title;
  for (const ch of cutAt) {
    const i = text.indexOf(ch);
    // A cut leaving a lone word ("BERT: Pre-training…") says too little
    if (i > 0 && toWords(text.slice(0, i)).length > 1) text = text.slice(0, i);
  }
  return toWords(text).slice(0, Math.max(1, maxWords)).join(" ");
}

/** Vault path (without `.md`) of a new literature note: "<folder>/<Short title> – KEY" */
export function notePath(item: ZoteroApiItem, folder: string, options: ShortTitleOptions): string {
  const title = shortTitle((item.data.title as string) || "", options);
  const name = title ? `${title} – ${item.key}` : item.key;
  return folder ? `${folder.replace(/\/+$/, "")}/${name}` : name;
}

/** `zotero://select` link to an item */
export function itemBacklink(key: string): string {
  return `zotero://select/library/items/${key}`;
}

/** `file://` URL of a local file */
export function fileUrl(path: string): string {
  return "file://" + encodeURI(path).replace(/#/g, "%23");
}

/**
 * The attachment a literature note links to: the first PDF on this
 * computer, or else the first attachment file (EPUB, snapshot…).
 */
export function mainAttachment(
  attachments: ZoteroApiItem[],
  filePaths: Map<string, string>
): { key: string; path: string } | null {
  const local = attachments.filter((a) => filePaths.has(a.key));
  const main = local.find((a) => a.data.contentType === "application/pdf") ?? local[0];
  return main ? { key: main.key, path: filePaths.get(main.key) as string } : null;
}

/** Opens an attachment in Zotero's reader */
export function attachmentReaderLink(key: string): string {
  return `zotero://open-pdf/library/items/${key}`;
}

/** `data-annotation` of a quote (highlight or underline) in Zotero note HTML */
export interface NoteAnnotation {
  attachmentURI?: string;
  annotationKey?: string;
  color?: string;
  pageLabel?: string;
  position?: {
    pageIndex?: number;
    rects?: number[][];
    nextPageRects?: number[][];
    /** EPUB (FragmentSelector) and snapshot (CssSelector) positions */
    type?: string;
    conformsTo?: string;
    value?: string;
  };
}

/** How Zotero marks a quote in note HTML */
export type QuoteKind = "highlight" | "underline";

const OPEN_PDF = "zotero://open-pdf/";

const EPUB_CFI = "http://www.idpf.org/epub/linking/cfi/epub-cfi.html";

/** "x1,y1,x2,y2;x1,y1,x2,y2" (to 0.01 pt) */
function encodeRects(rects: number[][]): string {
  return rects.map((r) => r.map((n) => Math.round(n * 100) / 100).join(",")).join(";");
}

/**
 * `zotero://open-pdf` link to a quote, as Zotero's own Markdown export writes
 * it (`page` counts from 1; `cfi`/`sel` for EPUBs and snapshots; `annotation`
 * when the quote comes from an annotation). The other parameters, ignored by
 * Zotero, keep what is needed to rebuild the quote when the note goes back to
 * Zotero: `label` (page label, when not the page number), `rects` and `next`
 * (highlight rectangles on the page and on the next one), `color` and
 * `kind=underline`. {@link parseAnnotationLink} reads them back.
 */
export function annotationLink(target: string, annotation: NoteAnnotation, kind: QuoteKind = "highlight"): string {
  const params: string[] = [];
  const pos = annotation.position;
  if (pos?.type === "FragmentSelector" && pos.value) {
    params.push(`cfi=${encodeURIComponent(pos.value)}`);
  } else if (pos?.type === "CssSelector" && pos.value) {
    params.push(`sel=${encodeURIComponent(pos.value)}`);
  } else if (typeof pos?.pageIndex === "number") {
    const page = String(pos.pageIndex + 1);
    params.push(`page=${page}`);
    if (annotation.pageLabel && annotation.pageLabel !== page) {
      params.push(`label=${encodeURIComponent(annotation.pageLabel)}`);
    }
  } else if (annotation.pageLabel) {
    params.push(`label=${encodeURIComponent(annotation.pageLabel)}`);
  }
  if (annotation.annotationKey) params.push(`annotation=${annotation.annotationKey}`);
  if (pos?.rects?.length) params.push(`rects=${encodeRects(pos.rects)}`);
  if (pos?.nextPageRects?.length) params.push(`next=${encodeRects(pos.nextPageRects)}`);
  if (annotation.color) params.push(`color=${annotation.color.replace(/^#/, "")}`);
  if (kind !== "highlight") params.push(`kind=${kind}`);
  return `${OPEN_PDF}${target}${params.length ? `?${params.join("&")}` : ""}`;
}

/** "x1,y1,x2,y2;…" → rectangles */
function decodeRects(text: string): number[][] {
  return text
    .split(";")
    .map((r) => r.split(",").map(Number))
    .filter((r) => r.length === 4 && r.every((n) => Number.isFinite(n)));
}

/** "zotero://<kind>/library/items/KEY?a=b" → target ("library/items/KEY") and parameters */
function parseZoteroUrl(href: string, kind: string): { target: string; params: URLSearchParams } | null {
  const m = new RegExp(`^zotero://${kind}/((?:library|groups/\\d+)/items/[A-Z0-9]{8})(?:\\?(.*))?$`).exec(href.trim());
  return m ? { target: m[1], params: new URLSearchParams(m[2] || "") } : null;
}

/** The quote of a {@link annotationLink} (attachmentURI left to the caller), or null for other links */
export function parseAnnotationLink(
  href: string
): { target: string; annotation: NoteAnnotation; kind: QuoteKind } | null {
  const url = parseZoteroUrl(href, "open-pdf");
  if (!url) return null;
  const p = url.params;
  const annotation: NoteAnnotation = {};
  const key = p.get("annotation");
  if (key) annotation.annotationKey = key;
  const color = p.get("color");
  if (color) annotation.color = `#${color}`;
  const page = p.get("page");
  const label = p.get("label") ?? page;
  if (label) annotation.pageLabel = label;
  const cfi = p.get("cfi");
  const sel = p.get("sel");
  if (cfi) {
    annotation.position = { type: "FragmentSelector", conformsTo: EPUB_CFI, value: cfi };
  } else if (sel) {
    annotation.position = { type: "CssSelector", value: sel };
  } else if (page && /^\d+$/.test(page)) {
    annotation.position = { pageIndex: parseInt(page, 10) - 1 };
    const rects = p.get("rects");
    if (rects) annotation.position.rects = decodeRects(rects);
    const next = p.get("next");
    if (next) annotation.position.nextPageRects = decodeRects(next);
  }
  return { target: url.target, annotation, kind: p.get("kind") === "underline" ? "underline" : "highlight" };
}

/** `zotero://select` link to a cited item; `locator` is the cited page */
export function citationLink(target: string, locator?: string): string {
  return `zotero://select/${target}${locator ? `?locator=${encodeURIComponent(locator)}` : ""}`;
}

/** The cited item of a {@link citationLink}, or null for other links */
export function parseCitationLink(href: string): { target: string; locator?: string } | null {
  const url = parseZoteroUrl(href, "select");
  if (!url) return null;
  const locator = url.params.get("locator");
  return locator ? { target: url.target, locator } : { target: url.target };
}

/** Display width of annotation images without one (Obsidian's `![alt|width](…)`) */
const IMAGE_WIDTH = 300;

/**
 * An annotation image copied into the vault. Its alt text is the annotation
 * link without its scheme (what write-back needs, as for quotes; a full URL
 * would be shown as a link):
 * `![library/items/ATT?page=3&annotation=KEY&rects=…|300](images/KEY.png)`.
 */
export function annotationImage(imagePath: string, href: string, width: number = IMAGE_WIDTH): string {
  const alt = href.startsWith(OPEN_PDF) ? href.slice(OPEN_PDF.length) : href;
  return `![${alt}|${width}](${encodeURI(imagePath)})`;
}

/** The annotation of an {@link annotationImage}'s alt text (without its `|width`), or null */
export function parseImageAlt(alt: string): ReturnType<typeof parseAnnotationLink> {
  return /^(library|groups\/\d+)\/items\//.test(alt) ? parseAnnotationLink(OPEN_PDF + alt) : null;
}

/** Text usable as a Markdown link label */
function linkLabel(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(/([\\[\]])/g, "\\$1");
}

/**
 * An annotation as Zotero writes it when added to a note, in the Markdown of
 * literature notes: the quote linking to the PDF, the citation linking to the
 * paper, then the comment —
 * `[“quoted text”](zotero://open-pdf/…) [(Doe, 2020, p. 3)](zotero://select/…) comment`.
 * An image annotation is its image (copied into the vault, see `annotationImage`)
 * followed by the citation.
 */
export function annotationMarkdown(
  annotation: ZoteroAnnotation,
  parentKey: string,
  citation: string,
  /** Vault path of the image of an image annotation, once copied into the vault */
  imagePath?: string
): string {
  const parts: string[] = [];
  const href = annotationLink(`library/items/${annotation.attachmentKey}`, {
    annotationKey: annotation.key,
    pageLabel: annotation.pageLabel,
    position: annotation.position ?? undefined,
  });
  if (annotation.type === "image") {
    // As Zotero puts it in notes: the image, then the citation
    parts.push(imagePath ? annotationImage(imagePath, href) : `[Image](${href})`);
  } else if (annotation.text) {
    parts.push(`[${linkLabel(`“${annotation.text}”`)}](${href})`);
  }
  const cite = [citation, annotation.pageLabel && `p. ${annotation.pageLabel}`].filter(Boolean).join(", ");
  if (cite) {
    const href = citationLink(`library/items/${parentKey}`, annotation.pageLabel || undefined);
    parts.push(`[${linkLabel(`(${cite})`)}](${href})`);
  }
  if (annotation.comment) parts.push(annotation.comment.trim());
  // An image goes on its own line, the citation and comment below it
  const [first, ...rest] = parts;
  const sep = annotation.type === "image" && imagePath ? "\n" : " ";
  return rest.length ? `${first}${sep}${rest.join(" ")}` : (first ?? "");
}

/** Drag data of an annotation whose drop needs the plugin (copying an image into the vault) */
export const ANNOTATION_DRAG_TYPE = "application/x-zotero-annotation";

export interface AnnotationDrag {
  annotation: ZoteroAnnotation;
  parentKey: string;
  citation: string;
  /** Zotero's rendering of the image (its cache file) */
  imagePath: string;
}

/** One Zotero child note, as a region of the literature note (`key` null: not in Zotero yet) */
export function noteRegion(key: string | null, body: string): string {
  return `%%zt-note${key ? `: ${key}` : ""}%%\n${body.trim()}\n%%/zt-note%%`;
}

const NOTE_REGION_RE = /^%%zt-note(?::\s*([A-Z0-9]{8}))?%%\n([\s\S]*?)\n?^%%\/zt-note%%$/gm;

export interface NoteRegion {
  key: string | null;
  body: string;
  start: number;
  end: number;
}

export function parseRegions(text: string): NoteRegion[] {
  const regions: NoteRegion[] = [];
  NOTE_REGION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NOTE_REGION_RE.exec(text)) !== null) {
    regions.push({ key: m[1] || null, body: m[2], start: m.index, end: m.index + m[0].length });
  }
  return regions;
}

/** Frontmatter property naming the Zotero note a literature note holds without markers */
export const SINGLE_NOTE_PROPERTY = "zotero-note";

/** The regions of a literature note and where its body starts */
export interface NoteLayout {
  regions: NoteRegion[];
  /** The whole body is one Zotero note, named in the frontmatter (no `zt-note` markers) */
  bare: boolean;
  /** Offset of the text after the frontmatter */
  contentStart: number;
}

/**
 * Reads the Zotero notes of a literature note. Markers are only needed for
 * several notes: a note mirroring a single Zotero note is the body itself,
 * its key in the `zotero-note` property.
 */
export function noteLayout(text: string): NoteLayout {
  const info = getFrontMatterInfo(text);
  const regions = parseRegions(text);
  if (regions.length > 0) return { regions, bare: false, contentStart: info.contentStart };
  let key: unknown = null;
  try {
    const fm = info.exists ? (parseYaml(info.frontmatter) as Record<string, unknown> | null) : null;
    key = fm?.[SINGLE_NOTE_PROPERTY];
  } catch {
    // unreadable frontmatter
  }
  const body = text.slice(info.contentStart);
  if (typeof key !== "string" || !/^[A-Z0-9]{8}$/.test(key) || !body.trim()) {
    return { regions: [], bare: false, contentStart: info.contentStart };
  }
  return {
    regions: [{ key, body: body.trim(), start: info.contentStart, end: text.length }],
    bare: true,
    contentStart: info.contentStart,
  };
}
