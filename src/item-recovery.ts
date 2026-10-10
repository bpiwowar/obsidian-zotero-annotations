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
  /** Its title, when Zotero still has it */
  title: string | null;
  /** Its DOI and year, when Zotero still has it */
  doi: string | null;
  year: string | null;
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

/** Words of a title, lowercased, for comparisons */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** The key as a dead item, or null when it is a live item of the library */
export async function deadItem(key: string): Promise<DeadItem | null> {
  try {
    const item = await fetchItem(key);
    if (!item.data.deleted || isChild(item)) return null;
    return { key, trashed: true, title: (item.data.title as string) || null, doi: doi(item), year: year(item) };
  } catch (e) {
    if (isNotFound(e)) return { key, trashed: false, title: null, doi: null, year: null };
    throw e;
  }
}

/**
 * The dead items among many keys. Live items are asked 50 at a time; the
 * batch leaves out items in the trash, so the keys it misses are asked one
 * by one.
 */
export async function deadItems(keys: string[]): Promise<DeadItem[]> {
  const live = new Set((await fetchItems(keys)).filter((i) => !i.data.deleted).map((i) => i.key));
  const dead: DeadItem[] = [];
  for (const key of keys) {
    if (live.has(key)) continue;
    const item = await deadItem(key);
    if (item) dead.push(item);
  }
  return dead;
}

/** What the links to an item say of it (`[text](zotero://select/…/KEY)`), as search queries: "(Doe, 2020, p. 3)" → "Doe 2020" */
export function linkTexts(lines: string[], key: string): string[] {
  const re = new RegExp(`\\[((?:[^\\]\\\\]|\\\\.)*)\\]\\(zotero://select/(?:library|groups/\\d+)/items/${key}(?![A-Z0-9])`, "g");
  const texts = new Set<string>();
  for (const line of lines) {
    for (const m of line.matchAll(re)) {
      const text = m[1]
        .replace(/\\(.)/g, "$1")
        .replace(/,?\s*pp?\.\s*[\w–-]+/g, "")
        .replace(/[()“”"«»]/g, " ")
        .replace(/[,;]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (text) texts.add(text);
    }
  }
  return [...texts];
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

/**
 * The live item that took the place of a dead one: the item it was merged
 * into, else (not certain) an item with the same title — `titleHint` when
 * Zotero no longer knows the dead item's title. Null when nothing fits.
 */
export async function findReplacement(dead: DeadItem, titleHint: string | null = null): Promise<Replacement | null> {
  const title = dead.title ?? titleHint;
  const replaces = (item: ZoteroApiItem) => extractRelatedKeys(item.data.relations, "dc:replaces").includes(dead.key);

  // Merged items keep their title: a search finds the item kept quickly
  const candidates = title ? (await searchItems(title)).filter((i) => i.key !== dead.key && !i.data.deleted) : [];
  const merged = candidates.find(replaces) ?? (await replacedBy()).get(dead.key);
  if (merged) return replacement(merged, true);

  if (!title) return null;
  const wanted = normalizeTitle(title);
  const same = candidates.filter((c) => normalizeTitle((c.data.title as string) || "") === wanted);
  // Several items with that title: the one with the same DOI, else the same year
  const best =
    same.find((c) => dead.doi && doi(c) === dead.doi) ??
    same.find((c) => dead.year && year(c) === dead.year) ??
    same[0];
  return best ? replacement(best, false) : null;
}
