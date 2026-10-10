/**
 * Fields of a Zotero item mirrored as list properties of its literature note,
 * both ways: `authors` (the item's authors, "First Last") and `keywords` (its
 * tags). The value last synced is kept, so that each side's changes can be
 * told apart: a property edited in Obsidian is sent to Zotero (authors only
 * once the user confirmed), a field changed in Zotero replaces the property.
 */
import { ZoteroApiItem } from "./zotero-client";

export interface ItemField {
  /** Frontmatter property */
  property: string;
  /** What the user calls it, in messages */
  label: string;
  /** Value in Zotero */
  read(item: ZoteroApiItem): string[];
  /** Data to PATCH so that the item has `values` */
  write(item: ZoteroApiItem, values: string[]): Record<string, unknown>;
  /** Order matters (otherwise a set) */
  ordered: boolean;
  /** Changes made in Obsidian are only sent once the user confirmed them */
  confirm: boolean;
}

type Creator = { creatorType?: string; firstName?: string; lastName?: string; name?: string };

function creators(item: ZoteroApiItem): Creator[] {
  return Array.isArray(item.data.creators) ? (item.data.creators as Creator[]) : [];
}

function displayName(c: Creator): string {
  return (c.name || [c.firstName, c.lastName].filter(Boolean).join(" ")).trim();
}

/** "Doe, Jane" or "Jane Doe" → two-field name; a single word ("OpenAI") stays one field */
function parseName(text: string): Creator {
  const comma = text.indexOf(",");
  if (comma > 0) return { creatorType: "author", lastName: text.slice(0, comma).trim(), firstName: text.slice(comma + 1).trim() };
  const words = text.split(/\s+/);
  if (words.length === 1) return { creatorType: "author", name: text };
  return { creatorType: "author", firstName: words.slice(0, -1).join(" "), lastName: words[words.length - 1] };
}

export const AUTHORS: ItemField = {
  property: "authors",
  label: "authors",
  read: (item) => creators(item).filter((c) => c.creatorType === "author").map(displayName).filter(Boolean),
  write: (item, names) => {
    const all = creators(item);
    // Authors kept from Zotero keep their fields (a last name of several words…)
    const known = new Map<string, Creator[]>();
    for (const c of all.filter((c) => c.creatorType === "author")) {
      known.set(displayName(c), [...(known.get(displayName(c)) ?? []), c]);
    }
    const authors = names.map((n) => known.get(n)?.shift() ?? parseName(n));
    return { creators: [...authors, ...all.filter((c) => c.creatorType !== "author")] };
  },
  ordered: true,
  confirm: true,
};

type Tag = { tag: string; type?: number };

function tags(item: ZoteroApiItem): Tag[] {
  return Array.isArray(item.data.tags) ? (item.data.tags as Tag[]) : [];
}

export const KEYWORDS: ItemField = {
  property: "keywords",
  label: "keywords",
  read: (item) => sortedUnique(tags(item).map((t) => t.tag)),
  write: (item, values) => {
    // Tags kept keep their type (automatic tags)
    const known = new Map(tags(item).map((t) => [t.tag, t]));
    return { tags: sortedUnique(values).map((v) => known.get(v) ?? { tag: v }) };
  },
  ordered: false,
  confirm: false,
};

export const ITEM_FIELDS = [AUTHORS, KEYWORDS];

function sortedUnique(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

/** A list property as written by the user (a single value counts as a list), null when absent */
export function readList(value: unknown): string[] | null {
  if (value === null || value === undefined) return null;
  const list = Array.isArray(value) ? value : [value];
  return list.map((v) => String(v ?? "").trim()).filter(Boolean);
}

/** Whether two values of a field are the same */
export function sameValue(field: ItemField, a: string[], b: string[]): boolean {
  const [x, y] = field.ordered ? [a, b] : [sortedUnique(a), sortedUnique(b)];
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** Three-way merge of sets: what either side added is in, what either side removed is out */
export function mergeSets(base: string[], local: string[], remote: string[]): string[] {
  const [b, l, r] = [new Set(base), new Set(local), new Set(remote)];
  return sortedUnique([...b, ...l, ...r].filter((v) => (b.has(v) ? l.has(v) && r.has(v) : l.has(v) || r.has(v))));
}

/** What a sync of one field does: the property's new value (null: unchanged) and the new synced value */
export interface FieldSync {
  property: string[] | null;
  base: string[];
}

/**
 * Zotero → vault: the new property value and synced value of a field, given
 * the property (`local`), the value last synced (`base`) and Zotero's
 * (`remote`). A property edited in Obsidian is kept (`push` sends it), merged
 * with Zotero's changes for sets; changed on both sides, an ordered field
 * waits for the user (on push).
 */
export function pullField(field: ItemField, local: string[] | null, base: string[] | undefined, remote: string[]): FieldSync {
  if (local === null || base === undefined || sameValue(field, local, base)) {
    return { property: local !== null && sameValue(field, local, remote) ? null : remote, base: remote };
  }
  if (sameValue(field, local, remote)) return { property: null, base: remote };
  if (sameValue(field, remote, base) || field.ordered) return { property: null, base };
  // Both changed (a set): merged, the merge goes to Zotero on the next push
  return { property: mergeSets(base, local, remote), base: remote };
}
