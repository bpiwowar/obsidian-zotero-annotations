import { requestUrl } from "obsidian";

const ZOTERO_BASE = "http://localhost:23119/api/users/0";

async function zoteroFetch(url: string): Promise<unknown> {
  const res = await requestUrl({
    url,
    headers: {
      "Zotero-Allowed-Request": "true",
    },
  });
  return res.json;
}

export interface ZoteroAnnotation {
  key: string;
  type: "highlight" | "note" | "underline" | "image" | "ink" | "text";
  text: string;
  comment: string;
  color: string;
  pageLabel: string;
  tags: string[];
  /** The attachment key that contains this annotation */
  attachmentKey: string;
  /** Sort key: page number (parsed as int, fallback to 0) */
  sortPage: number;
  /** Position within the page (sortIndex field from Zotero) */
  sortIndex: string;
}

export interface ZoteroItemInfo {
  key: string;
  title: string;
  creators: string;
  date: string;
  itemType: string;
  abstractNote: string;
  notes: ZoteroNote[];
  /** Items linked through Zotero's "Related" field */
  related: ZoteroRelatedItem[];
}

export interface ZoteroNote {
  key: string;
  html: string;
}

export interface ZoteroRelatedItem {
  key: string;
  title: string;
  /** Short form, e.g. "Doe et al." */
  creators: string;
  /** 4-digit year, or "" if the date could not be parsed */
  year: string;
  itemType: string;
}

interface ZoteroApiItem {
  key: string;
  data: Record<string, unknown>;
}

type ZoteroCreator = { firstName?: string; lastName?: string; name?: string };

function creatorList(data: Record<string, unknown>): ZoteroCreator[] {
  return Array.isArray(data.creators) ? (data.creators as ZoteroCreator[]) : [];
}

function creatorName(c: ZoteroCreator): string {
  return c.name || [c.firstName, c.lastName].filter(Boolean).join(" ");
}

/** "Doe", "Doe & Roe", "Doe et al." */
function shortCreators(data: Record<string, unknown>): string {
  const names = creatorList(data)
    .map((c) => c.lastName || c.name || "")
    .filter(Boolean);
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} & ${names[1]}`;
  return `${names[0]} et al.`;
}

/**
 * Extract item keys from a Zotero `relations` object. Values of `dc:relation`
 * are URIs like `http://zotero.org/users/12345/items/ABCD1234` and may be a
 * single string rather than an array.
 */
function extractRelatedKeys(relations: unknown): string[] {
  if (!relations || typeof relations !== "object") return [];
  const raw = (relations as Record<string, unknown>)["dc:relation"];
  const uris = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  const keys: string[] = [];
  for (const uri of uris) {
    if (typeof uri !== "string") continue;
    const m = /\/items\/([A-Z0-9]+)\/?$/i.exec(uri);
    if (m) keys.push(m[1]);
  }
  return Array.from(new Set(keys));
}

/** Child item types that are never interesting as a "related paper" */
const NON_PAPER_TYPES = new Set(["attachment", "note", "annotation"]);

async function fetchRelatedItems(keys: string[]): Promise<ZoteroRelatedItem[]> {
  const results = await Promise.all(
    keys.map(async (key): Promise<ZoteroRelatedItem | null> => {
      try {
        const item = (await zoteroFetch(`${ZOTERO_BASE}/items/${key}`)) as ZoteroApiItem;
        const d = item.data;
        const itemType = (d.itemType as string) || "";
        if (NON_PAPER_TYPES.has(itemType)) return null;
        const date = (d.date as string) || "";
        const year = /\b(\d{4})\b/.exec(date)?.[1] || "";
        return {
          key: item.key,
          title: (d.title as string) || "(untitled)",
          creators: shortCreators(d),
          year,
          itemType,
        };
      } catch (e) {
        console.error(`Zotero Annotations: failed to fetch related item ${key}`, e);
        return null;
      }
    })
  );

  return results
    .filter((r): r is ZoteroRelatedItem => r !== null)
    .sort((a, b) => a.title.localeCompare(b.title));
}

