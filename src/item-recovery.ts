/**
 * The item a dead `zotero://` link should point to. Zotero merges duplicates
 * by moving all but one to the trash, and the item kept lists the others in
 * its `dc:replaces` relation: a replacement found that way is certain. Once
 * that record is gone (or for an item deleted by hand), an item with the
 * same title is only a guess, to be confirmed by the user.
 */
import { ZoteroApiItem, extractRelatedKeys, fetchItem, fetchItems, isNotFound, scanTopItems, searchItems } from "./zotero-client";

/** An item key that no longer names a live item of the library */
export interface DeadItem {
  key: string;
  /** Still in Zotero's trash (otherwise deleted for good, or never in this library) */
  trashed: boolean;
  /** What is known of it: from Zotero's trash, else from its literature note (see {@link withMetadata}) */
  title: string | null;
  doi: string | null;
  year: string | null;
  /** Authors, "First Last" */
  authors: string[];
  /** Vault path of its literature note, if any */
  note: string | null;
}

/** Zotero item keys */
const VALID_KEY = /^[A-Z0-9]{8}$/;

function missing(key: string): DeadItem {
  return { key, trashed: false, title: null, doi: null, year: null, authors: [], note: null };
}

/** What a literature note knows of its paper */
export interface ItemMetadata {
  title: string | null;
  authors: string[];
  year: string | null;
  path: string;
}

export interface Replacement {
  key: string;
  title: string;
  /** Found through Zotero's record of the merge (otherwise by title) */
  certain: boolean;
}

/** How long the merge record of the whole library (one scan of every item) is reused */
const MERGE_RECORD_MS = 5 * 60_000;

let mergeRecord: { at: number; replacedBy: Map<string, ZoteroApiItem> } | null = null;

/** Lookups of dead items and of their replacements, reused as long as the merge record */
const lookups = new Map<string, { at: number; value: Promise<unknown> }>();

/** `compute()`, or its result for `id` when asked within {@link MERGE_RECORD_MS} (failures are not kept) */
function memo<T>(id: string, compute: () => Promise<T>): Promise<T> {
  const hit = lookups.get(id);
  if (hit && Date.now() - hit.at < MERGE_RECORD_MS) return hit.value as Promise<T>;
  const value = compute();
  lookups.set(id, { at: Date.now(), value });
  value.catch(() => lookups.delete(id));
  return value;
}

function year(item: ZoteroApiItem): string | null {
  return /\b(\d{4})\b/.exec((item.data.date as string) || "")?.[1] ?? null;
}

function doi(item: ZoteroApiItem): string | null {
  const value = (item.data.DOI as string) || /\bDOI:\s*(\S+)/i.exec((item.data.extra as string) || "")?.[1] || "";
  return value ? value.toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, "") : null;
}

/** Attachments, notes and annotations: links to them (open-pdf) are not repaired */
function isChild(item: ZoteroApiItem): boolean {
  return ["attachment", "note", "annotation"].includes(item.data.itemType as string);
}

type Creator = { creatorType?: string; firstName?: string; lastName?: string; name?: string };

function creators(item: ZoteroApiItem): Creator[] {
  return Array.isArray(item.data.creators) ? (item.data.creators as Creator[]) : [];
}

function authorNames(item: ZoteroApiItem): string[] {
  return creators(item)
    .filter((c) => c.creatorType === "author")
    .map((c) => (c.name || [c.firstName, c.lastName].filter(Boolean).join(" ")).trim())
    .filter(Boolean);
}

/** "Jane van Doe" → "doe" (the word compared between authors) */
function lastWord(name: string): string {
  return (name.includes(",") ? name.split(",")[0] : name).trim().split(/\s+/).pop()?.toLowerCase() ?? "";
}

/** Words of a title, lowercased, for comparisons */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** The key as a dead item, or null when it is a live item of the library */
export function deadItem(key: string): Promise<DeadItem | null> {
  // A malformed key (not 8 characters: a link edited by hand) names nothing
  if (!VALID_KEY.test(key)) return Promise.resolve(missing(key));
  return memo(`dead:${key}`, () => lookDeadItem(key));
}

async function lookDeadItem(key: string): Promise<DeadItem | null> {
  try {
    const item = await fetchItem(key);
    if (!item.data.deleted || isChild(item)) return null;
    const title = (item.data.title as string) || null;
    return { key, trashed: true, title, doi: doi(item), year: year(item), authors: authorNames(item), note: null };
  } catch (e) {
    if (isNotFound(e)) return missing(key);
    throw e;
  }
}

/**
 * The dead items among many keys. Live items are asked 50 at a time; the
 * batch leaves out items in the trash, so the keys it misses are asked one
 * by one.
 */
export async function deadItems(keys: string[]): Promise<DeadItem[]> {
  // A malformed key in the batch makes Zotero answer with other items
  const live = new Set((await fetchItems(keys.filter((k) => VALID_KEY.test(k)))).filter((i) => !i.data.deleted).map((i) => i.key));
  const dead: DeadItem[] = [];
  for (const key of keys) {
    if (live.has(key)) continue;
    const item = await deadItem(key);
    if (item) dead.push(item);
  }
  return dead;
}

/** A dead item completed with what its literature note knows (Zotero's trash comes first) */
export function withMetadata(dead: DeadItem, meta: ItemMetadata | null): DeadItem {
  if (!meta) return dead;
  return {
    ...dead,
    title: dead.title ?? meta.title,
    year: dead.year ?? meta.year,
    authors: dead.authors.length > 0 ? dead.authors : meta.authors,
    note: meta.path,
  };
}

