/**
 * Library search with fields — `attention author:vaswani tag:"to read" year:2017-2019`
 * — and the labels of the links to the items found (templates).
 *
 * Zotero's API filters on tags and item types; the other fields go into its
 * quick search (title, creators, year) and are then checked on each result.
 */
import { ZoteroApiItem, creatorNames, itemSummary } from "./zotero-client";

export interface LibraryQuery {
  /** Quick search text: free words and the values of author/title/year */
  q: string;
  /** Tags the items have (`-tag` they do not), for the API */
  tags: string[];
  /** Item type (`-type` excluded), for the API */
  itemType?: string;
  /** Checks of each result on what the quick search only roughly matches */
  checks: ((item: ZoteroApiItem) => boolean)[];
}

/** Query fields (and their short names) → field */
const FIELDS: Record<string, "author" | "title" | "year" | "tag" | "type"> = {
  author: "author",
  creator: "author",
  au: "author",
  title: "title",
  ti: "title",
  year: "year",
  y: "year",
  tag: "tag",
  type: "type",
  itemtype: "type",
};

/** Lower case, without accents: "Müller" and "muller" match */
function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** "2017", "2017-2019", "2017-", "-2019" → the years accepted */
function yearRange(value: string): [number, number] | null {
  const m = /^(\d{4})?\s*(-)?\s*(\d{4})?$/.exec(value.trim());
  if (!m || (!m[1] && !m[3])) return null;
  const from = m[1] ? parseInt(m[1], 10) : 0;
  const to = m[3] ? parseInt(m[3], 10) : m[2] ? Infinity : from;
  return [from, to];
}

const TOKEN_RE = /(-?)([A-Za-z]+):(?:"([^"]*)"?|(\S*))|(-?"[^"]*"?)|(\S+)/g;

/** Reads a search such as `transformers author:"van der Berg" -tag:read type:book year:2020-` */
export function parseLibraryQuery(input: string): LibraryQuery {
  const words: string[] = [];
  const query: LibraryQuery = { q: "", tags: [], checks: [] };
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(input)) !== null) {
    const field = m[2] ? FIELDS[m[2].toLowerCase()] : undefined;
    const value = (m[3] ?? m[4] ?? "").trim();
    if (!field) {
      if (m[2]) words.push(m[0]);
      else words.push(m[5] ?? m[6]);
      continue;
    }
    if (!value) continue;
    const negated = m[1] === "-";
    const keep = (test: (item: ZoteroApiItem) => boolean) =>
      query.checks.push(negated ? (item) => !test(item) : test);
    switch (field) {
      case "tag":
        query.tags.push(negated ? `-${value}` : value);
        break;
      case "type":
        query.itemType = negated ? `-${value}` : value;
        break;
      case "author": {
        const name = fold(value);
        // First and last names are separate fields: words, not a phrase
        if (!negated) words.push(...value.split(/\s+/));
        keep((item) => creatorNames(item.data).some((n) => fold(n).includes(name)));
        break;
      }
      case "title": {
        const title = fold(value);
        if (!negated) words.push(value.includes(" ") ? `"${value}"` : value);
        keep((item) => fold((item.data.title as string) || "").includes(title));
        break;
      }
      case "year": {
        const range = yearRange(value);
        if (!range) break;
        if (!negated && range[0] === range[1]) words.push(String(range[0]));
        keep((item) => {
          const year = parseInt(itemSummary(item).year, 10);
          return year >= range[0] && year <= range[1];
        });
        break;
      }
    }
  }
  query.q = words.join(" ").trim();
  return query;
}

/** Whether a query asks for anything */
export function isEmptyQuery(query: LibraryQuery): boolean {
  return !query.q && query.tags.length === 0 && !query.itemType && query.checks.length === 0;
}

/** Text that cannot break a Markdown link label */
function labelSafe(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(/([\\[\]])/g, "\\$1");
}

/** Values a label template can use, e.g. `{title} ({citation})` */
export function templateValues(item: ZoteroApiItem): Record<string, string> {
  const summary = itemSummary(item);
  const authors = summary.creators;
  return {
    title: labelSafe(summary.title),
    authors: labelSafe(authors),
    year: summary.year,
    citation: labelSafe([authors, summary.year].filter(Boolean).join(", ")),
    key: item.key,
    citekey: (item.data.citationKey as string) || "",
    type: summary.itemType,
  };
}

/** The template with each `{name}` replaced (unknown names are kept as they are) */
export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (all, name: string) => values[name] ?? all);
}

/** The link labels of the settings: one template per line, blank lines ignored */
export function parseTemplates(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}
