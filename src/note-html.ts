/**
 * Markdown of literature notes → Zotero note HTML, for write-back: the
 * inverse of `noteToMarkdown`. Quote links become highlights, citation links
 * citations, annotation images annotation images (see note-format.ts).
 *
 * Covers what Zotero notes can hold: paragraphs (a line break is `<br>`),
 * headings, lists, block quotes, code, math, tables, rules, and inline
 * emphasis, code, links and images. Obsidian-only syntax (wikilinks…) is
 * kept as text.
 */
import { NoteAnnotation, QuoteKind, parseAnnotationLink, parseCitationLink, parseImageAlt } from "./note-format";

/** An image of the note, as Zotero will reference it */
export interface ImageRef {
  /** Embedded-image attachment of the note */
  attachmentKey?: string;
  /** Otherwise the image itself (PNG or JPEG), imported by Zotero when the note is opened */
  dataUrl?: string;
}

export interface HtmlContext {
  /** "library/items/KEY" → Zotero URI ("http://zotero.org/users/1/items/KEY") */
  uri(target: string): string;
  /** Images, by source as written in the Markdown (see {@link imageSources}) */
  images: Map<string, ImageRef>;
  /** URI of the paper, cited by the quotes of its attachments */
  paper?: string;
}

const LIST_RE = /^( *)([-*+]|\d{1,9}[.)])( +|$)/;
const HR_RE = /^ {0,3}([-*_])( *\1){2,} *$/;
const TABLE_SEP_RE = /^ *\|? *:?-+:? *(\| *:?-+:? *)*\|? *$/;
const FENCE_RE = /^ *(`{3,}|~{3,})(.*)$/;
const HEADING_RE = /^ {0,3}(#{1,6})(?: +(.*?))?(?: +#+)? *$/;

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function dataAttr(value: unknown): string {
  return esc(encodeURIComponent(JSON.stringify(value)));
}

/** Tabs at the start of lines count as 4 spaces (Obsidian indents lists with tabs) */
function expandTabs(line: string): string {
  return line.replace(/^[ \t]+/, (lead) => lead.replace(/\t/g, "    "));
}

/** Number of `$$` in a line (outside inline code) */
function mathDelimiters(line: string): number {
  return (line.replace(/`[^`]*`/g, "").match(/(?<!\\)\$\$/g) || []).length;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** Sources of the images of a note, to resolve before {@link markdownToHtml} */