/**
 * Fetch a single item's metadata by key.
 */
export async function fetchItemInfo(itemKey: string): Promise<ZoteroItemInfo | null> {
  try {
    const [item, children] = await Promise.all([
      zoteroFetch(`${ZOTERO_BASE}/items/${itemKey}`) as Promise<ZoteroApiItem>,
      zoteroFetch(`${ZOTERO_BASE}/items/${itemKey}/children`) as Promise<ZoteroApiItem[]>,
    ]);
    const d = item.data;
    const creators = creatorList(d).map(creatorName).join(", ");
    const notes: ZoteroNote[] = children
      .filter((c) => (c.data.itemType as string) === "note")
      .map((c) => ({ key: c.key, html: (c.data.note as string) || "" }));
    const related = await fetchRelatedItems(extractRelatedKeys(d.relations));
    return {
      key: item.key,
      title: (d.title as string) || "(untitled)",
      creators,
      date: (d.date as string) || "",
      itemType: (d.itemType as string) || "",
      abstractNote: (d.abstractNote as string) || "",
      notes,
      related,
    };
  } catch (e) {
    console.error("Zotero Annotations: failed to fetch item info", e);
    return null;
  }
}

/**
 * Given a top-level item key, find all PDF attachments, then collect
 * all annotation child items from those attachments.
 */
export async function fetchAnnotations(itemKey: string): Promise<ZoteroAnnotation[]> {
  // Step 1: get children of the top-level item → find PDF attachments
  const children = await zoteroFetch(`${ZOTERO_BASE}/items/${itemKey}/children`) as ZoteroApiItem[];

  const pdfAttachments = children.filter(
    (c) =>
      (c.data.itemType as string) === "attachment" &&
      (c.data.contentType as string) === "application/pdf"
  );

  if (pdfAttachments.length === 0) {
    return [];
  }

  // Step 2: for each PDF attachment, fetch annotation children
  const allAnnotations: ZoteroAnnotation[] = [];

  for (const pdf of pdfAttachments) {
    try {
      const annotItems = await zoteroFetch(
        `${ZOTERO_BASE}/items/${pdf.key}/children?itemType=annotation`
      ) as ZoteroApiItem[];

      for (const a of annotItems) {

        const pageLabel = (a.data.annotationPageLabel as string) || "";
        const pageNum = parseInt(pageLabel, 10);

        allAnnotations.push({
          key: a.key,
          type: (a.data.annotationType as ZoteroAnnotation["type"]) || "highlight",
          text: (a.data.annotationText as string) || "",
          comment: (a.data.annotationComment as string) || "",
          color: (a.data.annotationColor as string) || "#ffd400",
          pageLabel,
          tags: Array.isArray(a.data.tags)
            ? (a.data.tags as Array<{ tag: string }>).map((t) => t.tag)
            : [],
          attachmentKey: pdf.key,
          sortPage: isNaN(pageNum) ? 0 : pageNum,
          sortIndex: (a.data.annotationSortIndex as string) || "0",
        });
      }
    } catch (e) {
      console.error(`Zotero Annotations: failed to fetch annotations for attachment ${pdf.key}`, e);
    }
  }

  // Sort by page, then by sortIndex within page
  allAnnotations.sort((a, b) => {
    if (a.sortPage !== b.sortPage) return a.sortPage - b.sortPage;
    return a.sortIndex.localeCompare(b.sortIndex);
  });

  return allAnnotations;
}

/**
 * Check whether the Zotero local server is reachable.
 */
export async function isZoteroRunning(): Promise<boolean> {
  try {
    await zoteroFetch("http://localhost:23119/api/users/0/items?limit=1");
    return true;
  } catch {
    return false;
  }
}