/** Library searches that may find what replaced a dead item: its title, first author and year, its links' texts */
export function searchQueries(dead: DeadItem, texts: LinkTexts = { titles: [], citations: [] }): string[] {
  const first = dead.authors[0];
  const byAuthor = first ? [first.includes(",") ? first.split(",")[0].trim() : first.split(/\s+/).pop(), dead.year] : [];
  const author = byAuthor.filter(Boolean).join(" ");
  const all = [dead.title, author, ...texts.titles, ...texts.citations];
  return [...new Set(all.filter((q): q is string => !!q && !!q.trim()))];
}

/** What the links to an item say of it: titles and citations ("(Doe et al., 2020, p. 3)" → "Doe 2020") */
export interface LinkTexts {
  titles: string[];
  citations: string[];
}

/** "Doe et al., 2020, p. 3" → "Doe 2020" (words a quick search finds) */
function citationQuery(text: string): string {
  return text
    .replace(/,?\s*pp?\.\s*[\w–-]+/g, "")
    .replace(/\bet al\.?|&|\band\b/g, " ")
    .replace(/[,;()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The texts of the links to an item (`[text](zotero://select/…/KEY)`) in some lines of notes */
export function linkTexts(lines: string[], key: string): LinkTexts {
  const re = new RegExp(
    `\\[((?:[^\\]\\\\]|\\\\.)*)\\]\\(zotero://select/(?:library|groups/\\d+)/items/${key}(?![A-Z0-9])`,
    "gi"
  );
  const titles = new Set<string>();
  const citations = new Set<string>();
  for (const line of lines) {
    for (const m of line.matchAll(re)) {
      let text = m[1].replace(/\\(.)/g, "$1").replace(/[“”"«»]/g, " ").trim();
      // "Title (Doe et al., 2020)": the citation apart
      const cite = /\(([^()]*\d{4}[^()]*)\)\s*$/.exec(text);
      if (cite) {
        citations.add(citationQuery(cite[1]));
        text = text.slice(0, cite.index).trim();
      } else if (/^\(.*\)$/.test(text)) {
        citations.add(citationQuery(text));
        text = "";
      }
      text = text.replace(/\s+/g, " ").trim();
      if (text) titles.add(text);
    }
  }
  citations.delete("");
  return { titles: [...titles], citations: [...citations] };
}

/** Old key → item that replaced it, over the whole library (one scan, kept a few minutes) */
async function replacedBy(): Promise<Map<string, ZoteroApiItem>> {
  if (mergeRecord && Date.now() - mergeRecord.at < MERGE_RECORD_MS) return mergeRecord.replacedBy;
  const map = new Map<string, ZoteroApiItem>();
  await scanTopItems((item) => {
    for (const old of extractRelatedKeys(item.data.relations, "dc:replaces")) map.set(old, item);
    return false;
  });
  mergeRecord = { at: Date.now(), replacedBy: map };
  return map;
}

function replacement(item: ZoteroApiItem, certain: boolean): Replacement {
  return { key: item.key, title: (item.data.title as string) || "(untitled)", certain };
}

/** Below this, an item is not proposed (similarity of titles, see {@link resemblance}) */
const MIN_RESEMBLANCE = 0.6;

/** How much an item looks like a dead one: words shared by the titles (0–1), with a bonus for DOI, year, first author */
function resemblance(dead: DeadItem, item: ZoteroApiItem): number {
  const words = (t: string) => new Set(normalizeTitle(t).split(" ").filter(Boolean));
  const a = words(dead.title ?? "");
  const b = words((item.data.title as string) || "");
  const shared = [...a].filter((w) => b.has(w)).length;
  let score = a.size + b.size > 0 ? shared / (a.size + b.size - shared) : 0;
  if (dead.doi && doi(item) === dead.doi) score += 0.3;
  if (dead.year && year(item) === dead.year) score += 0.1;
  const first = dead.authors[0];
  if (first && authorNames(item).some((n) => lastWord(n) === lastWord(first))) score += 0.1;
  return score;
}

/**
 * The live item that took the place of a dead one: the item it was merged
 * into, else (not certain) the item most like it (title, DOI, year, first
 * author: from Zotero's trash or the literature note). Null when nothing fits.
 */
export function findReplacement(dead: DeadItem): Promise<Replacement | null> {
  return memo(`replacement:${dead.key}:${dead.title ?? ""}:${dead.authors[0] ?? ""}`, () => lookReplacement(dead));
}

async function lookReplacement(dead: DeadItem): Promise<Replacement | null> {
  const replaces = (item: ZoteroApiItem) => extractRelatedKeys(item.data.relations, "dc:replaces").includes(dead.key);
  const live = (items: ZoteroApiItem[]) => items.filter((i) => i.key !== dead.key && !i.data.deleted);

  // Merged items keep their title: a search finds the item kept quickly
  const candidates = dead.title ? live(await searchItems(dead.title)) : [];
  const merged = candidates.find(replaces) ?? (await replacedBy()).get(dead.key);
  if (merged) return replacement(merged, true);
  if (!dead.title) return null;

  // A title changed a little (preprint, published version): the first author's items of that year
  const [, byAuthor] = searchQueries(dead);
  if (byAuthor && byAuthor !== dead.title) {
    const seen = new Set(candidates.map((c) => c.key));
    candidates.push(...live(await searchItems(byAuthor)).filter((c) => !seen.has(c.key)));
  }
  let best: ZoteroApiItem | null = null;
  let bestScore = MIN_RESEMBLANCE;
  for (const c of candidates) {
    const score = resemblance(dead, c);
    if (score >= bestScore) [best, bestScore] = [c, score];
  }
  return best ? replacement(best, false) : null;
}