export function imageSources(md: string): string[] {
  const sources = new Set<string>();
  for (const m of md.matchAll(/!\[[^\]]*\]\(<?([^)>\s]+)>?\)/g)) sources.add(decodeImageSource(m[1]));
  for (const m of md.matchAll(/!\[\[([^\]|#]+)/g)) sources.add(m[1].trim());
  return [...sources];
}

function decodeImageSource(src: string): string {
  try {
    return decodeURI(src);
  } catch {
    return src;
  }
}

/** The note's Markdown as Zotero note HTML (without the `data-schema-version` wrapper) */
export function markdownToHtml(md: string, ctx: HtmlContext): string {
  const lines = md.replace(/\r\n?/g, "\n").split("\n").map(expandTabs);
  return new Converter(ctx).blocks(lines);
}

class Converter {
  constructor(private ctx: HtmlContext) {}

  // -------------------------------------------------------------------------
  // Blocks
  // -------------------------------------------------------------------------

  blocks(lines: string[]): string {
    const out: string[] = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        i++;
        continue;
      }
      let m: RegExpExecArray | null;

      if ((m = FENCE_RE.exec(line))) {
        const fence = m[1];
        const body: string[] = [];
        for (i++; i < lines.length && !lines[i].trim().startsWith(fence); i++) body.push(lines[i]);
        i++;
        out.push(`<pre><code>${esc(body.join("\n"))}</code></pre>`);
        continue;
      }

      if ((m = HEADING_RE.exec(line))) {
        out.push(`<h${m[1].length}>${this.inline(m[2] || "")}</h${m[1].length}>`);
        i++;
        continue;
      }

      if (HR_RE.test(line)) {
        out.push("<hr>");
        i++;
        continue;
      }

      if (/^ {0,3}>/.test(line)) {
        const body: string[] = [];
        for (; i < lines.length && /^ {0,3}>/.test(lines[i]); i++) body.push(lines[i].replace(/^ {0,3}> ?/, ""));
        out.push(`<blockquote>${this.blocks(body)}</blockquote>`);
        continue;
      }

      if (line.includes("|") && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]) && lines[i + 1].includes("-")) {
        const rows: string[] = [line];
        for (i += 2; i < lines.length && lines[i].includes("|") && lines[i].trim(); i++) rows.push(lines[i]);
        out.push(this.table(rows));
        continue;
      }

      if (LIST_RE.test(line)) {
        const list = this.list(lines, i);
        out.push(list.html);
        i = list.next;
        continue;
      }

      // Paragraph: up to a blank line or the start of another block, but
      // display math ($$ … $$, anywhere in lines) is read to its end
      const para: string[] = [line];
      let inMath = mathDelimiters(line) % 2 === 1;
      for (i++; i < lines.length; i++) {
        const l = lines[i];
        if (!inMath && (!l.trim() || this.startsBlock(l))) break;
        para.push(l);
        if (mathDelimiters(l) % 2 === 1) inMath = !inMath;
      }
      out.push(this.paragraph(para.map((l) => l.trim()).join("\n")));
    }
    return out.join("\n");
  }

  /** A paragraph, its display math taken out as blocks (Zotero has no inline display math) */
  private paragraph(text: string): string {
    const out: string[] = [];
    const parts = text.split(/(?<!\\)\$\$([\s\S]*?)(?<!\\)\$\$/);
    parts.forEach((part, k) => {
      if (k % 2 === 1) out.push(`<pre class="math">$$${esc(part.trim())}$$</pre>`);
      else if (part.trim()) out.push(`<p>${this.inline(part.trim())}</p>`);
    });
    return out.join("\n");
  }

  private startsBlock(line: string): boolean {
    return (
      FENCE_RE.test(line) ||
      HEADING_RE.test(line) ||
      HR_RE.test(line) ||
      /^ {0,3}>/.test(line) ||
      LIST_RE.test(line) ||
      line.trim().startsWith("$$")
    );
  }

  private list(lines: string[], start: number): { html: string; next: number } {
    const first = LIST_RE.exec(lines[start]) as RegExpExecArray;
    const indent = first[1].length;
    const ordered = /\d/.test(first[2]);
    const sameList = (line: string | undefined) => {
      const m = line === undefined ? null : LIST_RE.exec(line);
      return !!m && m[1].length === indent && /\d/.test(m[2]) === ordered;
    };
    const nextFilled = (from: number) => {
      let j = from;
      while (j < lines.length && !lines[j].trim()) j++;
      return j;
    };

    const items: string[][] = [];
    let tight = true;
    let i = start;
    while (sameList(lines[i])) {
      const m = LIST_RE.exec(lines[i]) as RegExpExecArray;
      const contentIndent = m[0].length;
      const item = [lines[i].slice(m[0].length)];
      for (i++; i < lines.length; ) {
        const line = lines[i];
        if (!line.trim()) {
          // A blank line belongs to the item when more of it follows (indented)
          const j = nextFilled(i);
          if (j < lines.length && indentOf(lines[j]) > indent) {
            tight = false;
            for (; i < j; i++) item.push("");
            continue;
          }
          break;
        }
        if (indentOf(line) <= indent) {
          // Lazy continuation of the item's last paragraph
          if (this.startsBlock(line) || !item[item.length - 1].trim()) break;
          item.push(line.trim());
          i++;
          continue;
        }
        item.push(line.slice(Math.min(indentOf(line), contentIndent)));
        i++;
      }
      items.push(item);
      if (i < lines.length && !lines[i].trim()) {
        const j = nextFilled(i);
        if (!sameList(lines[j])) break;
        tight = false;
        i = j;
      }
    }

    const tag = ordered ? "ol" : "ul";
    const order = ordered ? parseInt(first[2], 10) : 1;
    const attrs = `${ordered && order !== 1 ? ` start="${order}"` : ""}${tight ? ' data-tight="true"' : ""}`;
    const body = items.map((item) => `<li>${this.blocks(item)}</li>`).join("\n");
    return { html: `<${tag}${attrs}>\n${body}\n</${tag}>`, next: i };
  }

  private table(rows: string[]): string {
    const cells = (row: string) =>
      row
        .trim()
        .replace(/^\|/, "")
        .replace(/(?<!\\)\|$/, "")
        .split(/(?<!\\)\|/)
        .map((c) => this.inline(c.trim().replace(/\\\|/g, "|")));
    const [head, ...body] = rows;
    const tr = (row: string, tag: string) => `<tr>${cells(row).map((c) => `<${tag}>${c}</${tag}>`).join("")}</tr>`;
    return `<table>\n${[tr(head, "th"), ...body.map((r) => tr(r, "td"))].join("\n")}\n</table>`;
  }

  // -------------------------------------------------------------------------
  // Inline
  // -------------------------------------------------------------------------

  inline(text: string): string {
    let out = "";
    let i = 0;
    while (i < text.length) {
      const rest = text.slice(i);
      const ch = text[i];
      let m: RegExpExecArray | null;

      if (ch === "\\" && /^\\[!-/:-@[-`{-~]/.test(rest)) {
        out += esc(rest[1]);
        i += 2;
        continue;
      }
      if (ch === "\n" || (ch === " " && /^ {2,}\n/.test(rest)) || (ch === "\\" && rest[1] === "\n")) {
        out += "<br>";
        i += (/^[ \\]*\n/.exec(rest) as RegExpExecArray)[0].length;
        continue;
      }
      if (ch === "`" && (m = /^(`+)([\s\S]*?[^`])\1(?!`)/.exec(rest))) {
        out += `<code>${esc(m[2].trim())}</code>`;
        i += m[0].length;
        continue;
      }
      if (ch === "$" && (m = /^\$(?!\s)((?:\\.|[^$\\\n])+?)(?<!\s)\$(?!\d)/.exec(rest))) {
        out += `<span class="math">$${esc(m[1])}$</span>`;
        i += m[0].length;
        continue;
      }
      if (rest.startsWith("![[") && (m = /^!\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/.exec(rest))) {
        out += this.image(m[1].trim(), m[2] || "", m[0]);
        i += m[0].length;
        continue;
      }
      if (rest.startsWith("[[") && (m = /^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/.exec(rest))) {
        out += esc(m[2] ?? m[1]);
        i += m[0].length;
        continue;
      }
      if (ch === "!" && rest[1] === "[") {
        const link = parseLink(text, i + 1);
        if (link) {
          out += this.image(decodeImageSource(link.dest), link.label, text.slice(i, link.end));
          i = link.end;
          continue;
        }
      }
      if (ch === "[") {
        const link = parseLink(text, i);
        if (link) {
          out += this.link(link.label, link.dest);
          i = link.end;
          continue;
        }
      }
      if (ch === "<" && (m = /^<((?:https?|zotero|file):[^\s>]+)>/.exec(rest))) {
        out += this.link(m[1], m[1]);
        i += m[0].length;
        continue;
      }
      if (ch === "<" && (m = /^<\/?(sub|sup|u|s|br)\s*\/?>/i.exec(rest))) {
        out += m[0].toLowerCase();
        i += m[0].length;
        continue;
      }
      const emphasis = ch === "*" || ch === "_" || ch === "~" ? this.emphasis(text, i) : null;
      if (emphasis) {
        out += emphasis.html;
        i += emphasis.length;
        continue;
      }
      out += esc(ch);
      i++;
    }
    return out;
  }

  /** Emphasis (bold, italic, strikethrough) starting at `i` */
  private emphasis(text: string, i: number): { html: string; length: number } | null {
    const rest = text.slice(i);
    const wordBefore = i > 0 && /\w/.test(text[i - 1]);
    const patterns: [RegExp, string][] = [
      [/^\*\*(?=\S)([\s\S]*?\S)\*\*/, "strong"],
      [/^__(?=\S)([\s\S]*?\S)__(?!\w)/, "strong"],
      [/^~~(?=\S)([\s\S]*?\S)~~/, "s"],
      [/^\*(?=[^\s*])([\s\S]*?[^\s*]|[^\s*])\*(?!\*)/, "em"],
      [/^_(?=[^\s_])([\s\S]*?[^\s_]|[^\s_])_(?!\w)/, "em"],
    ];
    for (const [re, tag] of patterns) {
      // "snake_case" is not emphasis
      if (rest.startsWith("_") && wordBefore) continue;
      const m = re.exec(rest);
      if (m) return { html: `<${tag}>${this.inline(m[1])}</${tag}>`, length: m[0].length };
    }
    return null;
  }

  private link(label: string, href: string): string {
    const quote = parseAnnotationLink(href);
    if (quote) return this.quote(label, quote.target, quote.annotation, quote.kind);

    const cited = parseCitationLink(href);
    const paren = /^\(([\s\S]*)\)$/.exec(label.trim());
    if (cited && paren) {
      const item: Record<string, unknown> = { uris: [this.ctx.uri(cited.target)] };
      if (cited.locator) item.locator = cited.locator;
      const citation = { citationItems: [item], properties: {} };
      return `<span class="citation" data-citation="${dataAttr(citation)}">(<span class="citation-item">${this.inline(paren[1])}</span>)</span>`;
    }
    return `<a href="${esc(href)}" rel="noopener noreferrer nofollow">${this.inline(label)}</a>`;
  }

  private annotationData(target: string, annotation: NoteAnnotation): NoteAnnotation & { citationItem?: unknown } {
    // Zotero's key order
    const { annotationKey, color, pageLabel, position } = annotation;
    const citationItem = this.ctx.paper ? { uris: [this.ctx.paper], locator: pageLabel } : undefined;
    return { attachmentURI: this.ctx.uri(target), annotationKey, color, pageLabel, position, citationItem };
  }

  private quote(label: string, target: string, annotation: NoteAnnotation, kind: QuoteKind): string {
    const data = this.annotationData(target, annotation);
    return `<span class="${kind}" data-annotation="${dataAttr(data)}">${this.inline(label)}</span>`;
  }

  /** `alt` may end with Obsidian's "|width" (or "|widthxheight"); `source` is the Markdown kept when unresolved */
  private image(src: string, alt: string, source: string): string {
    const ref = this.ctx.images.get(src);
    if (!ref) return esc(source);
    const m = /^([\s\S]*?)(?:\|(\d+)(?:x(\d+))?)?$/.exec(alt) as RegExpExecArray;
    const attrs: string[] = [];
    if (ref.attachmentKey) attrs.push(`data-attachment-key="${esc(ref.attachmentKey)}"`);
    else if (ref.dataUrl) attrs.push(`src="${esc(ref.dataUrl)}"`);
    if (m[2]) attrs.push(`width="${m[2]}"`);
    if (m[3]) attrs.push(`height="${m[3]}"`);
    const annotation = parseImageAlt(m[1]);
    if (annotation) attrs.push(`data-annotation="${dataAttr(this.annotationData(annotation.target, annotation.annotation))}"`);
    return `<img ${attrs.join(" ")}>`;
  }
}

/** `[label](dest)` at `start` (on the "["), with nested brackets in the label */
function parseLink(text: string, start: number): { label: string; dest: string; end: number } | null {
  let depth = 0;
  let i = start;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "[") depth++;
    else if (ch === "]" && --depth === 0) break;
  }
  if (depth !== 0 || text[i + 1] !== "(") return null;
  const label = text.slice(start + 1, i);
  const rest = text.slice(i + 2);
  const m = /^<([^>]*)>\)|^([^\s()]*(?:\([^\s()]*\)[^\s()]*)*)\)/.exec(rest);
  if (!m) return null;
  return { label, dest: m[1] ?? m[2], end: i + 2 + m[0].length };
}
